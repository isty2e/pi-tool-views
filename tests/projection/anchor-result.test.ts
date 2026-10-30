import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import type { RequestView, SuppliedToolResult } from "../../src/presentation.ts";

const projection = compileProjection({ description: "Edit anchored lines", input: { kind: "json", schema: {
  type: "object", required: ["path", "edits"], properties: { path: { type: "string" }, edits: { type: "array", items: {
    anyOf: [{ type: "object", required: ["op", "pos", "lines"], properties: {
      op: { type: "string", enum: ["replace"] }, pos: { type: "string", description: "Start anchor" },
      lines: { type: "array", items: { type: "string" } },
    } }],
  } } },
} } });
const args = { path: "src/math.ts", edits: [{ op: "replace", pos: "3#WB", lines: ["new"] }] };
const request = projection.request(args);
const diff = "  1#WY:before\n  2#HJ:\n- 3    old\n+ 3#MP:new\n  4#HQ:after";
const anchors = "--- Anchors 1-4 ---\n1#WY:before\n2#HJ:\n3#MP:new\n4#HQ:after";

function supplied(text = anchors): SuppliedToolResult {
  return { content: [{ kind: "text", text }], details: { classification: "applied", diff }, isError: false };
}

test("reported edits omit the model-facing anchor block but keep independent output and the supplied result", () => {
  const result = supplied(`${anchors}\n\nWarnings:\nchanged elsewhere`);
  const before = structuredClone(result);
  const view = projection.result(result, request);
  assert.deepEqual(result, before);
  assert.ok(view.parts.some(part => part.kind === "diff" && part.origin === "reported"));
  assert.ok(view.parts.some(part => part.kind === "text" && part.text === "Warnings:\nchanged elsewhere"));
  assert.ok(!view.parts.some(part => part.kind === "original-content"));
  assert.ok(!projection.result(supplied(), request).parts.some(part => part.kind === "original-content"));
});

test("unrecognized, incomplete, failed or unassociated anchor results remain original", () => {
  const cases: { result: SuppliedToolResult; request: RequestView }[] = [
    { result: supplied(anchors.replace("4#HQ:after", "bad row")), request },
    { result: { ...supplied(), details: { classification: "applied", diff: "not a diff" } }, request },
    { result: { ...supplied(), details: { classification: "noop", diff } }, request },
    { result: { ...supplied(), isError: true }, request },
    { result: { ...supplied(), content: [{ kind: "text", text: "Anchors omitted; use read for subsequent edits." }] }, request },
    { result: supplied(), request: { kind: "change.replacements", requestedEdits: [
      { path: "a", oldText: "old", newText: "new" }, { path: "b", oldText: "old", newText: "new" },
    ] } },
  ];
  for (const item of cases) assert.ok(projection.result(item.result, item.request).parts.some(part => part.kind === "original-content"));
});
