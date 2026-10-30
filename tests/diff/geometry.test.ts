import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { defaults } from "../../src/settings/model.ts";
import type { ChangedLinePair, DiffCell } from "../../src/diff/model.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

test("explicit narrow Split keeps both sides and never truncates known line numbers", () => {
  const plan = buildDiffPresentation({ kind: "change.replacements", requestedEdits: [{ path: "file.ts", oldText: "👍old", newText: "👍🏽new" }] }, undefined);
  for (const width of [5, 6, 7, 8, 12, 24, 80]) {
    const rows = renderDiffPresentation(plan, width, { layout: "split" });
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    assert.ok(rows.some(row => row.includes("│")));
  }
  assert.throws(() => renderDiffPresentation(plan, 3, { layout: "split" }), RangeError);
});

test("missing grapheme segmentation keeps full-text emphasis instead of failing module loading", () => {
  const url = new URL("../../src/diff/index.ts", import.meta.url).href;
  const script = `Intl.Segmenter = undefined; const {buildDiffPresentation} = await import(${JSON.stringify(url)}); const p = buildDiffPresentation({kind:'change.replacements',requestedEdits:[{path:'a',oldText:'👍',newText:'👍🏽'}]},undefined); console.log(JSON.stringify(p));`;
  const plan = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.equal(plan.units[0].coarseComparison, true);
  const blocks = plan.units[0].sections[0].hunks[0].blocks;
  const changed = blocks.find((block: { kind: string }) => block.kind === "change");
  const before: DiffCell[] = changed.pairs.flatMap((pair: ChangedLinePair) => pair.before ? [pair.before] : []);
  const after: DiffCell[] = changed.pairs.flatMap((pair: ChangedLinePair) => pair.after ? [pair.after] : []);
  assert.deepEqual(before.map(cell => [cell.text, cell.emphasis]), [["👍", [{ startUtf16: 0, endUtf16: 2 }]]]);
  assert.deepEqual(after.map(cell => [cell.text, cell.emphasis]), [["👍🏽", [{ startUtf16: 0, endUtf16: 4 }]]]);
});

test("unconfirmed patch text cannot acquire invented numbered-diff positions", () => {
  const plan = buildDiffPresentation({ kind: "change.patch", format: "unconfirmed", text: "+123 literal source" }, undefined);
  assert.equal(plan.units[0]?.sections[0]?.kind, "raw");
  const section = plan.units[0]?.sections[0];
  assert.equal(section?.kind === "raw" ? section.sources[0].text : undefined, "+123 literal source");
});

test("raw diff fallback strips terminal commands even when the host has no palette API", () => {
  const plan = buildDiffPresentation({ kind: "change.patch", format: "unconfirmed", text: "invalid\n\x1b]52;c;payload\x07" }, undefined);
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
  const rows = renderToolDiff(plan, 80, defaults, theme);
  assert.ok(rows.some(row => row.includes("invalid")));
  assert.ok(rows.every(row => !row.includes("\x1b]52")));
});
