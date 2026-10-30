import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { buildOperationPresentation } from "../../src/operations.ts";
import type { RequestView, ResultView } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

function present(request: RequestView, result?: ResultView) {
  return buildOperationPresentation(request, buildDiffPresentation(request, result));
}

test("operation identity preserves repeated paths, unscoped edits and no-op occurrences", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "old-a", newText: "new-a" }, { path: "b", oldText: "old-b", newText: "new-b" },
    { path: "a", oldText: "new-a", newText: "last-a" }, { path: "", oldText: "same", newText: "same" },
  ] };
  const plan = present(request);
  assert.deepEqual(plan.items.map(item => item.kind === "edit" ? item.path : undefined), ["a", "b", "a", undefined]);
  assert.equal(plan.items.length, 4);
  assert.equal(plan.remainder.units.length, 0);
  assert.deepEqual(request.requestedEdits.map(edit => edit.path), ["a", "b", "a", ""]);
});

test("reported file diffs attach only to unique requested file occurrences", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "a-before", newText: "a-request" }, { path: "b", oldText: "b-before", newText: "b-request" },
    { path: "a", oldText: "a-before-two", newText: "a-request-two" },
  ] };
  const result: ResultView = { parts: [
    { kind: "diff", origin: "reported", representations: { unified: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+a-reported\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-y\n+b-reported\n" } },
    { kind: "notice", severity: "warning", origin: "producer", text: "failed after partial application" },
  ] };
  const plan = present(request, result);
  assert.deepEqual(plan.items.map(item => item.kind === "edit" && item.diff.units[0]?.origin), ["request", "reported", "request"]);
  assert.equal(plan.remainder.units.length, 1);
  assert.deepEqual(plan.remainder.units[0]?.scope, { kind: "file", path: "a" });
  assert.deepEqual(plan.remainder.context, [result.parts[1]]);
});

test("ambiguous and aggregate result scope is not copied into child edits", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "old", newText: "first" }, { path: "b", oldText: "old", newText: "second" },
  ] };
  const aggregate: ResultView = { parts: [{ kind: "diff", origin: "reported", representations: { numbered: "-1 old\n+1 aggregate" } }] };
  const plan = present(request, aggregate);
  assert.ok(plan.items.every(item => item.kind === "edit" && item.diff.units[0]?.origin === "request"));
  assert.equal(plan.remainder.units[0]?.scope.kind, "call");
});

test("in-progress results retain requested previews even when reported rows match", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "before a", newText: "after a" }, { path: "b", oldText: "before b", newText: "after b" },
  ] };
  const result: ResultView = { completeEditReceipt: true, parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 before a\n+1 after a\n-1 before b\n+1 after b" } },
    { kind: "text", text: "Applied 2 edit(s) successfully." },
  ] };
  const plan = buildDiffPresentation(request, result);
  const streaming = buildOperationPresentation(request, plan, {}, false);
  assert.ok(streaming.items.every(item => item.kind === "edit" && item.diff.units[0]?.origin === "request"));
  assert.equal(streaming.remainder.units[0]?.origin, "reported");
});

test("queries, fetch targets and compound actions preserve duplicates without splitting OR or unresolved alternatives", () => {
  for (const request of [
    { kind: "web.search", input: { kind: "multiple", queries: ["same", "other", "same"] } },
    { kind: "web.fetch", targets: { kind: "multiple", urls: ["a", "b", "a"] } },
    { kind: "web.source-check", claim: "shared claim", queries: ["same", "other", "same"] },
  ] as const) assert.equal(present(request).items.length, 3);
  for (const request of [
    { kind: "web.search", input: { kind: "both", query: "single", queries: ["first", "second"] } },
    { kind: "web.fetch", targets: { kind: "both", url: "single", urls: ["first", "second"] } },
    { kind: "search.literal-any", patterns: ["first", "second"], scope: {} },
  ] as const) assert.equal(present(request).items.length, 0);
  const actions = [{ kind: "open", reference: "page" }, { kind: "search", query: "q" }, { kind: "search", query: "q" }] as const;
  assert.deepEqual(present({ kind: "web.compound", actions }).items.map(item => item.kind === "web" && item.action), actions);
});

test("partial query observations allocate uniquely, leaving duplicate queries and shared receipts at call scope", () => {
  const result: ResultView = { parts: [{ kind: "query-results", responseId: "stored-id", items: [
    { query: "unique", answer: "answer" }, { query: "same", error: "query failed" }, { query: "unexpected", answer: "unallocated" },
  ] }, { kind: "notice", severity: "warning", origin: "producer", text: "producer truncation notice" }] };
  const plan = present({ kind: "web.search", input: { kind: "multiple", queries: ["same", "unique", "same", "absent"] } }, result);
  assert.deepEqual(plan.items.map(item => item.kind === "web" ? item.observation?.answer : undefined), [undefined, "answer", undefined, undefined]);
  const remaining = plan.remainder.context[0];
  assert.equal(remaining?.kind, "query-results");
  if (remaining?.kind === "query-results") {
    assert.deepEqual(remaining.items.map(item => item.query), ["same", "unexpected"]);
    assert.equal(remaining.responseId, "stored-id");
  }
  assert.equal(plan.remainder.context.length, 2);
});

