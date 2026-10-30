import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { SourceIndex } from "../../src/host/source.ts";
import type { SessionReader } from "../../src/host/source.ts";

function call(id: string, args: ToolCall["arguments"] = { value: "original" }): ToolCall {
  return { type: "toolCall", id, name: "renamed", arguments: args };
}

function message(content: ToolCall[], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
  return { role: "assistant", content, stopReason, api: "anthropic-messages", provider: "fixture", model: "synthetic",
    timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

class MemorySession implements SessionReader {
  readonly entries: SessionEntry[] = [];
  leaf: string | null = null;
  branchReads = 0;
  entryReads = 0;
  getSessionId() { return "session"; }
  getLeafId() { return this.leaf; }
  getEntry(id: string) { this.entryReads++; return this.entries.find(entry => entry.id === id); }
  getBranch() {
    this.branchReads++;
    const branch: SessionEntry[] = [];
    let id = this.leaf;
    while (id) {
      const entry = this.entries.find(item => item.id === id);
      if (!entry) break;
      branch.unshift(entry);
      id = entry.parentId;
    }
    return branch;
  }
  append(message: SessionMessageEntry["message"]) {
    const entry: SessionMessageEntry = { type: "message", id: `entry-${this.entries.length}`, parentId: this.leaf,
      timestamp: new Date(0).toISOString(), message };
    this.entries.push(entry);
    this.leaf = entry.id;
    return entry;
  }
}

test("live anchor binding survives prior refresh, argument cloning and delayed sibling creation", () => {
  const reader = new MemorySession();
  const index = new SourceIndex();
  index.refresh(reader);
  const streamed = message([call("same"), call("sibling")]);
  index.start(streamed);
  const stored = structuredClone(streamed);
  stored.content = stored.content.map(part => part.type === "toolCall" ? { ...part, arguments: { value: "executed" } } : part);
  const entry = reader.append(stored);
  index.refresh(reader);
  reader.append({ role: "system", content: "unrelated metadata", timestamp: 1 });
  index.refresh(reader);
  index.commitOccurrence();

  const first = index.associate({ id: "same", name: "renamed", args: streamed.content[0] }, true);
  const late = index.associate({ id: "sibling", name: "renamed", args: {} }, true);
  assert.equal(first?.entryId, entry.id);
  assert.deepEqual(first?.call.arguments, { value: "executed" });
  assert.equal(late?.entryId, entry.id);
  assert.notEqual(first?.key, late?.key);
});

test("history requires exactly one reference + ID/name match, not values or replay order", () => {
  const reader = new MemorySession();
  const one = call("reused");
  reader.append(message([one]));
  const two = call("reused");
  reader.append(message([two]));
  const index = new SourceIndex();
  index.refresh(reader);
  const a = index.associate({ id: "reused", name: "renamed", args: one.arguments }, false);
  const b = index.associate({ id: "reused", name: "renamed", args: two.arguments }, false);
  assert.ok(a && b && a.key !== b.key);
  assert.equal(index.associate({ id: "reused", name: "renamed", args: structuredClone(one.arguments) }, false), undefined);
  assert.equal(index.associate({ id: "reused", name: "other", args: one.arguments }, false), undefined);

  reader.append(message([call("reused", one.arguments)]));
  index.refresh(reader);
  assert.equal(index.associate({ id: "reused", name: "renamed", args: one.arguments }, false), undefined);
});

test("persisted truncation and parser errors never admit request interpretation", () => {
  for (const reason of ["aborted", "error", "length", "pending", "unknown" as AssistantMessage["stopReason"]] as const) {
    const reader = new MemorySession();
    const block = call("id");
    reader.append(message([block], reason));
    const index = new SourceIndex();
    index.refresh(reader);
    assert.equal(index.associate({ id: "id", name: "renamed", args: block.arguments }, false)?.eligible, false);
  }
  const reader = new MemorySession();
  const block = { ...call("id"), argumentsError: "provider JSON was incomplete" };
  reader.append(message([block]));
  const index = new SourceIndex();
  index.refresh(reader);
  assert.equal(index.associate({ id: "id", name: "renamed", args: block.arguments }, false)?.eligible, false);
});

test("historical declarations replay before each assistant; context edits do not remove visible sources", () => {
  const reader = new MemorySession();
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  reader.append({ role: "system", content: "", toolsAdded: [{ name: "renamed", description: "first declaration", parameters: schema }], timestamp: 1 });
  const block = call("id");
  const first = reader.append(message([block]));
  reader.append({ role: "system", content: "", toolsRemoved: [{ name: "renamed" }], toolsAdded: [{ name: "renamed", description: "new declaration", parameters: schema }], timestamp: 2 });
  const secondBlock = call("next");
  reader.append(message([secondBlock]));
  reader.entries.push({ type: "context_edit", id: "edited", parentId: reader.leaf, timestamp: "now", targetId: first.id, replacement: null });
  reader.leaf = "edited";
  const index = new SourceIndex();
  index.refresh(reader);
  assert.equal(index.associate({ id: "id", name: "renamed", args: block.arguments }, false)?.declaration?.description, "first declaration");
  assert.equal(index.associate({ id: "next", name: "renamed", args: secondBlock.arguments }, false)?.declaration?.description, "new declaration");
});

test("final results stay within their assistant occurrence despite reused call IDs", () => {
  const reader = new MemorySession();
  const old = call("reused");
  reader.append(message([old]));
  reader.append({ role: "toolResult", toolCallId: "reused", toolName: "renamed", content: [{ type: "text", text: "old result" }], isError: false, timestamp: 1 });
  const latest = call("reused");
  reader.append(message([latest]));
  const index = new SourceIndex();
  index.refresh(reader);
  assert.equal(index.associate({ id: "reused", name: "renamed", args: latest.arguments }, false)?.result, undefined);
  reader.append({ role: "toolResult", toolCallId: "reused", toolName: "renamed", content: [{ type: "text", text: "redacted final" }], details: { marker: "final" }, isError: true, timestamp: 2 });
  index.refresh(reader);
  const source = index.associate({ id: "reused", name: "renamed", args: latest.arguments }, false);
  assert.deepEqual(source?.result?.content, [{ kind: "text", text: "redacted final" }]);
  assert.equal(source?.result?.isError, true);
  assert.deepEqual(index.associate({ id: "reused", name: "renamed", args: old.arguments }, false)?.result?.content, [{ kind: "text", text: "old result" }]);

  const reads = reader.branchReads + reader.entryReads;
  index.refresh(reader);
  index.source(source!.key);
  assert.equal(reader.branchReads + reader.entryReads, reads);
});

test("compaction checkpoints restore declarations without replacing visible original calls", () => {
  const reader = new MemorySession();
  const parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
  reader.append({ role: "system", content: "", toolsAdded: [{ name: "renamed", description: "original", parameters }], timestamp: 1 });
  const old = call("old");
  const previous = reader.append(message([old]));
  reader.entries.push({ type: "compaction", id: "checkpoint", parentId: reader.leaf, timestamp: "now", summary: "summary",
    firstKeptEntryId: previous.id, tokensBefore: 100,
    systemMessage: { role: "system", content: "", toolsAdded: [{ name: "renamed", description: "checkpoint declaration", parameters }], timestamp: 2 } });
  reader.leaf = "checkpoint";
  const recent = call("recent");
  reader.append(message([recent]));
  const index = new SourceIndex();
  index.refresh(reader);
  assert.equal(index.associate({ id: "old", name: "renamed", args: old.arguments }, false)?.declaration?.description, "original");
  assert.equal(index.associate({ id: "recent", name: "renamed", args: recent.arguments }, false)?.declaration?.description, "checkpoint declaration");
});
