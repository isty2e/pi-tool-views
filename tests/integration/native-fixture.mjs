import { appendFileSync, existsSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const root = process.env.PTV_TEST_ROOT;
if (!root) throw new Error("PTV_TEST_ROOT is required for the isolated native fixture.");
const scenario = process.env.PTV_TEST_SCENARIO ?? "normal";
const replay = process.env.PTV_TEST_REPLAY === "1";
const log = (event, data = {}) => appendFileSync(`${root}/events.jsonl`, JSON.stringify({ event, replay, pid: process.pid, ...data }) + "\n");
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export default function nativeFixture(pi) {
  const sent = new Set();
  pi.registerTool({ name: "fixture_patch", label: "Synthetic patch", description: "Synthetic patch report; does not write files.",
    parameters: { type: "object", required: ["input"], properties: { input: { type: "string", description: "Codex-style patch payload." } } },
    execute: async (id, args) => {
      log("execute", { id, name: "fixture_patch", args });
      return { content: [{ type: "text", text: "synthetic reported patch" }], details: {
        patch: "--- a/reported.ts\n+++ b/reported.ts\n@@ -1 +1 @@\n-old\n+456_REPORTED\n",
      } };
    },
    renderShell: "self",
    renderCall(args, _theme, context) {
      log("native-call", { args, contextArgs: context.args });
      return { render: () => ["NATIVE_PATCH"], invalidate() {} };
    },
    renderResult(result) { return { render: () => result.content.filter(part => part.type === "text").map(part => part.text), invalidate() {} }; },
  });
  pi.registerTool({ name: "fixture_echo", label: "Synthetic echo", description: "Synthetic unknown-schema result.",
    parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    execute: async (id, args) => { log("execute", { id, name: "fixture_echo", args }); return { content: [{ type: "text", text: `EARLY_RESULT ${args.value}` }] }; },
  });
  pi.registerTool({ name: "fixture_code", label: "Synthetic code", description: "Execute JavaScript code (synthetic fixture with canned output).",
    parameters: { type: "object", required: ["code"], properties: { code: { type: "string", description: "Raw JavaScript source." } } },
    execute: async (id, args) => { log("execute", { id, name: "fixture_code", args }); return { content: [{ type: "text", text: Array.from({ length: 24 }, (_, index) => `output ${index}`).join("\n") }] }; },
  });

  pi.on("session_start", (event, ctx) => {
    pi.setActiveTools(["read", "edit", "fixture_patch", "fixture_echo", "fixture_code"]);
    log("session-start", { reason: event.reason });
    log("session-source", { entries: ctx.sessionManager.getBranch().map(entry => ({ id: entry.id, type: entry.type })) });
  });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") {
      const message = structuredClone(event.message);
      message.content = message.content.map(part => part.type === "toolCall"
        ? { ...part, arguments: JSON.parse(JSON.stringify(part.arguments).replaceAll("RAW_MARKER", "SAFE_MARKER")) } : part);
      return { message };
    }
    if (event.message.role === "toolResult" && event.message.toolName === "fixture_echo") {
      return { message: { ...event.message, content: [{ type: "text", text: "FINAL_RESULT SAFE_MARKER" }] } };
    }
  });
  pi.on("tool_call", async event => {
    if (scenario === "normal" && event.toolCallId === "edit-success" && !existsSync(`${root}/allow`)) {
      log("permission-wait");
      while (!existsSync(`${root}/allow`)) await wait(20);
    }
  });
  pi.on("tool_execution_start", event => log("execution-start", { id: event.toolCallId, name: event.toolName }));
  pi.on("tool_execution_end", event => log("execution-end", { id: event.toolCallId, name: event.toolName, error: event.isError }));
  pi.on("agent_end", (_event, ctx) => log("agent-end", { source: ctx.sessionManager.getBranch().filter(entry => entry.type === "message")
    .map(entry => ({ id: entry.id, role: entry.message.role, stopReason: entry.message.stopReason, content: entry.message.content })) }));

  pi.registerProvider("tool-views-fixture", { baseUrl: "http://127.0.0.1:9", api: "tool-views-fixture", apiKey: "synthetic-unused",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const round = context.messages.filter(message => message.role === "user").length;
      log("provider", { round });
      void (async () => {
        const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: usage(), stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        if (!sent.has(round)) {
          sent.add(round);
          const calls = scenario === "normal" ? [
            ["edit-success", "edit", { path: `${root}/workspace/source.ts`, edits: JSON.stringify([{ oldText: `const value = ${round};`, newText: `const value = ${round + 1}; // RAW_MARKER` }]) }],
            ["edit-failure", "edit", { path: `${root}/workspace/source.ts`, edits: JSON.stringify([{ oldText: "missing text", newText: "UNAPPLIED_REQUEST RAW_MARKER" }]) }],
            ["patch", "fixture_patch", { input: "*** Begin Patch\n*** Update File: reported.ts\n@@\n-old\n+123_RAW_MARKER\n*** End Patch" }],
            ["echo", "fixture_echo", { value: "RAW_MARKER" }],
            ["code", "fixture_code", { code: "first();\nsecond(); // RAW_MARKER" }],
            ["read", "read", { path: `${root}/workspace/read-source.ts` }],
          ] : [["unfinished", "edit", { path: `${root}/workspace/source.ts`, edits: [{ oldText: "const value = 1;", newText: "TRUNCATED_REQUEST" }] }]];
          for (const [id, name, args] of calls) {
            const contentIndex = message.content.length;
            const call = { type: "toolCall", id, name, arguments: {} };
            message.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            await wait(25);
            call.arguments = args;
            stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
          }
          if (scenario === "abort") {
            log("partial-ready");
            while (!options.signal?.aborted) await wait(20);
            message.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
            return;
          }
          message.stopReason = scenario === "length" ? "length" : "toolUse";
        } else message.content.push({ type: "text", text: `FIXTURE_DONE ${round}` });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })().catch(error => { log("fixture-error", { error: String(error) }); stream.end(); });
      return stream;
    },
  });
}
