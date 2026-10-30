import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createRequire } from "node:module";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { compareText, createComparisonBudget } from "../../src/diff/compare.ts";
import type { DiffPresentation } from "../../src/diff/model.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { defaults } from "../../src/settings/model.ts";
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
initTheme("dark", false);
const theme = { colors: { toolDiffRemoved: parseColor("#ee5555"), toolDiffAdded: parseColor("#55ee88"),
  toolErrorBg: parseColor("#181010"), toolSuccessBg: parseColor("#101810") }, getColorMode: () => "truecolor",
  fg: (_role: string, value: string) => value } as unknown as Theme;

function compared(before: string, after: string): DiffPresentation {
  const clock = mock.method(performance, "now", () => 0);
  try {
    const comparison = compareText(before, after, createComparisonBudget());
    assert.equal(comparison.coarse, false);
    assert.ok(comparison.hunk);
    return { units: [{ scope: { kind: "file", path: "a.opaque" }, origin: "reported",
      sections: [{ kind: "hunks", hunks: [comparison.hunk] }] }], context: [], applicationReports: [] };
  } finally { clock.mock.restore(); }
}

async function remaining(value: DiffPresentation, samples: readonly string[], gap: number, mode: "unified" | "split") {
  const width = 300;
  const rows = renderToolDiff(value, width, { ...defaults, lineNumbers: false, diffMode: mode, diffEmphasisGap: gap }, theme, undefined, true);
  const terminal = new Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
    return samples.map(text => {
      for (let row = 0; row < rows.length; row++) {
        const line = terminal.buffer.active.getLine(row)!;
        const cells = [];
        let rendered = "";
        for (let column = 0; column < width; column++) {
          const cell = line.getCell(column)!;
          if (!cell.getWidth()) continue;
          const start = rendered.length;
          rendered += cell.getChars() || " ";
          cells.push({ start, end: rendered.length, text: cell.getChars() || " ", defaultBackground: !!cell.isBgDefault() });
        }
        const offset = rendered.indexOf(text);
        if (offset < 0) continue;
        const common: string[] = [], changed: string[] = [];
        for (const cell of cells.filter(cell => cell.start >= offset && cell.end <= offset + text.length))
          (cell.defaultBackground ? common : changed).push(cell.text);
        return { common: common.join(""), changed: changed.join("") };
      }
      assert.fail(`Source row not rendered: ${text}`);
    });
  } finally { terminal.dispose(); }
}

test("coalescing is one replacement: alpha one becomes alpha changed without leaving ne behind", async () => {
  const value = compared("alpha one", "alpha changed"), exact = structuredClone(value);
  for (const mode of ["unified", "split"] as const) {
    const before = await remaining(value, ["alpha one", "alpha changed"], 0, mode);
    assert.equal(before[0]!.common, before[1]!.common);
    const grouped = await remaining(value, ["alpha one", "alpha changed"], 2, mode);
    assert.deepEqual(grouped, [{ common: "alpha ", changed: "one" }, { common: "alpha ", changed: "changed" }]);
    assert.deepEqual(await remaining(value, ["alpha one", "alpha changed"], 0, mode), before);
  }
  assert.deepEqual(value, exact);
});

test("joint groups include counterparts without original spans and preserve Unicode/common-text order", async () => {
  const examples = [["qAxyBz", "qxyz"], ["qxyz", "qAxyBz"], ["qAéBz", "qCéDz"],
    ["aX🙂Yb", "a🙂b"], ["qAéBz", "qCéDz"], ["repeated one one", "repeated changed one"],
    ["aX1Y2Zb", "aC1D2Eb"], ["x".repeat(50) + "A" + "y".repeat(40), "x".repeat(50) + "B" + "y".repeat(40)]];
  for (const [before, after] of examples) {
    const value = compared(before!, after!);
    for (const mode of ["unified", "split"] as const) for (const gap of [0, 1, 2]) {
      const sides = await remaining(value, [before!, after!], gap, mode);
      assert.equal(sides[0]!.common, sides[1]!.common, JSON.stringify({ before, after, mode, gap, sides }));
    }
  }
});

test("normalization cannot leave half a displayed grapheme or mismatched shared text", async () => {
  for (const [before, after, oldVisible, newVisible] of [
    ["a\x1b[31ḿX", "b\x1b[31ḿX", "áX", "b́X"],
    ["\x1b[31mA", "[31mB", "A", "[31mB"],
  ]) {
    const value = compared(before!, after!), original = structuredClone(value);
    for (const mode of ["unified", "split"] as const) for (const gap of [0, 2]) {
      const sides = await remaining(value, [oldVisible!, newVisible!], gap, mode);
      assert.equal(sides[0]!.common, sides[1]!.common);
    }
    assert.deepEqual(value, original);
  }
});
