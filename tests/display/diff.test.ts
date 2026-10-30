import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import type { DiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { sourceLines } from "../../src/display/text.ts";
import { defaults } from "../../src/settings/model.ts";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
initTheme("dark", false);
const theme = {
  colors: { toolDiffRemoved: parseColor("#ee5555"), toolDiffAdded: parseColor("#55ee88"), toolErrorBg: parseColor("#181010"), toolSuccessBg: parseColor("#101810") },
  getColorMode: () => "truecolor",
  fg: (key: string, text: string) => `\x1b[38;2;${key === "dim" ? "119;119;119" : key === "toolDiffRemoved" ? "238;85;85" : "85;238;136"}m${text}\x1b[39m`,
} as unknown as Theme;

function plan(before: string, after: string): DiffPresentation {
  return buildDiffPresentation({ kind: "change.replacements", requestedEdits: [{ path: "module.ts", oldText: before, newText: after }] }, undefined);
}

async function terminalRows(lines: readonly string[], width: number) {
  const terminal = new Terminal({ cols: width, rows: lines.length + 2, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write(lines.join("\r\n"), resolve));
  return terminal;
}

test("split syntax cannot color separators or the next pane's gutter, including narrow wraps", async () => {
  const presentation = plan('const 界 = "a very long string value";', 'const 界 = "a changed string value";');
  for (const width of [28, 60, 100]) {
    const rows = renderToolDiff(presentation, width, { ...defaults, diffMode: "split" }, theme);
    const terminal = await terminalRows(rows, width);
    try {
      for (let row = 0; row < rows.length; row++) {
        const text = stripTerminalSequences(rows[row]!);
        assert.ok(visibleWidth(rows[row]!) <= width);
        const index = text.indexOf("│");
        if (index < 0) continue;
        const separator = visibleWidth(text.slice(0, index));
        const line = terminal.buffer.active.getLine(row)!;
        const edge = line.getCell(separator)!;
        assert.equal(edge.getChars(), "│");
        assert.ok(edge.isFgDefault(), "the separator must not inherit syntax color");
        assert.ok(edge.isBgDefault(), "the separator must not inherit span background");
        for (const column of [0, separator + 1]) {
          const marker = line.getCell(column)!;
          if (marker.getChars() !== "-" && marker.getChars() !== "+") continue;
          assert.ok(!marker.isBgDefault(), "changed gutters have their own subtle background");
          assert.equal(marker.getFgColor(), marker.getChars() === "-" ? 0xee5555 : 0x55ee88);
        }
      }
    } finally { terminal.dispose(); }
  }
});

test("gutter tint does not enable whole-row tint, and numbering can be hidden", async () => {
  const presentation = plan("const value = 1;", "const value = 2;");
  for (const diffMode of ["unified", "split"] as const) {
    const rows = renderToolDiff(presentation, 100, { ...defaults, diffMode }, theme);
    const terminal = await terminalRows(rows, 100);
    try {
      for (let row = 0; row < rows.length; row++) {
        const line = terminal.buffer.active.getLine(row)!;
        const marker = line.getCell(0)!;
        if (marker.getChars() !== "-" && marker.getChars() !== "+") continue;
        assert.ok(!marker.isBgDefault());
        assert.ok(line.getCell(3)!.isBgDefault(), "unchanged source characters keep their normal background");
        assert.ok(line.getCell(45)!.isBgDefault(), "unused pane width is not tinted by default");
      }
    } finally { terminal.dispose(); }
    const tintedRows = renderToolDiff(presentation, 100, { ...defaults, diffMode, diffRowBackground: true }, theme);
    const tinted = await terminalRows(tintedRows, 100);
    try {
      for (let row = 0; row < tintedRows.length; row++) {
        const line = tinted.buffer.active.getLine(row)!;
        const marker = line.getCell(0)!.getChars();
        if (marker === "-" || marker === "+") assert.ok(!line.getCell(45)!.isBgDefault(), "explicit whole-row tint still covers padding");
      }
    } finally { tinted.dispose(); }
    const unnumbered = renderToolDiff(presentation, 100, { ...defaults, diffMode, lineNumbers: false }, theme).map(stripTerminalSequences);
    assert.ok(unnumbered.some(line => /^- +const value/.test(line)));
    assert.ok(!unnumbered.some(line => /^-\d/.test(line)));
  }
});

test("changed gutters are softer than unchanged span emphasis in both layouts and row-background modes", async () => {
  const presentation = buildDiffPresentation({ kind: "change.patch", format: "unified", text:
    '--- a/module.ts\n+++ b/module.ts\n@@ -16 +18 @@\n-const value = 11111;\n+const value = 22222;\n' }, undefined);
  const distance = (left: number, right: number) => [16, 8, 0]
    .reduce((sum, shift) => sum + Math.abs(((left >> shift) & 255) - ((right >> shift) & 255)), 0);
  for (const light of [false, true]) {
    const painted = { ...theme, colors: { ...theme.colors,
      toolErrorBg: parseColor(light ? "#fff0f0" : "#181010"),
      toolSuccessBg: parseColor(light ? "#f0fff0" : "#101810"),
    } } as unknown as Theme;
    for (const diffMode of ["unified", "split"] as const) for (const diffRowBackground of [false, true]) {
      const rows = renderToolDiff(presentation, 100, { ...defaults, diffMode, diffRowBackground }, painted);
      const terminal = await terminalRows(rows, 100);
      try {
        for (const [marker, number, source, base, emphasis, foreground] of [
          ["-", "16", "11111", light ? 0xfff0f0 : 0x181010, light ? 0xfcd1d1 : 0x431e1e, 0xee5555],
          ["+", "18", "22222", light ? 0xf0fff0 : 0x101810, light ? 0xd1fcdb : 0x1e4328, 0x55ee88],
        ] as const) {
          const rowIndex = rows.findIndex(row => {
            const text = stripTerminalSequences(row);
            return text.includes(number) && text.includes(marker) && text.includes(source);
          });
          assert.ok(rowIndex >= 0);
          const text = stripTerminalSequences(rows[rowIndex]!);
          const line = terminal.buffer.active.getLine(rowIndex)!;
          const gutterStart = text.lastIndexOf(marker, text.indexOf(source));
          const numberStart = text.lastIndexOf(number, gutterStart);
          const gutter = line.getCell(gutterStart)!;
          const span = line.getCell(text.indexOf(source))!;
          assert.equal(span.getBgColor(), emphasis, "actual changed-text colors stay unchanged");
          assert.equal(gutter.getFgColor(), foreground, "marker foreground remains theme-owned");
          assert.ok(!gutter.isBgDefault());
          assert.ok(distance(gutter.getBgColor(), base) < distance(emphasis, base), "the gutter is nearer its background than changed text");
          assert.equal(line.getCell(numberStart)!.getBgColor(), gutter.getBgColor(), "line numbers share the softer gutter tint");
          const unchanged = line.getCell(text.indexOf("const", gutterStart))!;
          const padding = line.getCell(gutterStart + 30)!;

          if (diffRowBackground) {
            assert.equal(unchanged.getBgColor(), gutter.getBgColor(), "whole-row fill uses the same faint tier, not span emphasis");
            assert.equal(padding.getBgColor(), gutter.getBgColor(), "row padding stays faint too");
          } else {
            assert.ok(unchanged.isBgDefault());
            assert.ok(padding.isBgDefault());
          }
        }
      } finally { terminal.dispose(); }
    }
  }
});

test("reported file captions replace redundant headings", () => {
  const requested = plan("const value = 1;", "const value = 2;");
  const reported: DiffPresentation = { ...requested, units: requested.units.map(unit => ({ ...unit, origin: "reported" })) };
  const compact = renderToolDiff(reported, 100, defaults, theme, "module.ts").map(stripTerminalSequences);
  assert.ok(!compact.includes("Reported changes"));
  assert.ok(!compact.some(line => line.startsWith("module.ts")));
  assert.ok(renderToolDiff(requested, 100, defaults, theme, "module.ts").map(stripTerminalSequences).includes("Requested changes"));
  assert.ok(renderToolDiff(reported, 100, defaults, theme).map(stripTerminalSequences).some(line => line.startsWith("module.ts")));
  const moved: DiffPresentation = { ...reported, units: reported.units.map(unit => ({ ...unit,
    sections: [{ ...unit.sections[0], target: { path: "module.ts", moveTo: "renamed.ts" } }],
  })) };
  assert.ok(renderToolDiff(moved, 100, defaults, theme, "module.ts").map(stripTerminalSequences).some(line => line.includes("renamed.ts")));
});

test("read source keeps syntax colors and logical line numbers across wrapping", async () => {
  const rows = sourceLines({ text: 'const value = "a long string value";\nreturn value;', firstLine1: 21 }, "module.ts", 22, true, theme);
  const terminal = await terminalRows(rows, 22);
  try {
    const text = rows.map(stripTerminalSequences);
    assert.ok(text[0]!.startsWith("21 "));
    assert.ok(text.some(line => line.startsWith("22 ")));
    assert.ok(text.some(line => line.startsWith("   ")));
    assert.ok(!terminal.buffer.active.getLine(0)!.getCell(3)!.isFgDefault(), "source is syntax highlighted");
    for (let row = 0; row < rows.length; row++) {
      assert.equal(terminal.buffer.active.getLine(row)!.getCell(0)!.getFgColor(), 0x777777, "source color cannot leak into the next gutter");
    }
  } finally { terminal.dispose(); }

  for (const firstLine1 of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const unknown = sourceLines({ text: "const value = 1;", firstLine1 }, "module.ts", 80, true, theme).map(stripTerminalSequences);
    assert.deepEqual(unknown, ["const value = 1;"], "unproven file positions stay unnumbered");
  }
  const comment = sourceLines({ text: "/* first\nsecond\n*/", firstLine1: 1 }, "module.ts", 80, true, theme);
  const highlighted = await terminalRows(comment, 80);
  try {
    assert.equal(highlighted.buffer.active.getLine(0)!.getCell(2)!.getFgColor(), highlighted.buffer.active.getLine(1)!.getCell(2)!.getFgColor(), "multiline syntax state survives gutter isolation");
  } finally { highlighted.dispose(); }
});

test("read gutters pair each supplied identifier with its actual line number", () => {
  const rows = sourceLines({ text: "first\nsecond", firstLine1: 3, lineIdentifiers: ["ajivo", "outwa"] }, "src/a.ts", 80, true, theme).map(stripTerminalSequences);
  assert.ok(rows[0]!.startsWith("3 ajivo "));
  assert.ok(rows[1]!.startsWith("4 outwa "));
});

test("diff gutters use the same line-and-identifier convention as read gutters", () => {
  const patch = "--- src/a.ts\n+++ src/a.ts\n@@ -4 +4 @@\n-before\n+after\n";
  const diff = buildDiffPresentation({ kind: "uninterpreted" }, { parts: [{ kind: "diff", origin: "reported", representations: { unified: patch },
    lineIdentifiers: [{ path: "src/a.ts", side: "before", line1: 4, identifier: "outwa" },
      { path: "src/a.ts", side: "after", line1: 4, identifier: "ookey" }] }] });
  for (const diffMode of ["unified", "split"] as const) {
    const rows = renderToolDiff(diff, 100, { ...defaults, diffMode }, theme).map(stripTerminalSequences).join("\n");
    assert.ok(rows.includes("4 outwa") && rows.includes("4 ookey"));
  }
});

test("real-producer-shaped Codex additions and pure deletions render without an absent source version", () => {
  const addition = buildDiffPresentation({ kind: "change.patch", format: "codex", text: [
    "*** Begin Patch", "*** Update File: module.ts", "@@", "-export type Schema = JsonObject;",
    "+export type Schema = Readonly<JsonObject>;", "*** Add File: notes/new.md", "+# Patch execution",
    "+This file was created by the real third-party apply_patch.", "*** End Patch",
  ].join("\n") }, undefined);
  for (const diffMode of ["unified", "split", "auto"] as const) {
    const rows = renderToolDiff(addition, 120, { ...defaults, diffMode }, theme).map(stripTerminalSequences);
    assert.ok(rows.some(line => line.includes("Readonly<JsonObject>")));
    assert.ok(rows.some(line => line.includes("Patch execution")));
    assert.ok(rows.some(line => line.includes("notes/new.md")));
  }
  const deletion = plan("const value = 1;", "");
  const rows = renderToolDiff(deletion, 100, defaults, theme).map(stripTerminalSequences);
  assert.ok(rows.some(line => line.includes("const value = 1;")));
});

test("partially reported cross-file moves retain one explicitly requested note", () => {
  const request = { kind: "change.replacements" as const, requestedEdits: [{ kind: "transfer" as const, path: "", operation: "move" as const,
    source: { path: "src.ts", start: "3:abc", end: "5:def" }, destination: { path: "dest.ts", anchor: "8:ghi", direction: "after" as const } }] };
  const target = "--- dest.ts\n+++ dest.ts\n@@ -1 +1 @@\n-old target\n+new target\n";
  const source = "--- src.ts\n+++ src.ts\n@@ -1 +1 @@\n-old source\n+new source\n";
  const result = (unified: string) => ({ parts: [{ kind: "diff" as const, origin: "reported" as const, representations: { unified } }] as const });
  for (const layout of ["unified", "split"] as const) {
    const partial = renderToolDiff(buildDiffPresentation(request, result(target)), 120, { ...defaults, diffMode: layout }, theme)
      .map(stripTerminalSequences).join("\n");
    assert.equal(partial.split("Requested: Move src.ts 3:abc–5:def → dest.ts after 8:ghi").length - 1, 1);
    assert.ok(partial.includes("old target") && partial.includes("new target"));
    const complete = renderToolDiff(buildDiffPresentation(request, result(source + target)), 120, { ...defaults, diffMode: layout }, theme)
      .map(stripTerminalSequences).join("\n");
    assert.ok(!complete.includes("Requested: Move"));
    assert.ok(complete.includes("old source") && complete.includes("new target"));
  }
});

test("file captions replace redundant reported headings without hiding ambiguous provenance", () => {
  const filePatch = "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const result = { parts: [{ kind: "diff" as const, origin: "reported" as const, representations: { unified: filePatch } }] as const };
  const known = buildDiffPresentation({ kind: "uninterpreted" }, result);
  const output = renderToolDiff(known, 100, { ...defaults, diffMode: "split" }, theme).map(stripTerminalSequences).join("\n");
  assert.ok(output.includes("src/a.ts") && output.includes("old") && output.includes("new"));
  assert.ok(!output.includes("Reported changes"));

  const ambiguous = buildDiffPresentation({ kind: "uninterpreted" }, { parts: [{ kind: "diff" as const, origin: "reported" as const,
    representations: { numbered: "-1 old\n+1 new" } }] });
  assert.ok(renderToolDiff(ambiguous, 100, { ...defaults, diffMode: "unified" }, theme).map(stripTerminalSequences).join("\n").includes("Reported changes"));
  const mixed: DiffPresentation = { ...known, units: [{ ...known.units[0]!, origin: "request" }, ...known.units] };
  const mixedText = renderToolDiff(mixed, 100, { ...defaults, diffMode: "split" }, theme).map(stripTerminalSequences).join("\n");
  assert.ok(mixedText.includes("Requested changes") && mixedText.includes("Reported changes"));
});
