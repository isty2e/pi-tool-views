import assert from "node:assert/strict";
import test from "node:test";
import { asObject, toJson } from "../src/json.ts";

test("JSON ingress preserves values without mutating input", () => {
  const input = Object.freeze({ text: "e\u0301\r\n", values: Object.freeze([null, false, 0]), absent: undefined });
  assert.deepEqual(toJson(input), { text: "e\u0301\r\n", values: [null, false, 0] });
  assert.equal(input.absent, undefined);
  assert.equal(asObject(toJson(input))?.text, input.text);
  assert.equal(asObject(null), undefined);
  assert.equal(asObject([]), undefined);
});

test("unsupported values do not manufacture valid JSON", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.equal(toJson(cycle), undefined);
  assert.equal(toJson([undefined]), undefined);
  assert.equal(toJson(Number.NaN), undefined);
  assert.equal(toJson(new Date()), undefined);
});

test("JSON ingress does not invoke a producer getter", () => {
  let calls = 0;
  const input = Object.defineProperty({}, "value", { enumerable: true, get() { calls++; return "side effect"; } });
  assert.equal(toJson(input), undefined);
  assert.equal(calls, 0);

  const array = Object.defineProperty([0], "0", { get() { calls++; return "side effect"; } });
  assert.equal(toJson(array), undefined);
  assert.equal(calls, 0);
});

test("repeated references are serializable while cycles are not", () => {
  const item = { value: 1 };
  assert.deepEqual(toJson([item, item]), [{ value: 1 }, { value: 1 }]);
  const input = JSON.parse('{"__proto__":{"safe":true}}');
  const output = asObject(toJson(input));
  assert.deepEqual(output?.["__proto__"], { safe: true });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
});
