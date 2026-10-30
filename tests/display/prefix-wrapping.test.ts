import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { structuredLines } from "../../src/display/structured.ts";
import { outlineLines } from "../../src/display/outline.ts";
import { rankedSearchLines } from "../../src/display/ranked-search.ts";
import { locationLines } from "../../src/display/locations.ts";
import { markupLines } from "../../src/display/markup.ts";
import { sourceLines, wrap } from "../../src/display/text.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
const plain = (rows: readonly string[]) => rows.map(stripTerminalSequences);
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

test("structured fields and array values retain their owned continuation prefixes", () => {
  const value = { records: ["A".repeat(40), "B".repeat(32)] };
  const original = structuredClone(value);
  const rows = plain(structuredLines(value, 16));
  assert.equal(rows[0], "records:");
  assert.equal(rows.filter(row => row.startsWith("  - ")).length, 2);
  assert.ok(rows.slice(1).every(row => row.startsWith("  - ") || row.startsWith("    ")));
  assert.equal(rows.slice(1).map(row => row.slice(4)).join(""), value.records.map(item => JSON.stringify(item)).join(""));
  const fields = plain(structuredLines({ outer: { field: "X".repeat(35) }, tail: 1 }, 18));
  const last = fields.findIndex(row => row.startsWith("tail:"));
  assert.ok(last > 1);
  assert.ok(fields.slice(1, last).every(row => row.startsWith("       ")));
  assert.deepEqual(value, original);
});

test("outline, ranked rows and grouped coordinates preserve their renderer-owned hierarchy", () => {
  const name = "CHILD".repeat(9);
  const outline = plain(outlineLines({ kind: "code-outline", path: "src/a.ts", items: [
    { kind: "symbol", name: "Parent", children: [{ kind: "symbol", name, range: { firstLine1: 3 }, children: [] }] },
  ] }, 20, theme, ""));
  const child = outline.findIndex(row => row.startsWith("    L3 "));
  assert.ok(child >= 0);
  assert.ok(outline.slice(child + 1).every(row => row.startsWith("       ")));
  assert.equal(outline.slice(child).map(row => row.slice(7)).join(""), name);
  const ranked = plain(rankedSearchLines({ kind: "ranked-files", query: "x", items: [
    { path: "src/a.ts", score: 1.25, hits: 2, firstLine1: 3, lastLine1: 5 },
  ], coverage: { files: 4, truncated: false } }, 19, theme, ""));
  const first = ranked.findIndex(row => row.startsWith("  1. "));
  const footer = ranked.findIndex(row => row.startsWith("Index covers"));
  assert.ok(first >= 0 && footer > first + 1);
  assert.ok(ranked.slice(first + 1, footer).every(row => row.startsWith("     ")));
  const locations = plain(locationLines([{ target: { kind: "file", path: "a.ts" }, line: 99999, character: 99999,
    endExclusive: { line: 99999, character: 99999 }, indexBase: 1, characterUnit: "unreported" }], 14, theme, ""));
  const start = locations.findIndex(row => row.startsWith("  L"));
  assert.ok(start >= 0 && locations.slice(start).every(row => row.startsWith("  ")));
  assert.equal(locations.slice(start).map(row => row.slice(2)).join(""), "L99999:99999–99999:99999");
});

test("admitted prose preserves indentation and Markdown list markers without inferring plaintext lists", () => {
  const text = "  1. " + "A".repeat(30) + "\n  2. " + "B".repeat(24);
  const markdown = { kind: "markup", format: "markdown", text } as const;
  const rows = plain(markupLines(markdown, 17, theme));
  assert.equal(rows.filter(row => /^ {2}[12]\. /.test(row)).length, 2);
  assert.ok(rows.every(row => /^ {2}[12]\. /.test(row) || row.startsWith("     ")));
  assert.equal(rows.map(row => row.slice(5)).join(""), "A".repeat(30) + "B".repeat(24));
  const literal = plain(markupLines({ kind: "markup", format: "plaintext", text: "  1. " + "C".repeat(35) }, 17, theme));
  assert.ok(literal.slice(1).every(row => row.startsWith("  ") && !row.startsWith("     ")));
  assert.equal(markdown.text, text);
});

test("prefixed prose and field colors survive hard/soft breaks and host resets", async () => {
  const prose = "\x1b[32m  1. " + "G".repeat(35) + "\n  2. " + "G".repeat(24) + "\x1b[39m\nnormal";
  const coloredField = { ["\x1b[32mfield"]: { value: "G".repeat(32) } };
  for (const rows of [markupLines({ kind: "markup", format: "markdown", text: prose }, 18, theme), structuredLines(coloredField, 18)]) {
    const terminal = new Terminal({ cols: 18, rows: rows.length + 2, allowProposedApi: true });
    try {
      await new Promise<void>(resolve => terminal.write(rows.map(row => "\x1b[0m" + row + "\x1b[0m").join("\r\n"), resolve));
      const texts = plain(rows);
      assert.ok(texts.slice(1).some(row => row.startsWith("     ") || row.startsWith("       ")));
      for (const [index, text] of texts.entries()) {
        const line = terminal.buffer.active.getLine(index)!;
        assert.equal(line.translateToString(true), text.trimEnd());
        for (let column = 0; column < text.length; column++) {
          if (text[column] === "G") assert.equal(line.getCell(column)!.getFgColor(), 2);
          if (text === "normal") assert.ok(line.getCell(column)!.isFgDefault());
        }
      }
    } finally { terminal.dispose(); }
  }
});

test("source, ambiguous markup and unknown text retain ordinary wrapping; narrow prefixes preserve data", () => {
  const code = "  VALUE".repeat(8);
  assert.deepEqual(markupLines({ kind: "markup", format: "markdown", text: "```\n" + code + "\n```" }, 18, theme),
    sourceLines({ text: code }, undefined, 18, false, theme));
  for (const text of ["prose\n```\n" + code + "\n```", "    " + code, "~~fixture~~\n```unclosed"]) {
    assert.deepEqual(markupLines({ kind: "markup", format: "markdown", text }, 18, theme), wrap(text, 18));
  }
  for (const width of [2, 4, 8, 20]) {
    const value = { field: "漢👩‍💻".repeat(4) };
    const rows = plain(structuredLines(value, width));
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    assert.equal(rows.join("").replace(/ /g, ""), `field:${JSON.stringify(value.field)}`);
  }
});
