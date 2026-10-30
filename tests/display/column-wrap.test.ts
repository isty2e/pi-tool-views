import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { wrapPaintedColumns } from "../../src/display/column-wrap.ts";
import { wrapSlicedColumns } from "../../src/diff/column-wrap.ts";
import { isolateStyles } from "../../src/display/text.ts";
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
const legacy = (text: string, width: number) => wrapSlicedColumns(text, width, visibleWidth,
  (value, start, end) => isolateStyles(sliceByColumn(value, start, end - start, true)));

async function cells(rows: readonly string[]) {
  const terminal = new Terminal({ cols: 256, rows: rows.length + 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
    return rows.map((row, line) => Array.from({ length: visibleWidth(row) }, (_, column) => {
      const cell = terminal.buffer.active.getLine(line)!.getCell(column)!;
      return [cell.getChars(), cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
        cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isBlink(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough()];
    }));
  } finally { terminal.dispose(); }
}

test("forward painted wrapping preserves bounded legacy terminal-cell attributes and whitespace", async () => {
  const samples = ["abc def ghi  ", "A界B😀C", "á👩🏽‍💻z", "\x1b[31mabc def ghij\x1b[0m",
    "\x1b[1;2;3;4;5;7;8;9;38;2;1;2;3;48;5;200mabc defgh\x1b[0m", "a\x1b[31mbcd\x1b[39mefgh",
    "\x1b[90;107mabc\x1b[22;23;24;25;27;28;29;39;49mdefgh"];
  for (const sample of samples) for (const width of [2, 3, 5, 10]) {
    const actual = wrapPaintedColumns(sample, width), expected = legacy(sample, width);
    assert.deepEqual(actual.map(stripTerminalSequences), expected.map(stripTerminalSequences));
    assert.deepEqual(await cells(actual), await cells(expected));
    assert.equal(actual.map(stripTerminalSequences).join(""), stripTerminalSequences(sample));
  }
});

test("opaque or noncanonical styles keep their original slicing interpretation", () => {
  const samples = ["\x1b[21mabcdefgh\x1b[24m", "\x1b[58;2;1;2;3mabcdefgh\x1b[59m",
    "\x1b[53mabcdefgh\x1b[55m", "\x1b[38:2::1:2:3mabcdefgh", "\x1b[1;;31mabcdefgh",
    "\x1b[38;02;1;2;3mabcdefgh", "\x1b[38;2;1mabcdefgh", "\x1b[38;5;256mabcdefgh", "a\tbcd", "ab\ncd", "ab\rcd",
    "\x1b[2Kabcdefgh", "\x1b]8;unterminatedabcdefgh", "\x1b]8;invalid\x07abcdefgh",
    "\x1b]8;;https://example.test/\npath\x07abcdefgh"];
  for (const sample of samples) assert.deepEqual(wrapPaintedColumns(sample, 2), legacy(sample, 2));
  assert.deepEqual(wrapPaintedColumns("\x1b[21mabc", 20), ["\x1b[21mabc"]);
  assert.deepEqual(wrapPaintedColumns("content", 0), [""]);
});

test("colored wide glyphs and ANSI-transparent graphemes are not lost at narrow cuts", async () => {
  const wide = wrapPaintedColumns("\x1b[31m界abc\x1b[0m", 1);
  assert.deepEqual(wide.map(stripTerminalSequences), ["界", "a", "b", "c"]);
  const source = "a\x1b[31ḿbcd";
  const combining = wrapPaintedColumns(source, 1);
  assert.deepEqual(combining.map(stripTerminalSequences), ["á", "b", "c", "d"]);
  assert.deepEqual((await cells(combining))[0], (await cells([source]))[0]!.slice(0, 1));
  assert.equal(wide.map(stripTerminalSequences).join(""), "界abc");
});

test("wrapped source isolates terminal styles from following gutters", async () => {
  const rows = wrapPaintedColumns("\x1b[1;31;42mabcdef\x1b[0m", 2).map(row => row + "│");
  const rendered = await cells(rows);
  for (const row of rendered) {
    const separator = row.at(-1)!;
    assert.equal(separator[0], "│");
    assert.equal(separator[2], 0);
    assert.equal(separator[4], 0);
    assert.equal(!!separator[6], false);
  }
});

test("wrapped hyperlinks preserve reopening terminators and close before the gutter", () => {
  for (const terminator of ["\x07", "\x1b\\"]) {
    const open = `\x1b]8;id=source;https://example.test${terminator}`;
    const close = `\x1b]8;;${terminator}`;
    const rows = wrapPaintedColumns(`${open}abcdef${close}`, 2);
    assert.deepEqual(rows.map(stripTerminalSequences), ["ab", "cd", "ef"]);
    for (const row of rows) {
      assert.ok(row.includes(open));
      assert.ok(row.lastIndexOf(close) > row.indexOf(open));
    }
  }
});
