import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import { buildOperationPresentation } from "../../src/operations.ts";
import { compileProjection } from "../../src/projection/index.ts";

const projection = compileProjection({
  description: "Apply a patch to files.",
  input: { kind: "json", schema: { type: "object", required: ["patch"], properties: {
    patch: { type: "string", description: "Codex-style patch beginning with *** Begin Patch." },
  } } },
});

const patch = "*** Begin Patch\n*** Update File: alpha.txt\n@@\n-alpha one\n+alpha changed\n*** Add File: notes/new.txt\n+created\n*** Update File: rename.txt\n*** Move to: moved.txt\n@@\n-old name\n+new name\n*** End Patch";

test("reported file diffs supply numbered split views for their matching requested operations", () => {
  const request = projection.request({ patch });
  const supplied = { content: [{ kind: "text" as const, text: "Updated files" }], isError: false, details: {
    status: "completed", changes: [
      { kind: "update", path: "alpha.txt", displayDiff: "-1 alpha one\n+1 alpha changed\n 2 beta two\n   ..." },
      { kind: "add", path: "notes/new.txt", displayDiff: "+1 created" },
      { kind: "update", path: "rename.txt", moveTo: "moved.txt", displayDiff: "-1 old name\n+1 new name" },
    ],
  } };
  const result = projection.result(supplied, request);
  const plan = buildDiffPresentation(request, result);
  const operations = buildOperationPresentation(request, plan);
  assert.equal(operations.items.length, 3);
  for (const item of operations.items) {
    assert.equal(item.kind, "edit");
    if (item.kind !== "edit") continue;
    assert.equal(item.diff.units[0]?.origin, "reported");
  }
  const first = operations.items[0];
  assert.equal(first?.kind, "edit");
  if (first?.kind === "edit") {
    const lines = renderDiffPresentation(first.diff, 100, { layout: "split" });
    assert.ok(lines.some(line => /\b1\s+-\s+alpha one/.test(line) && /\b1\s+\+\s+alpha changed/.test(line)));
    assert.ok(lines.includes("…"));
  }
  assert.deepEqual(supplied.details.changes[0]?.displayDiff, "-1 alpha one\n+1 alpha changed\n 2 beta two\n   ...");
});

test("partial results retain the reported change and the original failure", () => {
  const request = projection.request({ patch });
  const supplied = { content: [{ kind: "text" as const, text: "Could not write notes/new.txt" }], isError: true, details: {
    status: "failed", changes: [{ kind: "update", path: "alpha.txt", displayDiff: "-1 alpha one\n+1 alpha changed" }],
    error: "Could not write notes/new.txt",
  } };
  const result = projection.result(supplied, request);
  const operations = buildOperationPresentation(request, buildDiffPresentation(request, result));
  assert.equal(operations.items[0]?.kind === "edit" && operations.items[0].diff.units[0]?.origin, "reported");
  assert.equal(operations.items[1]?.kind === "edit" && operations.items[1].diff.units[0]?.origin, "request");
  assert.ok(result.parts.some(part => part.kind === "original-content"));
});

test("ambiguous repeated file reports stay in the result without blocking other files", () => {
  const request = projection.request({ patch });
  const result = projection.result({ content: [{ kind: "text", text: "Changes reported" }], isError: false, details: {
    changes: [
      { kind: "update", path: "alpha.txt", preview: true, displayDiff: "-1 alpha one\n+1 first" },
      { kind: "update", path: "alpha.txt", displayDiff: "-1 first\n+1 second" },
      { kind: "add", path: "notes/new.txt", displayDiff: "+1 created" },
    ],
  } }, request);
  const operations = buildOperationPresentation(request, buildDiffPresentation(request, result));
  assert.equal(operations.items[0]?.kind === "edit" && operations.items[0].diff.units[0]?.origin, "request");
  assert.equal(operations.items[1]?.kind === "edit" && operations.items[1].diff.units[0]?.origin, "reported");
  const lines = renderDiffPresentation(operations.remainder, 100, { layout: "split" }).join("\n");
  assert.ok(lines.includes("first"));
  assert.ok(lines.includes("second"));
  assert.deepEqual(operations.remainder.units.filter(unit => unit.scope.kind === "file" && unit.scope.path === "alpha.txt")
    .map(unit => unit.origin), ["producer-preview", "reported"]);
});

test("a malformed duplicate and conflicting move cannot be attributed to an operation", () => {
  const request = projection.request({ patch });
  const result = projection.result({ content: [{ kind: "text", text: "Report" }], isError: false, details: {
    changes: [
      { kind: "update", path: "alpha.txt", displayDiff: "-1 alpha one\n+1 first" },
      { kind: "update", path: "alpha.txt", displayDiff: 42 },
      { kind: "update", path: "rename.txt", moveTo: "other.txt", displayDiff: "-1 old name\n+1 new name" },
    ],
  } }, request);
  const operations = buildOperationPresentation(request, buildDiffPresentation(request, result));
  assert.equal(operations.items[0]?.kind === "edit" && operations.items[0].diff.units[0]?.origin, "request");
  assert.equal(operations.items[2]?.kind === "edit" && operations.items[2].diff.units[0]?.origin, "request");
  const lines = renderDiffPresentation(operations.remainder, 100, { layout: "unified" }).join("\n");
  assert.ok(lines.includes("first"));
  assert.ok(lines.includes("other.txt"));
});

test("a reported preview and later missing result do not become applied changes", () => {
  const request = projection.request({ patch });
  const result = projection.result({ content: [{ kind: "text", text: "Preview" }], isError: false, details: {
    changes: [{ kind: "update", path: "alpha.txt", preview: true, displayDiff: "-1 alpha one\n+1 proposed" }],
  } }, request);
  const operations = buildOperationPresentation(request, buildDiffPresentation(request, result));
  assert.equal(operations.items[0]?.kind === "edit" && operations.items[0].diff.units[0]?.origin, "producer-preview");
  const replacement = projection.result({ content: [{ kind: "text", text: "No details" }], isError: false }, request);
  const next = buildOperationPresentation(request, buildDiffPresentation(request, replacement));
  assert.equal(next.items[0]?.kind === "edit" && next.items[0].diff.units[0]?.origin, "request");
});
