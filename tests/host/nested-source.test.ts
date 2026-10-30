import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { SourceIndex } from "../../src/host/source.ts";
import type { SessionReader } from "../../src/host/source.ts";

class Session implements SessionReader {
  entries: SessionEntry[] = [];
  leaf: string | null = null;
  getSessionId() { return "session"; }
  getLeafId() { return this.leaf; }
  getEntry(id: string) { return this.entries.find(entry => entry.id === id); }
  getBranch() { return this.entries; }
  append(message: SessionMessageEntry["message"]) {
    const entry: SessionMessageEntry = { type: "message", id: `entry-${this.entries.length}`, parentId: this.leaf, timestamp: "now", message };
    this.entries.push(entry); this.leaf = entry.id; return entry;
  }
}

function assistant(call: ToolCall): AssistantMessage {
  return { role: "assistant", content: [call], api: "anthropic-messages", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function fixture() {
  const reader = new Session(), index = new SourceIndex();
  const parameters = { type: "object", required: ["path"], properties: { path: { type: "string" } } };
  reader.append({ role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "read", description: "old read", parameters }] });
  index.refresh(reader);
  const call: ToolCall = { type: "toolCall", id: "root", name: "codemode", arguments: { code: "read" } };
  index.start(assistant(call));
  reader.append(assistant(call)); index.refresh(reader); index.commitOccurrence();
  return { reader, index, parameters };
}

test("live child identity binds the actual parent occurrence and snapshots submitted input", () => {
  const { index } = fixture();
  const input = { path: "a.ts" };
  index.startChild("root", "child-without-parsed-id", "read", input);
  input.path = "mutated.ts";
  const child = index.associateChild("child-without-parsed-id", "read");
  assert.equal(child?.declaration?.description, "old read");
  assert.deepEqual(child?.arguments, { path: "a.ts" });
  assert.equal(child?.settled, false);
  index.endChild("root", "child-without-parsed-id", "read", false);
  assert.equal(index.associateChild("child-without-parsed-id", "read")?.settled, true);
  assert.equal(index.associateChild("child-without-parsed-id", "other"), undefined);
  index.startChild("root", "child-without-parsed-id", "read", { path: "other.ts" });
  assert.equal(index.associateChild("child-without-parsed-id", "read"), undefined);
});

test("a contradictory terminal event invalidates only the conflicting child", () => {
  const { index } = fixture();
  index.startChild("root", "one", "read", { path: "a.ts" });
  index.startChild("root", "two", "read", { path: "b.ts" });
  index.endChild("wrong-parent", "one", "read", false);
  assert.equal(index.associateChild("one", "read"), undefined);
  assert.deepEqual(index.associateChild("two", "read")?.arguments, { path: "b.ts" });
});

test("partial updates must belong to the same live parent and invocation", () => {
  const { index } = fixture();
  index.startChild("root", "one", "read", { path: "a.ts" });
  index.startChild("root", "two", "read", { path: "b.ts" });
  assert.equal(index.updateChild("wrong-parent", "one", "read"), false);
  assert.equal(index.associateChild("one", "read"), undefined);
  assert.equal(index.updateChild("root", "two", "read"), true);
  index.endChild("root", "two", "read", false);
  assert.equal(index.updateChild("root", "two", "read"), false);
  assert.equal(index.associateChild("two", "read"), undefined);
});

test("explicit null input remains distinct from missing input", () => {
  const { index } = fixture();
  index.startChild("root", "null-child", "read", null);
  index.startChild("root", "missing-child", "read", undefined);
  assert.equal(index.associateChild("null-child", "read")?.arguments, null);
  assert.equal(index.associateChild("missing-child", "read")?.arguments, undefined);
});

