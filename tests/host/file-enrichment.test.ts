import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ToolViewsRuntime } from "../../src/host/runtime.ts";
import { FileObservations, observationLimits } from "../../src/host/file-observations.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import type { RenderContext } from "../../src/display/row.ts";

const theme = { fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text, bold: (text: string) => text } as Theme;

for (const kind of ["direct", "nested", "error", "incomplete-parent"] as const) test(`${kind} patch observations follow committed source admission`, async () => {
  const nested = kind === "nested" || kind === "incomplete-parent";
  const incomplete = kind === "incomplete-parent";
  const failed = kind === "error";
  const root = await mkdtemp(join(tmpdir(), "tool-views-enrichment-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const manager = SessionManager.inMemory(root);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let resolver: ToolRendererResolver | undefined;
  const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); return () => {}; },
    registerCommand() {}, registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as unknown as ExtensionAPI;
  const observations = new FileObservations({ ...observationLimits, phaseMs: 5000 });
  let release: () => void = () => {};
  const released = new Promise<void>(done => { release = done; });
  const discard = observations.discard.bind(observations);
  observations.discard = key => { discard(key); release(); };
  const runtime = new ToolViewsRuntime(api, { compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }, observations);
  const ctx = { cwd: root, hasUI: false, ui: {}, sessionManager: manager } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    runtime.install();
    await emit("session_start", {});
    const checkpoint = manager.appendMessage({ role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "arbitrary_patch_provider", description: "Patch files.",
      parameters: { type: "object", required: ["input"], properties: { input: { type: "string", description: "Patch text" } } } },
      { name: "parent_fixture", description: "Execute JavaScript code.", parameters: { type: "object", required: ["code"], properties: { code: { type: "string", description: "JavaScript source" } } } }] });
    const args = { input: "*** Begin Patch\n*** Update File: file.ts\n@@\n-old\n+new\n*** End Patch" };
    const call = { type: "toolCall" as const, id: "patch", name: "arbitrary_patch_provider", arguments: args };
    const parent = { type: "toolCall" as const, id: "parent", name: "parent_fixture", arguments: { code: "await tools.patch();" } };
    const parentToolCallId = nested ? parent.id : undefined;
    const message: AssistantMessage = { role: "assistant", content: [nested ? parent : call], api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    await writeFile(join(root, "file.ts"), "OBSERVED_LEAD\nold\nOBSERVED_TAIL\n");
    await emit("message_start", { message });
    manager.appendMessage(message);
    await emit("message_end", { message });
    if (nested) await emit("tool_execution_start", { toolCallId: parent.id, toolName: parent.name, args: parent.arguments });
    await emit("tool_execution_start", { toolCallId: "patch", toolName: call.name, args, parentToolCallId });
    const renderer = resolver!(call.name, () => undefined)!;
    let ready: () => void = () => {};
    const complete = new Promise<void>((done, reject) => { ready = done; deadline = setTimeout(() => reject(new Error("No enriched view was published")), 5000); });
    const context: RenderContext = { args, cwd: root, state: {}, toolCallId: "patch", argsComplete: true, executionStarted: true,
      isPartial: true, isError: false, durationMs: undefined, expanded: true, showImages: true, outputPad: 1, lastComponent: undefined,
      invalidate() { if (paint().includes("OBSERVED_LEAD")) ready(); } };
    const callComponent = renderer.renderCall!(args, theme, context);
    let resultComponent: ReturnType<NonNullable<typeof renderer.renderResult>> | undefined;
    function paint(): string { return [...callComponent.render(110), ...(resultComponent?.render(110) ?? [])].map(stripTerminalSequences).join("\n"); }
    assert.ok(!paint().includes("OBSERVED_LEAD"));
    await emit("tool_call", { toolCallId: "patch", toolName: call.name, input: args, parentToolCallId });
    await writeFile(join(root, "file.ts"), "OBSERVED_LEAD\nnew\nOBSERVED_TAIL\n");
    const outcome = { content: [{ type: "text" as const, text: "producer receipt" }], details: undefined };
    await emit("tool_result", { toolCallId: "patch", toolName: call.name, input: args, ...outcome, isError: failed, parentToolCallId });
    await emit("tool_execution_end", { toolCallId: "patch", toolName: call.name, isError: failed, parentToolCallId });
    context.isPartial = false;
    context.isError = failed;
    resultComponent = renderer.renderResult!(outcome, { expanded: true, isPartial: false }, theme, context);
    manager.appendMessage(nested ? { role: "toolResult", toolCallId: parent.id, toolName: parent.name, content: [{ type: "text", text: "parent receipt" }], isError: false, timestamp: 3,
      nestedCalls: { complete: !incomplete, calls: incomplete ? [] : [{ id: "patch", name: call.name, arguments: args, status: "ok" }] } }
      : { role: "toolResult", toolCallId: "patch", toolName: call.name, content: outcome.content, isError: failed, timestamp: 3 });
    await emit("turn_end", {});
    assert.ok(!paint().includes("OBSERVED_LEAD"));
    if (incomplete) {
      await Promise.race([released, complete]);
      assert.deepEqual([...observations.keys()], []);
      assert.ok(!paint().includes("OBSERVED_LEAD"));
      return;
    }
    await complete;
    const rendered = paint();
    assert.match(rendered, /2\s+- old/);
    assert.match(rendered, /2\s+\+ new/);
    assert.ok(rendered.includes("OBSERVED_TAIL"));
    assert.equal(outcome.content[0]!.text, "producer receipt");
    assert.equal(context.isError, failed);
    assert.equal(manager.getBranch().filter(entry => entry.type === "message" && JSON.stringify(entry.message).includes("OBSERVED_LEAD")).length, 0);
    await writeFile(join(root, "file.ts"), "LATER_FILE_STATE\n");
    assert.ok(paint().includes("OBSERVED_LEAD"));
    assert.equal(await readFile(join(root, "file.ts"), "utf8"), "LATER_FILE_STATE\n");
    manager.branch(checkpoint);
    await emit("session_tree", {});
    assert.ok(!paint().includes("OBSERVED_LEAD"));
  } finally {
    if (deadline) clearTimeout(deadline);
    runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
