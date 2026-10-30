import assert from "node:assert/strict";
import test from "node:test";
import { wrapColumnUnits, wrapSlicedColumns } from "../../src/diff/column-wrap.ts";
import type { ColumnUnit } from "../../src/diff/column-wrap.ts";
import { renderDiffPresentation } from "../../src/diff/index.ts";
import type { DiffPresentation } from "../../src/diff/index.ts";

test("column packing retains spaces, zero-width content and complete wide units", () => {
  const units = [{ text: "á", columns: 1 }, { text: "界", columns: 2 }, { text: "👩🏽‍💻", columns: 2 },
    { text: " ", columns: 1 }, { text: " ", columns: 1 }, { text: "z", columns: 1 }, { text: "\u200b", columns: 0 }];
  assert.deepEqual(wrapColumnUnits(units, 2), ["á", "界", "👩🏽‍💻", "  ", "z\u200b"]);
  assert.deepEqual(wrapColumnUnits([{ text: "界", columns: 2 }], 1), ["界"]);
  assert.deepEqual(wrapColumnUnits([], 4), [""]);
  assert.deepEqual(wrapColumnUnits(units, 0), [""]);
});

test("forward packing consumes each unit once and keeps boundary controls with the next unit", () => {
  let visits = 0;
  function* units(): Iterable<ColumnUnit> {
    for (let index = 0; index < 10_000; index++) { visits++; yield { text: "x", columns: 1 }; }
  }
  const rows = wrapColumnUnits(units(), 7);
  assert.equal(visits, 10_000);
  assert.equal(rows.join(""), "x".repeat(10_000));
  assert.ok(rows.every(row => row.length <= 7));
  assert.deepEqual(wrapColumnUnits([{ text: "A", columns: 1 }, { text: "<style>", columns: 0 },
    { text: "B", columns: 1 }, { text: "</style>", columns: 0 }], 1), ["A", "<style>B</style>"]);
});

const presentation: DiffPresentation = {
  requestNotes: ["requested note with spaces"], context: [], applicationReports: [],
  units: [{ origin: "request", scope: { kind: "file", path: "long-file-name.txt" }, sections: [
    { kind: "raw", target: { path: "long-file-name.txt" }, sources: [{ text: "raw text with trailing spaces  " }] },
    { kind: "hunks", target: { path: "long-file-name.txt" }, hunks: [{ blocks: [
      { kind: "instruction", text: "producer instruction with spaces" },
      { kind: "context", text: "unchanged context with spaces", oldLine1: 7, newLine1: 8 },
      { kind: "change", pairs: [{ before: { text: "before text with spaces", line1: 8, emphasis: [] },
        after: { text: "after text with spaces", line1: 9, emphasis: [] } }] },
      { kind: "located-change", operation: "insert-after", locationLabel: "10#AB", after: [{ text: "located source with spaces", emphasis: [] }] },
    ] }] },
  ] }],
};

test("all layout siblings use the supplied wrapper while old custom slicers retain their behavior", () => {
  for (const layout of ["unified", "split", "auto"] as const) {
    const measure = (text: string) => text.length;
    let sliced = 0;
    const slice = (text: string, start: number, end: number) => { sliced++; return text.slice(start, end); };
    const options = { layout, visibleWidth: measure, sliceVisible: slice };
    const expected = renderDiffPresentation(presentation, 20, options);
    assert.ok(sliced > 0);
    sliced = 0;
    const wrapped: string[] = [];
    const actual = renderDiffPresentation(presentation, 20, { ...options, wrapVisible(text, width) {
      wrapped.push(text);
      return wrapColumnUnits(Array.from(text, text => ({ text, columns: 1 })), width);
    } });
    assert.deepEqual(actual, expected);
    assert.equal(sliced, 0);
    for (const text of ["requested note with spaces", "raw text with trailing spaces  ", "producer instruction with spaces",
      "unchanged context with spaces", "before text with spaces", "after text with spaces", "located source with spaces"]) {
      assert.ok(wrapped.includes(text));
    }
    assert.deepEqual(renderDiffPresentation(presentation, 20, { layout }), expected);
  }
  assert.deepEqual(wrapSlicedColumns("opaque", 2, text => text.length, () => ""), ["opaque"]);
});