test("stored child facts use the parent's declaration and preserve siblings independently", () => {
  const { reader, index, parameters } = fixture();
  reader.append({ role: "toolResult", toolCallId: "root", toolName: "codemode", isError: false, timestamp: 2, content: [{ type: "text", text: "output" }],
    nestedCalls: { complete: false, calls: [{ id: "c1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
      { id: "c2", name: "read", argumentsBytes: 9000, status: "ok" }] } });
  reader.append({ role: "system", content: "", timestamp: 3, toolsAdded: [{ name: "read", description: "later read", parameters }] });
  index.refresh(reader);
  assert.deepEqual(index.associateChild("c1", "read")?.arguments, { path: "a.ts" });
  assert.equal(index.associateChild("c1", "read")?.declaration?.description, "old read");
  assert.equal(index.associateChild("c1", "read")?.settled, true);
  assert.equal(index.associateChild("c2", "read")?.arguments, undefined);
  assert.equal(index.associateChild("c2", "read")?.declaration?.description, "old read");
});

test("same-leaf replacement removes previously recorded child facts", () => {
  const { reader, index } = fixture();
  const entry = reader.append({ role: "toolResult", toolCallId: "root", toolName: "codemode", isError: false, timestamp: 2,
    content: [{ type: "text", text: "before" }], nestedCalls: { complete: true, calls: [{ id: "c1", name: "read", arguments: { path: "a.ts" }, status: "ok" }] } });
  index.refresh(reader);
  assert.ok(index.associateChild("c1", "read"));
  entry.message = { role: "toolResult", toolCallId: "root", toolName: "codemode", isError: false, timestamp: 2, content: [{ type: "text", text: "redacted" }] };
  index.refresh(reader, true);
  assert.equal(index.associateChild("c1", "read"), undefined);
});

test("a declaration changed while the parent ran cannot authorize a stale child contract", () => {
  const { reader, index, parameters } = fixture();
  reader.append({ role: "system", content: "", timestamp: 2, toolsAdded: [{ name: "read", description: "changed read", parameters }] });
  index.refresh(reader);
  index.startChild("root", "child", "read", { path: "a.ts" });
  assert.equal(index.associateChild("child", "read")?.declaration, undefined);
});

test("a later declaration change does not change an already observed live request", () => {
  const { reader, index, parameters } = fixture();
  index.startChild("root", "child", "read", { path: "a.ts" });
  reader.append({ role: "system", content: "", timestamp: 2, toolsAdded: [{ name: "read", description: "changed read", parameters }] });
  index.refresh(reader);
  assert.equal(index.associateChild("child", "read")?.declaration?.description, "old read");
});

test("a later compaction cannot change a retained child's parent-prefix declaration", () => {
  const { reader, index, parameters } = fixture();
  const first = reader.entries.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
  reader.append({ role: "toolResult", toolCallId: "root", toolName: "codemode", isError: false, timestamp: 2,
    content: [{ type: "text", text: "first" }], nestedCalls: { complete: true,
      calls: [{ id: "first-child", name: "read", arguments: { path: "a.ts" }, status: "ok" }] } });
  reader.entries.push({ type: "compaction", id: "checkpoint", parentId: reader.leaf, timestamp: "now", summary: "summary",
    firstKeptEntryId: first.id, tokensBefore: 100,
    systemMessage: { role: "system", content: "", timestamp: 3, toolsAdded: [{ name: "read", description: "checkpoint read", parameters }] } });
  reader.leaf = "checkpoint";
  const second: ToolCall = { type: "toolCall", id: "second-root", name: "codemode", arguments: { code: "read" } };
  reader.append(assistant(second));
  reader.append({ role: "toolResult", toolCallId: "second-root", toolName: "codemode", isError: false, timestamp: 4,
    content: [{ type: "text", text: "second" }], nestedCalls: { complete: true,
      calls: [{ id: "second-child", name: "read", arguments: { path: "b.ts" }, status: "ok" }] } });
  index.refresh(reader);
  assert.equal(index.associateChild("first-child", "read")?.declaration?.description, "old read");
  assert.equal(index.associateChild("second-child", "read")?.declaration?.description, "checkpoint read");
});

test("reused child IDs across parent occurrences are not joined by name or argument equality", () => {
  const { reader, index } = fixture();
  reader.append({ role: "toolResult", toolCallId: "root", toolName: "codemode", isError: false, timestamp: 2,
    content: [{ type: "text", text: "first" }], nestedCalls: { complete: true,
      calls: [{ id: "reused", name: "read", arguments: { path: "same.ts" }, status: "ok" }] } });
  const second: ToolCall = { type: "toolCall", id: "second-root", name: "codemode", arguments: { code: "read" } };
  reader.append(assistant(second));
  reader.append({ role: "toolResult", toolCallId: "second-root", toolName: "codemode", isError: false, timestamp: 3,
    content: [{ type: "text", text: "second" }], nestedCalls: { complete: true,
      calls: [{ id: "reused", name: "read", arguments: { path: "same.ts" }, status: "ok" }] } });
  index.refresh(reader);
  assert.equal(index.associateChild("reused", "read"), undefined);
});
