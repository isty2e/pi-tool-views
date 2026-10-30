import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import { titleFacts } from "../../src/display/title.ts";
import type { EffectiveDeclaration, SuppliedToolResult } from "../../src/presentation.ts";

const declaration: EffectiveDeclaration = { description: "Read a text file as `anchor│content` rows: a 5-character lowercase anchor (letters only), `│`, then the line.",
  input: { kind: "json", schema: { type: "object", required: ["path"], properties: {
    path: { type: "string", description: "Path to the file to read" },
    offset: { anyOf: [{ type: "integer" }, { type: "string" }], description: "Line number (1-indexed) or a served anchor" },
    limit: { type: "integer", description: "Maximum number of lines to read" },
  } } } };
const text = "ajivo│function add() {\noutwa│  return 1;\nlkodo│}\n\n[Showing lines 3-5 of 19. Use offset=lkodo to continue.]";
const result: SuppliedToolResult = { isError: false, content: [{ kind: "text", text }], details: { offset: 3, nextOffset: 6,
  metrics: { truncated: false, next_offset: 6 } } };

test("read results retain supplied line numbers and identifiers without repeating the range footer", () => {
  const projection = compileProjection(declaration);
  const request = projection.request({ path: "src/math.ts", offset: "someid", limit: 3 });
  assert.deepEqual(projection.result(result, request).parts, [{ kind: "source", path: "src/math.ts", source: {
    text: "function add() {\n  return 1;\n}", firstLine1: 3, lineIdentifiers: ["ajivo", "outwa", "lkodo"],
  } }]);
  assert.equal(titleFacts("read", request, projection.result(result, request), true, true, false, false, false).target, "src/math.ts (L3–5)");
});

test("inconsistent and truncated reads retain their original output", () => {
  const projection = compileProjection(declaration);
  const request = projection.request({ path: "src/math.ts", offset: 3, limit: 3 });
  for (const variant of [
    { ...result, isError: true },
    { ...result, details: { offset: 4, nextOffset: 6, metrics: { truncated: false } } },
    { ...result, details: { offset: 3, nextOffset: 6, metrics: { truncated: true } } },
    { ...result, details: { offset: 3, nextOffset: 6, truncation: { truncated: true }, metrics: { truncated: false } } },
    { ...result, details: { offset: 3, nextOffset: 6, metrics: { truncated: false, next_offset: 7 } } },
    { ...result, content: [{ kind: "text" as const, text: text.replace("offset=lkodo", "offset=other") }] },
  ]) assert.deepEqual(projection.result(variant, request).parts, [{ kind: "original-content" }]);
});
