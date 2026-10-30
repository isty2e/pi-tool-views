import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { ToolViewsRuntime } from "../../src/host/runtime.ts";
import type { RenderContext } from "../../src/display/row.ts";

const theme = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value, bold: (value: string) => value } as Theme;
function assistant(call: ToolCall): AssistantMessage {
  return { role: "assistant", content: [call], api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("a separately delivered result invalidates the call once, not on every copied IPC payload", () => {
  let resolver: ToolRendererResolver | undefined;
  const api = { on: () => () => {}, registerCommand() {}, registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as unknown as ExtensionAPI;
  const runtime = new ToolViewsRuntime(api, {
    compile: () => ({ request: () => ({ kind: "uninterpreted" }), result: () => ({ parts: [{ kind: "original-content" }] }) }),
    compare: (_request, result) => ({ units: [], applicationReports: [], context: result?.parts.filter(part => part.kind !== "diff") ?? [] }),
    renderDiff: () => [],
  });
  runtime.install();
  let invalidations = 0;
  const context: RenderContext = { args: {}, state: {}, toolCallId: "copied", cwd: "/fixture", argsComplete: false,
    executionStarted: false, isPartial: false, isError: false, durationMs: 0, expanded: false, showImages: true,
    outputPad: 1, lastComponent: undefined, invalidate: () => { invalidations++; } };
  const renderer = resolver!("opaque", () => undefined)!;
  try {
    const call = renderer.renderCall!({}, theme, context);
    assert.ok(call.render(80).some(line => line.includes("Preparing")));
    renderer.renderResult!({ content: [{ type: "text", text: "result" }], details: undefined }, { expanded: false, isPartial: false }, theme, context);
    assert.equal(invalidations, 1);
    assert.ok(call.render(80).some(line => line.includes("Called opaque")));
    for (let index = 0; index < 3; index++) {
      renderer.renderResult!({ content: [{ type: "text", text: "result" }], details: undefined }, { expanded: false, isPartial: false }, theme, context);
    }
    assert.equal(invalidations, 1);
  } finally { runtime.dispose(); }
});

test("committed replacements and branch rebuilds refresh live components rather than retiring their paint", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const manager = SessionManager.inMemory(root);
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const api = {
    on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    registerToolRenderer(value: ToolRendererResolver) { resolver = value; },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const context = { cwd: root, hasUI: false, ui: {}, sessionManager: manager } as unknown as ExtensionContext;
  const runtime = new ToolViewsRuntime(api, {
    compile: () => ({ request: () => ({ kind: "uninterpreted" }), result: () => ({ parts: [{ kind: "original-content" }] }) }),
    compare: (_request, result) => ({ units: [], applicationReports: [], context: result?.parts.filter(part => part.kind !== "diff") ?? [] }),
    renderDiff: () => [],
  });
  runtime.install();
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, context);
  const makeHost = (args: ToolCall["arguments"]) => {
    const renderer = resolver!("echo", () => undefined)!;
    let current: RenderContext = { args, state: {}, toolCallId: "same", cwd: root, argsComplete: false, executionStarted: false,
      isPartial: true, isError: false, durationMs: undefined, expanded: false, showImages: true, outputPad: 1, lastComponent: undefined, invalidate: () => refresh() };
    let call: Component;
    let result: Component | undefined;
    let active = true;
    let supplied: { content: { type: "text"; text: string }[]; details: undefined } | undefined;
    function refresh() {
      if (!active) return;
      call = renderer.renderCall!(args, theme, current);
      if (supplied) result = renderer.renderResult!(supplied, { expanded: false, isPartial: false }, theme, current);
    }
    refresh();
    return {
      call: () => call!, result: () => result,
      finish() { current = { ...current, executionStarted: true, argsComplete: true, isPartial: false }; supplied = { content: [{ type: "text", text: "EARLY" }], details: undefined }; refresh(); },
      remove() { active = false; },
    };
  };
  try {
    emit("session_start", {});
    const declaration = manager.appendMessage({ role: "system", content: "", timestamp: 1,
      toolsAdded: [{ name: "echo", description: "Opaque echo operation.", parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } } }] });
    const raw: ToolCall = { type: "toolCall", id: "same", name: "echo", arguments: { value: "RAW" } };
    emit("message_start", { message: assistant(raw) });
    const host = makeHost(raw.arguments);
    assert.ok(host.call().render(80).join("\n").includes("RAW"));
    const safe = { ...raw, arguments: { value: "SAFE" } };
    manager.appendMessage(assistant(safe));
    emit("message_end", { message: assistant(raw) });
    emit("tool_execution_start", { toolCallId: "same", toolName: "echo" });
    assert.ok(host.call().render(80).join("\n").includes("SAFE"));
    host.finish();
    manager.appendMessage({ role: "toolResult", toolCallId: "same", toolName: "echo", content: [{ type: "text", text: "FINAL" }], isError: false, timestamp: 2 });
    emit("agent_end", {});
    assert.ok(host.result()?.render(80).join("\n").includes("FINAL"));

    host.remove();
    manager.branch(declaration);
    const branchCall = { ...raw, arguments: { value: "NEW_BRANCH" } };
    manager.appendMessage(assistant(branchCall));
    const reconstructed = makeHost(branchCall.arguments);
    emit("session_tree", {});
    const painted = reconstructed.call().render(80).join("\n");
    assert.ok(painted.includes("NEW_BRANCH"));
    assert.ok(!painted.includes("SAFE"));
    assert.deepEqual(raw.arguments, { value: "RAW" });
  } finally {
    runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
