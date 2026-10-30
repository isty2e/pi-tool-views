import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ToolViewsRuntime } from "../../src/host/runtime.ts";
import type { RenderContext } from "../../src/display/row.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";

const theme = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value, bold: (value: string) => value } as Theme;
function assistant(call: ToolCall): AssistantMessage {
  return { role: "assistant", content: [call], api: "anthropic-messages", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("native child callbacks use the parent declaration and retain the current result", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-nested-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const manager = SessionManager.inMemory(root);
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const api = { on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerToolRenderer(value: ToolRendererResolver) { resolver = value; }, registerCommand() {} } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: manager } as unknown as ExtensionContext;
  const runtime = new ToolViewsRuntime(api, { compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff });
  runtime.install();
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
  try {
    emit("session_start", {});
    manager.appendMessage({ role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "read", description: "Read the contents of a file.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Path to the file to read" } } } }] });
    const rootCall: ToolCall = { type: "toolCall", id: "parent", name: "codemode", arguments: { code: "read" } };
    emit("message_start", { message: assistant(rootCall) });
    manager.appendMessage(assistant(rootCall));
    emit("message_end", { message: assistant(rootCall) });
    emit("tool_execution_start", { toolCallId: "parent", toolName: "codemode" });
    emit("tool_execution_start", { parentToolCallId: "parent", toolCallId: "wrong-child", toolName: "read", args: { path: "wrong.ts" } });
    const wrongArgs = { path: "wrong.ts" };
    const wrongContext: RenderContext = { args: wrongArgs, state: {}, toolCallId: "wrong-child", cwd: root, argsComplete: false,
      executionStarted: false, isPartial: false, isError: false, durationMs: undefined, expanded: true, showImages: true, outputPad: 1, lastComponent: undefined, invalidate() {} };
    const wrongRenderer = resolver!("read", () => undefined)!;
    wrongRenderer.renderCall!(wrongArgs, theme, wrongContext);
    const wrongResult = wrongRenderer.renderResult!({ content: [{ type: "text", text: "WRONG_MARKER" }], details: undefined },
      { expanded: true, isPartial: false }, theme, wrongContext);
    assert.ok(wrongResult.render(100).map(stripTerminalSequences).join("\n").includes("WRONG_MARKER"));
    emit("tool_execution_end", { parentToolCallId: "parent", toolCallId: "wrong-child", toolName: "other", isError: false, result: {} });
    assert.ok(!wrongResult.render(100).map(stripTerminalSequences).join("\n").includes("WRONG_MARKER"));
    emit("tool_execution_start", { parentToolCallId: "parent", toolCallId: "actual-child", toolName: "read", args: { path: "src/a.ts" } });

    const args = { path: "src/a.ts" }, state = {};
    let reenter = false, reentries = 0;
    const context: RenderContext = { args, state, toolCallId: "actual-child", cwd: root, argsComplete: false, executionStarted: false,
      isPartial: false, isError: false, durationMs: 1, expanded: true, showImages: true, outputPad: 1, lastComponent: undefined,
      invalidate() {
        if (!reenter) return;
        if (++reentries > 2) throw new Error("recursive renderer invalidation");
        renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context);
      } };
    const renderer = resolver!("read", () => undefined)!;
    const call = renderer.renderCall!(args, theme, context);
    const supplied = { content: [{ type: "text" as const, text: "const actual = 1;" }], details: undefined };
    const result = renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context);
    assert.ok(!call.render(100).map(stripTerminalSequences).join("\n").includes("Read src/a.ts"));
    emit("tool_execution_update", { parentToolCallId: "parent", toolCallId: "actual-child", toolName: "read", args,
      partialResult: { content: [{ type: "text", text: "new partial" }] } });
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("const actual = 1;"));
    renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context);
    emit("tool_execution_end", { parentToolCallId: "parent", toolCallId: "actual-child", toolName: "read", isError: false, result: supplied });
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("const actual = 1;"));
    renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context);
    assert.ok(call.render(100).map(stripTerminalSequences).join("\n").includes("Read src/a.ts"));
    assert.ok(result.render(100).map(stripTerminalSequences).join("\n").includes("1 const actual = 1;"));

    const parentResult = manager.appendMessage({ role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 2,
      content: [{ type: "text", text: "parent result, not child result" }], nestedCalls: { complete: false, calls: [] } });
    emit("turn_end", {});
    const visible = result.render(100).map(stripTerminalSequences).join("\n");
    assert.ok(visible.includes("const actual = 1;"));
    assert.ok(!visible.includes("parent result, not child result"));
    const entry = manager.getEntry(parentResult);
    assert.ok(entry?.type === "message");
    entry.message = { role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 2,
      content: [{ type: "text", text: "parent result" }], nestedCalls: { complete: true,
        calls: [{ id: "actual-child", name: "read", arguments: { path: "src/a.ts" }, status: "ok" }] } };
    emit("message_end", { message: entry.message });
    emit("turn_end", {});
    renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context);
    assert.ok(call.render(100).map(stripTerminalSequences).join("\n").includes("Read src/a.ts"));
    entry.message = { role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 3,
      content: [{ type: "text", text: "replaced" }], nestedCalls: { complete: true,
        calls: [{ id: "actual-child", name: "read", arguments: { path: "src/a.ts" }, status: "ok" }] } };
    emit("message_end", { message: entry.message });
    reenter = true;
    assert.doesNotThrow(() => renderer.renderResult!(supplied, { expanded: true, isPartial: false }, theme, context));
    reenter = false;
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("const actual = 1;"));
    emit("turn_end", {});
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("const actual = 1;"));
    renderer.renderResult!({ content: [{ type: "text", text: "const refreshed = 2;" }], details: undefined }, { expanded: true, isPartial: false }, theme, context);
    assert.ok(result.render(100).map(stripTerminalSequences).join("\n").includes("const refreshed = 2;"));
    entry.message = { role: "toolResult", toolCallId: "parent", toolName: "codemode", isError: false, timestamp: 3,
      content: [{ type: "text", text: "redacted" }] };
    emit("message_end", { message: entry.message });
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("const actual = 1;"));
  } finally {
    runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("unavailable session evidence withdraws an already bound child", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-nested-unavailable-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const manager = SessionManager.inMemory(root);
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const api = { on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerToolRenderer(value: ToolRendererResolver) { resolver = value; }, registerCommand() {} } as unknown as ExtensionAPI;
  let ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: manager } as unknown as ExtensionContext;
  const runtime = new ToolViewsRuntime(api, { compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff });
  runtime.install();
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
  try {
    emit("session_start", {});
    manager.appendMessage({ role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "read", description: "Read the contents of a file.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Path to the file to read" } } } }] });
    const rootCall: ToolCall = { type: "toolCall", id: "parent", name: "codemode", arguments: { code: "read" } };
    emit("message_start", { message: assistant(rootCall) }); manager.appendMessage(assistant(rootCall));
    emit("tool_execution_start", { toolCallId: "parent", toolName: "codemode" });
    emit("tool_execution_start", { parentToolCallId: "parent", toolCallId: "child", toolName: "read", args: { path: "secret.ts" } });
    emit("tool_execution_end", { parentToolCallId: "parent", toolCallId: "child", toolName: "read", isError: false, result: {} });
    const args = { path: "secret.ts" };
    const context: RenderContext = { args, state: {}, toolCallId: "child", cwd: root, argsComplete: false, executionStarted: false,
      isPartial: false, isError: false, durationMs: 1, expanded: true, showImages: true, outputPad: 1, lastComponent: undefined, invalidate() {} };
    const renderer = resolver!("read", () => undefined)!;
    renderer.renderCall!(args, theme, context);
    const result = renderer.renderResult!({ content: [{ type: "text", text: "PRIVATE_MARKER" }], details: undefined }, { expanded: true, isPartial: false }, theme, context);
    assert.ok(result.render(100).map(stripTerminalSequences).join("\n").includes("PRIVATE_MARKER"));
    ctx = { ...ctx, sessionManager: { getSessionId: () => undefined } } as unknown as ExtensionContext;
    emit("session_tree", {});
    assert.ok(!result.render(100).map(stripTerminalSequences).join("\n").includes("PRIVATE_MARKER"));
  } finally {
    runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
