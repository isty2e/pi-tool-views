import assert from "node:assert/strict";
import test from "node:test";
import { CallPreparations } from "../../src/host/prepared.ts";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import { observeDiffContext } from "../../src/diff/observed-context.ts";
import type { CallSource } from "../../src/host/source.ts";
import type { DiffPresentation } from "../../src/diff/model.ts";

function observations(plan: DiffPresentation, value: { before: string; after?: string }) {
  return new Map(plan.units.flatMap(unit => unit.sections.flatMap(section => section.kind === "hunks" ? section.hunks.map(hunk => [hunk, value] as const) : [])));
}

function source(key = "session/entry/0"): CallSource {
  return { key, entryId: "entry", ordinal: 0, call: { type: "toolCall", id: "reused", name: "fixture", arguments: { text: "old" } },
    eligible: true, declaration: undefined, result: undefined, resultEntryId: undefined };
}

test("request preparation is shared by complete resultless calls and their committed presentation", async () => {
  let compiled = 0;
  const preparations = new CallPreparations({
    compile: () => {
      compiled++;
      return { request: () => ({ kind: "change.replacements", requestedEdits: [{ path: "file.ts", oldText: "old", newText: "new" }] }),
        result: () => ({ parts: [{ kind: "original-content" }] }) };
    }, compare: buildDiffPresentation,
  });
  const call = source();
  const prepared = preparations.request(call);
  assert.equal(preparations.request(call), prepared);
  assert.equal(preparations.committed(call), undefined);
  assert.equal(compiled, 1);

  const committed = { ...call, result: { content: [{ kind: "text" as const, text: "producer outcome" }], isError: true }, resultEntryId: "result" };
  const frame = preparations.committed(committed)!;
  assert.equal(preparations.committed(committed), frame);
  assert.equal(preparations.request(committed), frame);
  assert.deepEqual(frame.request, prepared.request);
  const plan = structuredClone(frame.plan);
  const observed = await observeDiffContext(frame.plan, observations(frame.plan, { before: "lead\nold\n", after: "lead\nnew\n" }), 1);
  assert.ok(observed.size > 0);
  assert.equal(preparations.committed(committed), frame);
  assert.deepEqual(frame.plan, plan);
  assert.equal(committed.result.isError, true);
  assert.deepEqual(committed.result.content, [{ kind: "text", text: "producer outcome" }]);
});

test("replacement frames, branch resets and reused call IDs do not reuse prepared facts", () => {
  const preparations = new CallPreparations({ compile: () => ({ request: () => ({ kind: "change.replacements",
    requestedEdits: [{ path: "file.ts", oldText: "old", newText: "new" }] }), result: () => ({ parts: [{ kind: "original-content" }] }) }), compare: buildDiffPresentation });
  const call = { ...source(), result: { content: [], isError: false } };
  const frame = preparations.committed(call)!;
  const other = { ...call, key: "session/other-entry/0" };
  assert.notEqual(preparations.committed(other), frame);
  preparations.invalidate(call);
  assert.notEqual(preparations.committed(call), frame);
  const fresh = preparations.committed(call)!;
  preparations.reset();
  assert.notEqual(preparations.committed(call), fresh);
});
