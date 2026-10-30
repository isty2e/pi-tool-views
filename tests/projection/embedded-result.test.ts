import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { buildOperationPresentation } from "../../src/operations.ts";

const edit = compileProjection({ description: "Replace exact text in a file.", input: { kind: "json", schema: {
  type: "object", required: ["path", "edits"], properties: {
    path: { type: "string" },
    edits: { type: "array", items: { type: "object", required: ["oldText", "newText"],
      properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
  },
} } });
const text = "Replaced 2 occurrences in alpha.txt\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,3 +1,3 @@\n-alpha one\n-beta two\n-gamma three\n+first is longer now\n+beta two\n+last changed";

test("mixed result text normalizes an embedded diff without losing warnings or original input", () => {
  const request = edit.request({ path: "alpha.txt", edits: [{ oldText: "alpha one", newText: "first is longer now" },
    { oldText: "gamma three", newText: "last changed" }] });
  const supplied = { isError: false, content: [{ kind: "text" as const, text: `${text}\nWarning: check output.` }] };
  const result = edit.result(supplied, request);
  assert.deepEqual(result.parts.map(part => part.kind), ["text", "diff", "text"]);
  assert.equal(result.parts[0]?.kind === "text" && result.parts[0].text, "Replaced 2 occurrences in alpha.txt\n");
  assert.equal(result.parts[2]?.kind === "text" && result.parts[2].text, "Warning: check output.");
  assert.equal(supplied.content[0]!.text, `${text}\nWarning: check output.`);
});

test("unsupported and truncated text remain available as original output", () => {
  const request = edit.request({ path: "alpha.txt", edits: [{ oldText: "a", newText: "b" }] });
  const truncated = "Warning\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new";
  const result = edit.result({ isError: true, content: [{ kind: "text", text: truncated }] }, request);
  assert.deepEqual(result.parts, [{ kind: "original-content" }]);
});

test("an exact completed same-file receipt can compact the reported diff, but a warning cannot", (context) => {
  context.mock.method(performance, "now", () => 0);
  const request = edit.request({ path: "alpha.txt", edits: [{ oldText: "alpha one", newText: "first is longer now" },
    { oldText: "gamma three", newText: "last changed" }] });
  for (const [content, expected] of [[text, true], [text.replace(/\n/g, "\r\n"), true], [`${text}\nWarning: check output.`, false]] as const) {
    const result = edit.result({ isError: false, content: [{ kind: "text", text: content }] }, request);
    const plan = buildOperationPresentation(request, buildDiffPresentation(request, result));
    assert.equal(plan.collapsedInline === true, expected);
  }
  const result = edit.result({ isError: false, content: [{ kind: "text", text }] }, request);
  const streaming = buildOperationPresentation(request, buildDiffPresentation(request, result), {}, false);
  assert.equal(streaming.collapsedInline, undefined);
  assert.ok(streaming.remainder.context.some(part => part.kind === "diff" && part.placement === "inline"));
  const exhausted = buildOperationPresentation(request, buildDiffPresentation(request, result, { timeoutMs: 0 }), { timeoutMs: 0 });
  assert.equal(exhausted.collapsedInline, undefined);
  assert.ok(exhausted.remainder.context.some(part => part.kind === "diff" && part.placement === "inline"));
});

test("additional result blocks and failed output remain in their original order", () => {
  const request = edit.request({ path: "alpha.txt", edits: [{ oldText: "alpha one", newText: "first is longer now" },
    { oldText: "gamma three", newText: "last changed" }] });
  const result = edit.result({ isError: true, content: [
    { kind: "text", text: "Failed before this report." }, { kind: "text", text }, { kind: "text", text: "Warning afterwards." },
  ] }, request);
  assert.deepEqual(result.parts.map(part => part.kind), ["original-content", "text", "diff", "original-content"]);
  const plan = buildOperationPresentation(request, buildDiffPresentation(request, result));
  assert.equal(plan.collapsedInline, undefined);
});

test("images and unparsed text keep their positions around an embedded diff", () => {
  const request = edit.request({ path: "alpha.txt", edits: [{ oldText: "alpha one", newText: "first is longer now" }] });
  const result = edit.result({ isError: false, content: [
    { kind: "image", data: "fixture", mimeType: "image/png" }, { kind: "text", text }, { kind: "text", text: "Unparsed trailing output." },
  ] }, request);
  assert.deepEqual(result.parts.map(part => part.kind), ["original-content", "text", "diff", "original-content"]);
  assert.deepEqual(result.parts[0], { kind: "original-content", indexes: [0] });
  assert.deepEqual(result.parts.at(-1), { kind: "original-content", indexes: [2] });
});
