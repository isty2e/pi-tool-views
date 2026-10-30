import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { defaults } from "../../src/settings/model.ts";

initTheme("light", false);
const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  colors: { toolDiffRemoved: parseColor("#cc0000"), toolDiffAdded: parseColor("#008800"),
    toolErrorBg: parseColor("#ffffff"), toolSuccessBg: parseColor("#ffffff") },
  getColorMode: () => "truecolor",
} as unknown as Theme;

test("wrapped highlighted diffs do not replay an increasing history of terminal styles", () => {
  const encodedSize = (count: number) => {
    const plan = buildDiffPresentation({ kind: "change.replacements", requestedEdits: [{
      path: "fixture.js", oldText: "value += 1; ".repeat(count), newText: "value += 2; ".repeat(count),
    }] }, undefined, { maxComparisonTokens: 1 });
    return renderToolDiff(plan, 80, { ...defaults, diffMode: "split" }, theme).reduce((sum, row) => sum + row.length, 0);
  };
  const small = encodedSize(96), large = encodedSize(192);
  assert.ok(large < small * 3, `doubling source should not approach quadratic encoded output: ${small} -> ${large}`);
});

test("narrow Split retains colored wide source characters through its layout fallback", () => {
  const plan = buildDiffPresentation({ kind: "change.replacements", requestedEdits: [{
    path: "fixture.txt", oldText: "界x", newText: "界y",
  }] }, undefined, { maxComparisonTokens: 1 });
  const rows = renderToolDiff(plan, 7, { ...defaults, diffMode: "split", lineNumbers: false }, theme);
  assert.equal(rows.map(stripTerminalSequences).join("").split("界").length - 1, 2);
  assert.ok(rows.every(row => visibleWidth(row) <= 7));
});