test("all requested edit occurrences share one finite refinement budget", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "a", newText: "b" }, { path: "b", oldText: "c", newText: "d" },
    { path: "c", oldText: "e", newText: "f" },
  ] };
  const plan = buildOperationPresentation(request, buildDiffPresentation(request, undefined), { maxComparisonTokens: 4, timeoutMs: 500 });
  assert.ok(plan.items[1]?.kind === "edit" && plan.items[1].diff.units[0]?.coarseComparison);
  assert.ok(plan.items[2]?.kind === "edit" && plan.items[2].diff.units[0]?.coarseComparison);
  assert.equal(plan.items.length, 3);
  assert.ok(JSON.stringify(plan).includes('"text":"f"'));
});

test("declaration-bound query results keep optional and malformed neighbors partial, without name dispatch", () => {
  const declaration = { description: "Search the web using queries.", input: { kind: "json" as const, schema: {
    type: "object", properties: { queries: { type: "array", items: { type: "string" }, description: "Multiple queries searched concurrently." } },
  } }, outputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "object", properties: {
    query: { type: "string" }, answer: { type: "string" }, error: { type: ["string", "null"] },
    results: { type: "array", items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" } } } },
  } } } } } };
  const projection = compileProjection(declaration);
  const output = { responseId: "stored-id", queries: [
    { query: "one", answer: "first answer", results: [{ url: "https://example.com/", title: "Source" }] },
    { query: "two", error: "original producer error" }, { query: "three" }, { query: 7, answer: "uninterpretable neighbor" },
  ] };
  const result = { isError: false, content: [{ kind: "text" as const, text: JSON.stringify(output) },
    { kind: "text" as const, text: "independent original notice" }], structuredContent: output };
  const view = projection.result(result);
  const queries = view.parts.find(part => part.kind === "query-results");
  assert.ok(queries?.kind === "query-results");
  if (queries?.kind === "query-results") {
    assert.deepEqual(queries.items.map(item => item.query), ["one", "two", "three"]);
    assert.equal(queries.items[1]?.error, "original producer error");
    assert.equal(queries.items[2]?.answer, undefined);
  }
  assert.ok(view.parts.some(part => part.kind === "original-content" && (!part.indexes || part.indexes.includes(1))));
  assert.ok(view.parts.some(part => part.kind === "original-content" && (!part.indexes || part.indexes.includes(0))));
  const request = projection.request({ queries: ["one", "two", "three"] });
  const allocated = present(request, view);
  assert.equal(allocated.items.length, 3);
  assert.ok(allocated.items[1]?.kind === "web" && allocated.items[1].observation?.error === "original producer error");
  const undeclared = compileProjection({ description: declaration.description, input: declaration.input }).result(result);
  assert.ok(!undeclared.parts.some(part => part.kind === "query-results"));

  const annotated = { queries: [{ query: "one", answer: "available answer" }], producerNote: "unclassified material" };
  const retained = projection.result({ isError: false, content: [{ kind: "text", text: JSON.stringify(annotated) }], structuredContent: annotated });
  assert.ok(retained.parts.some(part => part.kind === "query-results"));
  assert.ok(retained.parts.some(part => part.kind === "original-content" && (!part.indexes || part.indexes.includes(0))));
});

test("move destinations and image-query aliases are not treated as uniquely attributable", () => {
  const request: RequestView = { kind: "change.patch", format: "codex", text: [
    "*** Begin Patch", "*** Update File: a", "*** Move to: b", "@@", "-before", "+moved",
    "*** Update File: b", "@@", "-moved", "+updated", "*** End Patch",
  ].join("\n") };
  const result: ResultView = { parts: [{ kind: "diff", origin: "reported", representations: {
    unified: "--- a/b\n+++ b/b\n@@ -1 +1 @@\n-before\n+reported\n",
  } }] };
  const plan = present(request, result);
  assert.ok(plan.items.every(item => item.kind === "edit" && item.diff.units[0]?.origin === "request"));
  assert.equal(plan.remainder.units.length, 1);
  const web = present({ kind: "web.compound", actions: [{ kind: "search", query: "same" }, { kind: "image-search", query: "same" }] },
    { parts: [{ kind: "query-results", items: [{ query: "same", answer: "unclassified search kind" }] }] });
  assert.ok(web.items.every(item => item.kind === "web" && item.observation === undefined));
  assert.equal(web.remainder.context.length, 1);
});

test("file bundles and operation occurrences share patch grammar selection and conflict behavior", () => {
  const codex = "*** Begin Patch\n*** Add File: a\n+one\n*** Add File: b\n+two\n*** End Patch";
  const unified = "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+one\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-old\n+two\n";
  for (const [format, text] of [["codex", codex], ["unified", unified], ["unconfirmed", codex], ["unconfirmed", unified]] as const) {
    const request: RequestView = { kind: "change.patch", format, text };
    const files = buildDiffPresentation(request, undefined);
    const plan = buildOperationPresentation(request, files);
    assert.deepEqual(plan.items.map(item => item.kind === "edit" && item.path), ["a", "b"]);
    assert.deepEqual(files.units.map(unit => unit.scope.kind === "file" && unit.scope.path), ["a", "b"]);
  }
  const conflicting: RequestView = { kind: "change.patch", format: "unified",
    text: "diff --git a/a b/b\n--- a/other\n+++ b/b\n@@ -1 +1 @@\n-old\n+new\n" };
  const plan = present(conflicting);
  assert.equal(plan.items.length, 0);
  assert.ok(plan.remainder.units.some(unit => unit.sections.some(section => section.kind === "raw")));
});
