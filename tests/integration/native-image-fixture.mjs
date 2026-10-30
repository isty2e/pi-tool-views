import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const root = process.env.PTV_TEST_ROOT;
if (!root) throw new Error("PTV_TEST_ROOT is required for the isolated image fixture.");
const replay = process.env.PTV_TEST_REPLAY === "1";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const log = (event, data = {}) => appendFileSync(`${root}/events.jsonl`, JSON.stringify({ event, replay, pid: process.pid, ...data }) + "\n");

export default function imageFixture(pi) {
  let sent = false;
  pi.registerTool({ name: "fixture_image", label: "Synthetic image", description: "Returns a supplied image and long caption.",
    parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Path to the image file." } } },
    execute: async () => ({ content: [
      { type: "text", text: Array.from({ length: 24 }, (_, index) => `caption ${index}`).join("\n") },
      { type: "image", data: image, mimeType: "image/png" },
    ] }),
  });
  pi.on("session_start", () => { pi.setActiveTools(["fixture_image"]); log("session-start"); });
  pi.on("agent_end", () => log("agent-end"));
  pi.registerProvider("tool-views-fixture", { api: "tool-views-fixture", baseUrl: "http://127.0.0.1:9", apiKey: "synthetic-unused",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: sent ? "stop" : "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      log("provider");
      stream.push({ type: "start", partial: message });
      if (!sent) {
        sent = true;
        const call = { type: "toolCall", id: "image", name: "fixture_image", arguments: { path: "synthetic.png" } };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      } else message.content.push({ type: "text", text: "IMAGE_FIXTURE_DONE" });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
