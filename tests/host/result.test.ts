import assert from "node:assert/strict";
import test from "node:test";
import { suppliedResult } from "../../src/host/result.ts";

test("uninterpretable metadata does not erase supplied text or native images", () => {
  const content = [{ type: "text", text: "actual body" }, { type: "image", data: "pixel", mimeType: "image/png" }];
  const result = suppliedResult({ content, details: new Error("non-JSON metadata"), structuredContent: { marker: "stored" } }, false);
  assert.deepEqual(result.content, [{ kind: "text", text: "actual body" }, { kind: "image", data: "pixel", mimeType: "image/png" }]);
  assert.equal(result.details, undefined);
  assert.deepEqual(result.structuredContent, { marker: "stored" });
});

test("unavailable content preserves its slot and neighboring data without invoking getters", () => {
  let getters = 0;
  const inaccessible = Object.defineProperty({}, "value", { enumerable: true, get() { getters++; return "never"; } });
  const result = suppliedResult({ content: [{ type: "text", text: "first" }, inaccessible, { type: "text", text: "third" }] }, false);
  assert.deepEqual(result.content, [{ kind: "text", text: "first" }, { kind: "unavailable" }, { kind: "text", text: "third" }]);
  assert.equal(getters, 0);
});
