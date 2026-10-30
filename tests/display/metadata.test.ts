import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ReportedLocation, ResultPart } from "../../src/presentation.ts";
import { rankedSearchLines } from "../../src/display/ranked-search.ts";
import { locationLines } from "../../src/display/locations.ts";
import { locationText } from "../../src/display/text.ts";

const theme = { bold: (text: string) => text } as Theme;

test("rank scores have bounded significant precision without losing tiny nonzero values", () => {
  for (const [score, expected] of [[1.089231283737057, "1.09"], [1.25, "1.25"],
    [1e-20, "1.00e-20"], [1e20, "1.00e+20"], [0, "0.00"], [-0.00008972, "-0.0000897"]] as const) {
    const part: Extract<ResultPart, { kind: "ranked-files" }> = { kind: "ranked-files", query: "item",
      items: [{ path: "src/a.ts", score, hits: 2, firstLine1: 3, lastLine1: 5 }], coverage: { files: 4, truncated: false } };
    const original = structuredClone(part);
    assert.ok(rankedSearchLines(part, 100, theme, "").some(line => line.includes(`score ${expected})`)));
    assert.deepEqual(part, original);
    if (score !== 0) assert.notEqual(Number(expected), 0);
  }
});

test("unknown location units keep coordinates and exclusive endpoints without generated availability prose", () => {
  const location: ReportedLocation = { target: { kind: "file", path: "src/a.ts" }, indexBase: 0,
    line: 1, character: 2, characterUnit: "unreported", endExclusive: { line: 1, character: 5 } };
  const original = structuredClone(location);
  assert.equal(locationText(location), "src/a.ts:2:3–2:6 (end exclusive)");
  assert.deepEqual(locationLines([location], 100, theme, ""), ["src/a.ts (end exclusive)", "  L2:3–2:6"]);
  const { endExclusive: _end, ...point } = location;
  assert.equal(locationText(point), "src/a.ts:2:3");
  assert.deepEqual(locationLines([point], 100, theme, ""), ["src/a.ts", "  L2:3"]);
  assert.deepEqual(location, original);
});

test("known column units stay qualified and do not leak onto following unknown locations", () => {
  const known: ReportedLocation = { target: { kind: "file", path: "src/a.ts" }, indexBase: 0,
    line: 1, character: 2, characterUnit: "utf16" };
  const unknown: ReportedLocation = { ...known, characterUnit: "unreported" };
  assert.equal(locationText(known), "src/a.ts:2:3 (UTF-16 column)");
  assert.deepEqual(locationLines([known, unknown], 100, theme, ""), [
    "src/a.ts (UTF-16 columns)", "  L2:3", "src/a.ts", "  L2:3",
  ]);
  const { character: _character, ...lineOnly } = known;
  assert.equal(locationText(lineOnly), "src/a.ts:2");
});
