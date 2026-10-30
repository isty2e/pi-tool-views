import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderToolDiff } from "../../src/display/diff.ts";
import { defaults } from "../../src/settings/model.ts";
import type { DiffCell, DiffPresentation } from "../../src/diff/index.ts";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
initTheme("dark", false);
const theme = { colors: { toolDiffRemoved: parseColor("#ee5555"), toolDiffAdded: parseColor("#55ee88"),
  toolErrorBg: parseColor("#181010"), toolSuccessBg: parseColor("#101810") }, getColorMode: () => "truecolor",
  fg: (_key: string, text: string) => text } as unknown as Theme;

function twoFragments(gap: string, first = "A", last = "B"): DiffCell {
  return { text: `q${first}${gap}${last}z`, emphasis: [
    { startUtf16: 1, endUtf16: 2 }, { startUtf16: 2 + gap.length, endUtf16: 3 + gap.length },
  ] };
}

function plan(before: DiffCell, after?: DiffCell, path = "sample.opaque"): DiffPresentation {
  return { units: [{ scope: { kind: "file", path }, origin: "reported", sections: [
    { kind: "hunks", target: { path }, hunks: [{ blocks: [{ kind: "change", pairs: [{ before, ...(after ? { after } : {}) }] }] }] },
  ] }], context: [], applicationReports: [] };
}

async function painted(value: DiffPresentation, samples: readonly { text: string; anchor?: number }[], gap?: number,
  diffMode: "unified" | "split" = "unified", width = 120, diffRowBackground = false) {
  const settings = { ...defaults, diffMode, lineNumbers: false, diffRowBackground, ...(gap === undefined ? {} : { diffEmphasisGap: gap }) };
  const rows = renderToolDiff(value, width, settings, theme, undefined, true);
  assert.ok(rows.every(row => visibleWidth(row) <= width));
  const terminal = new Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
    return samples.map(sample => {
      const rowIndex = rows.findIndex(row => stripTerminalSequences(row).includes(sample.text));
      assert.ok(rowIndex >= 0, `missing source ${sample.text}`);
      const text = stripTerminalSequences(rows[rowIndex]!);
      const start = visibleWidth(text.slice(0, text.indexOf(sample.text)));
      const line = terminal.buffer.active.getLine(rowIndex)!;
      const anchor = line.getCell(start + visibleWidth(sample.text.slice(0, sample.anchor ?? 1)))!;
      assert.ok(!anchor.isBgDefault());
      const cells = Array.from({ length: visibleWidth(sample.text) }, (_, column) => line.getCell(start + column)!);
      return { mask: cells.map(cell => !cell.isBgDefault() && cell.getBgColor() === anchor.getBgColor() ? "1" : "0").join(""),
        foreground: cells.map(cell => [cell.isFgDefault(), cell.getFgColor()]) };
    });
  } finally { terminal.dispose(); }
}

test("default coalescing bridges a paired common region and redraws back to zero", async () => {
  const before = twoFragments("xy"), after = twoFragments("xy", "C", "D");
  const value = plan(before, after), original = structuredClone(value);
  const samples = [{ text: before.text }, { text: after.text }];
  for (const mode of ["unified", "split"] as const) {
    assert.deepEqual((await painted(value, samples, 0, mode)).map(x => x.mask), ["010010", "010010"]);
    assert.deepEqual((await painted(value, samples, undefined, mode)).map(x => x.mask), ["011110", "011110"]);
    assert.deepEqual((await painted(value, samples, 3, mode)).map(x => x.mask), ["011110", "011110"]);
    assert.deepEqual((await painted(value, samples, 0, mode)).map(x => x.mask), ["010010", "010010"]);
  }
  assert.deepEqual(value, original);
});

test("gap distance counts complete Unicode graphemes instead of UTF-16 units or display columns", async () => {
  for (const gap of ["e\u0301", "👍🏽", "👩‍💻", "界"]) {
    const cell = twoFragments(gap), value = plan(cell);
    const merged = await painted(value, [{ text: cell.text }], 1);
    assert.equal(merged[0]!.mask, "0" + "1".repeat(visibleWidth(cell.text) - 2) + "0");
    const separate = await painted(value, [{ text: cell.text }], 0);
    assert.equal(separate[0]!.mask, "01" + "0".repeat(visibleWidth(gap)) + "10");
  }
});

