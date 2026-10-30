import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import type { ComparisonOptions } from "../../src/diff/index.ts";
import type { DiffPresentation, DiffViewUnit } from "../../src/diff/model.ts";
import { buildOperationPresentation } from "../../src/operations.ts";
import type { RequestView, ResultView } from "../../src/presentation.ts";

const options = { maxComparisonTokens: 100, timeoutMs: 500 };
const request: RequestView = { kind: "change.replacements", requestedEdits: [
  { path: "a", oldText: "a", newText: "b" }, { path: "b", oldText: "c", newText: "d" },
  { path: "a", oldText: "e", newText: "f" }, { path: "a", oldText: "same", newText: "same" },
] };

function reuse(input: RequestView, plan: DiffPresentation, limits: ComparisonOptions = options, complete = true) {
  let reads = 0;
  const clock = mock.method(performance, "now", () => { reads++; return 0; });
  try {
    const operations = buildOperationPresentation(input, plan, limits, complete);
    assert.equal(reads, 0, "compatible operation projection must not start or refine another comparison");
    return operations;
  } finally { clock.mock.restore(); }
}

function text(unit: DiffViewUnit): readonly [string, string] {
  const pairs = unit.sections.flatMap(section => section.kind === "raw" ? []
    : section.hunks.flatMap(hunk => hunk.blocks.flatMap(block => block.kind === "change" ? block.pairs : [])));
  return [pairs.flatMap(pair => pair.before ? [pair.before.text] : []).join("\n"),
    pairs.flatMap(pair => pair.after ? [pair.after.text] : []).join("\n")];
}

test("file groups and A/B/A operation occurrences share compared sections while keeping no-ops", () => {
  const plan = buildDiffPresentation(request, undefined, options);
  const operations = reuse(request, plan);
  const units = operations.items.flatMap(item => { assert.equal(item.kind, "edit"); return item.kind === "edit" ? item.diff.units : []; });
  assert.deepEqual(units.map(unit => unit.scope.kind === "file" && unit.scope.path), ["a", "b", "a", "a"]);
  assert.equal(units[0]!.sections[0], plan.units[0]!.sections[0]);
  assert.equal(units[1]!.sections[0], plan.units[1]!.sections[0]);
  assert.equal(units[2]!.sections[0], plan.units[0]!.sections[1]);
  assert.deepEqual(units[3]!.sections[0], { kind: "hunks", target: { path: "a" }, hunks: [] });
});

test("repeated edit objects have separate ordinal budget outcomes and unscoped edits remain ordered", () => {
  const edit = { path: "a", oldText: "a", newText: "b" };
  const input: RequestView = { kind: "change.replacements", requestedEdits: [edit, edit, { path: "", oldText: "c", newText: "d" }] };
  const limits = { maxComparisonTokens: 4, timeoutMs: 500 };
  const clock = mock.method(performance, "now", () => 0);
  let plan: DiffPresentation;
  try { plan = buildDiffPresentation(input, undefined, limits); }
  finally { clock.mock.restore(); }
  const operations = reuse(input, plan, limits);
  const units = operations.items.flatMap(item => item.kind === "edit" ? item.diff.units : []);
  assert.equal(units[0]!.coarseComparison, undefined);
  assert.equal(units[1]!.coarseComparison, true);
  assert.equal(units[2]!.scope.kind, "call");
  assert.deepEqual(units.map(text), [["a", "b"], ["a", "b"], ["c", "d"]]);
});

test("reported winners retain unallocated request previews and the shared compound snapshot", () => {
  const result: ResultView = { parts: [{ kind: "diff", origin: "reported", representations: { unified:
    "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-u\n+v\n" } }] };
  const plan = buildDiffPresentation(request, result, options);
  assert.ok(plan.units.every(unit => unit.origin === "reported"));
  const operations = reuse(request, plan, options, false);
  assert.equal(operations.items.length, 4);
  assert.deepEqual(operations.items.map(item => item.kind === "edit" && item.diff.units[0]?.origin), ["request", "reported", "request", "request"]);
  assert.deepEqual(text(plan.compoundRequest!.units[1]!), ["c", "d"]);
  assert.equal(operations.remainder.units.length, 1);
});

test("patch occurrences reuse their selected grammar and compared section identity", () => {
  const codex = "*** Begin Patch\n*** Update File: a\n@@\n-a\n+b\n*** Update File: b\n@@\n-c\n+d\n*** Update File: a\n@@\n-e\n+f\n*** End Patch";
  const unified = "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-c\n+d\n";
  for (const [format, source] of [["codex", codex], ["unified", unified], ["unconfirmed", codex]] as const) {
    const input: RequestView = { kind: "change.patch", format, text: source };
    const plan = buildDiffPresentation(input, undefined, options);
    const operations = reuse(input, plan);
    const units = operations.items.flatMap(item => item.kind === "edit" ? item.diff.units : []);
    assert.equal(units[0]!.sections[0], plan.units[0]!.sections[0]);
    assert.equal(units[1]!.sections[0], plan.units[1]!.sections[0]);
    if (units.length === 3) assert.equal(units[2]!.sections[0], plan.units[0]!.sections[1]);
  }
});

test("different requests, policies and custom plans rebuild through composition without sharing stale facts", () => {
  const plan = buildDiffPresentation(request, undefined, options);
  const input: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "other", oldText: "x", newText: "y" }, { path: "next", oldText: "z", newText: "q" },
  ] };
  const changed = buildOperationPresentation(input, plan, options);
  assert.deepEqual(changed.items.map(item => item.kind === "edit" && item.path), ["other", "next"]);
  const coarse = buildOperationPresentation(request, plan, { maxComparisonTokens: 0 });
  for (const item of coarse.items) {
    assert.equal(item.kind, "edit");
    if (item.kind !== "edit") continue;
    const unit = item.diff.units[0]!;
    const noOp = unit.sections.every(section => section.kind === "hunks" && section.hunks.length === 0);
    assert.ok(noOp || unit.coarseComparison);
  }
  const custom = buildOperationPresentation(request, { units: [], applicationReports: [], context: [] }, options);
  assert.equal(custom.items.length, 4);
  assert.throws(() => buildOperationPresentation(request, plan, { maxComparisonTokens: -1 }), RangeError);
  const single: RequestView = { kind: "change.replacements", requestedEdits: [{ path: "a", oldText: "a", newText: "b" }] };
  assert.equal(reuse(single, buildDiffPresentation(single, undefined, options), { maxComparisonTokens: -1 }).items.length, 0);
});
