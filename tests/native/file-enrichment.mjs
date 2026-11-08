import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ToolViewsRuntime } from "../../src/host/runtime.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import { renderToolDiff } from "../../src/display/diff.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export default function fixture(pi) {
  if (process.env.TOOL_VIEWS_NATIVE_FIXTURE !== "1") throw new Error("Run this fixture only in an isolated workspace with TOOL_VIEWS_NATIVE_FIXTURE=1");
  let resolver;
  const instrumented = new Proxy(pi, { get(target, key) {
    if (key === "registerToolRenderer") return value => { resolver = value; return target.registerToolRenderer(value); };
    return target[key];
  } });
  const runtime = new ToolViewsRuntime(instrumented, { compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff });
  runtime.install();
  const views = new Map();
  const events = [];
  let theme;
  let root;
  let sent = false;
  let modelRequests = 0;
  let ready;
  const observed = new Promise(done => { ready = done; });
  const paint = view => [...view.call.render(110), ...(view.result?.render(110) ?? [])].map(stripTerminalSequences).join("\n");
  pi.registerTool({ name: "arbitrary_patch_fixture", label: "Patch fixture", description: "Patch files.",
    parameters: { type: "object", required: ["input"], properties: { input: { type: "string", description: "Patch text" } } },
    async execute(id) {
      events.push({ stage: "execute", id });
      await writeFile(join(root, `${id}.ts`), "NATIVE_LEAD\nnew\nNATIVE_TAIL\n");
      return { content: [{ type: "text", text: "native producer receipt" }] };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    root = ctx.cwd;
    initTheme("dark", false);
    new ToolExecutionComponent("theme", "theme", {}, {}, { renderShell: "self", renderCall(_args, value) {
      theme = value; return { render: () => [], invalidate() {} };
    } }, { requestRender() {} }, root);
    for (const name of ["normal", "blocked"]) await writeFile(join(root, `${name}.ts`), "NATIVE_LEAD\nold\nNATIVE_TAIL\n", { flag: "wx" });
    pi.setActiveTools(["arbitrary_patch_fixture"]);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    const renderer = resolver(event.toolName, () => undefined);
    const context = { args: event.args, cwd: ctx.cwd, state: {}, toolCallId: event.toolCallId, argsComplete: true, executionStarted: true,
      isPartial: true, isError: false, durationMs: undefined, expanded: true, showImages: true, outputPad: 1, lastComponent: undefined,
      invalidate() {
        const view = views.get(event.toolCallId);
        if (view && paint(view).includes("NATIVE_LEAD")) { events.push({ stage: "enriched", id: event.toolCallId }); if (event.toolCallId === "normal") ready(); }
      } };
    const call = renderer.renderCall(event.args, theme, context);
    views.set(event.toolCallId, { renderer, context, call });
  });
  pi.on("tool_call", event => {
    if (event.toolCallId === "blocked") return { block: true, reason: "synthetic denial after preview" };
  });
  pi.on("tool_result", event => {
    const view = views.get(event.toolCallId);
    view.context.isPartial = false;
    view.context.isError = event.isError;
    view.result = view.renderer.renderResult({ content: event.content, details: event.details }, { expanded: true, isPartial: false }, theme, view.context);
    events.push({ stage: "result", id: event.toolCallId });
  });
  pi.on("turn_end", () => events.push({ stage: "turn-end" }));
  pi.on("agent_end", async (_event, ctx) => {
    let deadline;
    try {
      await Promise.race([observed, new Promise((_done, reject) => { deadline = setTimeout(() => reject(new Error("No native enriched view")), 5000); })]);
      const normal = paint(views.get("normal"));
      const blocked = paint(views.get("blocked"));
      assert.match(normal, /2\s+- old/);
      assert.match(normal, /2\s+\+ new/);
      assert.ok(normal.includes("NATIVE_TAIL"));
      assert.ok(!blocked.includes("NATIVE_LEAD"));
      assert.ok(!events.some(event => event.stage === "execute" && event.id === "blocked"));
      assert.equal(await readFile(join(root, "blocked.ts"), "utf8"), "NATIVE_LEAD\nold\nNATIVE_TAIL\n");
      assert.equal(ctx.sessionManager.getBranch().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("NATIVE_LEAD")), false);
      assert.equal(modelRequests, 2);
      await writeFile(join(root, "result.json"), JSON.stringify({ normal, blocked, events, modelRequests }, null, 2));
    } finally { clearTimeout(deadline); runtime.dispose(); ctx.shutdown(); }
  });
  pi.registerProvider("tool-views-native", { baseUrl: "https://fixture.invalid", api: "tool-views-native", apiKey: "unused-offline-fixture",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model) {
      modelRequests++;
      events.push({ stage: "model", request: modelRequests });
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (!sent) {
        sent = true;
        for (const id of ["normal", "blocked"]) {
          const call = { type: "toolCall", id, name: "arbitrary_patch_fixture", arguments: {
            input: `*** Begin Patch\n*** Update File: ${id}.ts\n@@\n-old\n+new\n*** End Patch`,
          } };
          const contentIndex = message.content.length;
          message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
        }
        message.stopReason = "toolUse";
      } else message.content.push({ type: "text", text: "fixture complete" });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