test("coalescing is transitive but never expands isolated changes or crosses source cells", async () => {
  const chain: DiffCell = { text: "qAxyBzCw", emphasis: [
    { startUtf16: 1, endUtf16: 2 }, { startUtf16: 4, endUtf16: 5 }, { startUtf16: 6, endUtf16: 7 },
  ] };
  assert.equal((await painted(plan(chain), [{ text: chain.text }], 2))[0]!.mask, "01111110");
  const text = "a".repeat(100) + "X" + "b".repeat(100);
  const isolated: DiffCell = { text, emphasis: [{ startUtf16: 100, endUtf16: 101 }] };
  assert.equal((await painted(plan(isolated), [{ text, anchor: 100 }], Number.MAX_SAFE_INTEGER, "unified", 240))[0]!.mask,
    "0".repeat(100) + "1" + "0".repeat(100));
  const first: DiffCell = { text: "qAxx", emphasis: [{ startUtf16: 1, endUtf16: 2 }] };
  const second: DiffCell = { text: "rByy", emphasis: [{ startUtf16: 1, endUtf16: 2 }] };
  const value: DiffPresentation = { units: [{ scope: { kind: "call" }, origin: "reported", sections: [{ kind: "hunks", hunks: [
    { blocks: [{ kind: "change", pairs: [{ before: first }, { before: second }] }] },
  ] }] }], context: [], applicationReports: [] };
  assert.deepEqual((await painted(value, [{ text: first.text }, { text: second.text }], 100)).map(x => x.mask), ["0100", "0100"]);
});

test("distance uses visible normalized text, ignoring controls and retaining fixed tab expansion", async () => {
  const raw = "qA\x1b[31mxy\x1b[39mBz";
  const controlled: DiffCell = { text: raw, emphasis: [{ startUtf16: 1, endUtf16: 2 },
    { startUtf16: raw.indexOf("B"), endUtf16: raw.indexOf("B") + 1 }] };
  assert.equal((await painted(plan(controlled), [{ text: "qAxyBz" }], 2))[0]!.mask, "011110");
  const tab = twoFragments("\t");
  assert.equal((await painted(plan(tab), [{ text: "qA    Bz" }], 2))[0]!.mask, "01000010");
  assert.equal((await painted(plan(tab), [{ text: "qA    Bz" }], 4))[0]!.mask, "01111110");
});

test("bridging preserves syntax foregrounds, faint-row treatment and layout geometry", async () => {
  const before: DiffCell = { text: "const bxdy = 1;", emphasis: [{ startUtf16: 6, endUtf16: 7 },
    { startUtf16: 8, endUtf16: 9 }, { startUtf16: 13, endUtf16: 14 }] };
  const after = { ...before, text: "const cxey = 2;" };
  const value = plan(before, after, "module.ts"), samples = [{ text: before.text, anchor: 6 }, { text: after.text, anchor: 6 }];
  for (const mode of ["unified", "split"] as const) for (const rowBackground of [false, true]) {
    const exact = await painted(value, samples, 0, mode, 80, rowBackground);
    const grouped = await painted(value, samples, 2, mode, 80, rowBackground);
    assert.deepEqual(grouped.map(x => x.foreground), exact.map(x => x.foreground));
    assert.ok(grouped[0]!.foreground.some(([isDefault]) => !isDefault));
    assert.equal(exact[0]!.mask.slice(6, 9), "101");
    assert.equal(grouped[0]!.mask.slice(6, 9), "111");
    assert.equal(grouped[0]!.mask[0], "0");
  }
  const narrow = await painted(plan(twoFragments("xy")), [{ text: "qAxyBz" }], 2, "split", 30);
  assert.equal(narrow[0]!.mask, "011110");
});

test("a grouped region keeps its background across physical wrap boundaries", async () => {
  const value = plan(twoFragments("xy"));
  for (const [diffMode, width] of [["unified", 6], ["split", 14]] as const) {
    const rows = renderToolDiff(value, width, { ...defaults, diffMode, lineNumbers: false }, theme, undefined, true);
    assert.ok(rows.length > 1 && rows.every(row => visibleWidth(row) <= width));
    const terminal = await new Promise<InstanceType<typeof Terminal>>(resolve => {
      const terminal = new Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
      terminal.write(rows.join("\r\n"), () => resolve(terminal));
    });
    try {
      const content = [];
      for (let row = 0; row < rows.length; row++) {
        const line = terminal.buffer.active.getLine(row)!;
        for (let column = 0; column < width; column++) {
          const cell = line.getCell(column)!;
          if (cell.getChars() === "│") break;
          if ("qAxyBz".includes(cell.getChars()) && cell.getChars()) content.push(cell);
        }
      }
      assert.equal(content.map(cell => cell.getChars()).join(""), "qAxyBz");
      const strong = content[1]!;
      assert.ok(!strong.isBgDefault());
      assert.equal(content.map(cell => !cell.isBgDefault() && cell.getBgColor() === strong.getBgColor() ? "1" : "0").join(""), "011110");
    } finally { terminal.dispose(); }
  }
});
