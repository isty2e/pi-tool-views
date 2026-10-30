import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ToolViewRow } from "../../src/display/row.ts";
import type { RenderContext, RowServices } from "../../src/display/row.ts";
import type { RequestView, ResultView, SuppliedToolResult } from "../../src/presentation.ts";
import { defaults } from "../../src/settings/model.ts";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

function fixture(request: RequestView, view: ResultView, resultRows: number | null = null, renderDiff: RowServices["renderDiff"] = renderToolDiff,
  original: SuppliedToolResult = { isError: false, content: [{ kind: "text", text: "exact original result" }] }) {
  const colors: { name: string; text: string }[] = [];
  const codes: Record<string, number> = { accent: 35, muted: 90, dim: 90, warning: 33, error: 31 };
  const theme = { fg(name: string, text: string) {
    colors.push({ name, text });
    return `\x1b[${codes[name] ?? 39}m${text}\x1b[39m`;
  }, bg: (_name: string, text: string) => text, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as Theme;
  const args = { original: "all arguments remain inspectable" };
  const context: RenderContext = { args, state: {}, toolCallId: "call", cwd: "/fixture", argsComplete: true,
    executionStarted: true, isPartial: false, isError: false, expanded: true, showImages: true, durationMs: 10, outputPad: 1,
    lastComponent: undefined, invalidate() {} };
  const settings = { ...defaults, diffMode: "unified" as const, resultRows };
  const services: RowServices = { settings: () => settings, initialSettings: () => settings,
    choices: (_key, fallback) => fallback, compile: () => ({ request: () => request, result: () => view }),
    compare: buildDiffPresentation, renderDiff, home: "/fixture", now: () => 100 };
  const row = new ToolViewRow("tool", "call", args, context, theme, services, undefined, "fallback");
  row.parts.admitNested({ identity: "owner/call", arguments: args, complete: true,
    result: original });
  return { row, colors, settings, context };
}

test("existing row and source-inspection caches follow emphasis changes without rebinding", () => {
  const { row, settings } = fixture({ kind: "change.replacements", requestedEdits: [{ path: "a.ts", oldText: "alpha one", newText: "alpha changed" }] }, {
    parts: [{ kind: "diff", origin: "reported", path: "a.ts", representations: { numbered: "-1 alpha one\n+1 alpha changed" } }],
  }, null, (_plan, _width, active) => [`emphasis=${active.diffEmphasisGap}`]);
  try {
    for (const gap of [0, 2, 0]) {
      settings.diffEmphasisGap = gap;
      row.invalidate();
      assert.ok(row.callComponent.render(100).map(stripTerminalSequences).includes(`emphasis=${gap}`));
      assert.ok(row.inspectionLines("source", 100).map(stripTerminalSequences).includes(`emphasis=${gap}`));
    }
  } finally { row.retire(); }
});

test("common search rendering distinguishes matches, aligns identities and retains indentation", () => {
  const { row } = fixture({ kind: "search.text", query: "hit", dialect: "literal", caseMode: "sensitive", scope: {} }, {
    parts: [{ kind: "file-matches", groups: [{ path: "src/a.ts", annotation: "[modified]", rows: [
      { kind: "line", line1: 3, identifier: "MY", text: "  before", role: "context" },
      { kind: "line", line1: 40, identifier: "JP", text: "  hit", role: "match" },
      { kind: "gap", text: "…" },
      { kind: "line", line1: 50, identifier: "SQ", text: "  unknown role", role: "unreported" },
    ] }] }],
  });
  try {
    const lines = row.resultComponent.render(100).map(stripTerminalSequences);
    assert.ok(lines.includes("src/a.ts  [modified]"));
    const before = lines.find(line => line.includes("before"))!, hit = lines.find(line => line.includes("hit"))!;
    assert.ok(hit.startsWith("› "));
    assert.ok(!before.includes("›"));
    assert.ok(before.includes("3 MY   before") && hit.includes("40 JP   hit"));
    assert.equal(before.indexOf("before"), hit.indexOf("hit"));
    assert.ok(!lines.find(line => line.includes("unknown role"))?.includes("›"));
    for (const width of [1, 2, 5, 12, 40]) {
      assert.ok(row.resultComponent.render(width).every(line => visibleWidth(line) <= width));
    }
    assert.ok(row.inspectionLines("result", 100).join("\n").includes("exact original result"));
  } finally { row.retire(); }
});

test("read and reported diff use the same line-identifier presentation", () => {
  const read = fixture({ kind: "source.lines", path: "a.ts" }, { parts: [
    { kind: "source", path: "a.ts", source: { text: "new", firstLine1: 40, lineIdentifiers: ["MY"] } },
  ] });
  const diff = fixture({ kind: "change.replacements", requestedEdits: [{ path: "a.ts", oldText: "old", newText: "new" }] }, {
    parts: [{ kind: "diff", origin: "reported", path: "a.ts", representations: { numbered: "-40      old\n+40#MY:new" } }],
  });
  try {
    assert.ok(read.row.resultComponent.render(80).map(stripTerminalSequences).some(line => line.startsWith("40 MY new")));
    const lines = [...diff.row.callComponent.render(80), ...diff.row.resultComponent.render(80)].map(stripTerminalSequences);
    assert.ok(lines.some(line => line.includes("40 MY") && line.includes("new")));
    assert.ok(!lines.some(line => line.includes("40#MY")));
  } finally { read.row.retire(); diff.row.retire(); }
});

test("recognized agent metadata is hidden while actual warnings and errors remain visible", () => {
  const { row, colors } = fixture({ kind: "source.lines", path: "a.ts" }, { parts: [
    { kind: "source", path: "a.ts", source: { text: "actual content", firstLine1: 1 } },
    { kind: "text", text: "\n\nresult ok\n", role: "receipt" },
    { kind: "text", text: "usage tokens=2", role: "usage" },
    { kind: "notice", text: "actual warning", severity: "warning", origin: "producer" },
    { kind: "notice", text: "actual failure", severity: "error", origin: "producer" },
  ] });
  try {
    const lines = row.resultComponent.render(80).map(stripTerminalSequences);
    assert.deepEqual(lines, ["1 actual content", "actual warning", "actual failure"]);
    assert.ok(!colors.some(color => /result ok|usage tokens/.test(color.text)));
    assert.ok(colors.some(color => color.name === "warning" && color.text === "actual warning"));
    assert.ok(colors.some(color => color.name === "error" && color.text === "actual failure"));
    assert.ok(!colors.some(color => color.name === "muted" && /actual warning|actual failure/.test(color.text)));
  } finally { row.retire(); }
});

test("hidden metadata stays in raw inspection and does not consume the result row budget", () => {
  const text = 'actual\nresult ok\nusage tokens=50\nContinue with cursor="opaque"';
  const { row } = fixture({ kind: "uninterpreted" }, { parts: [
    { kind: "text", text: "actual" }, { kind: "text", text: "result ok", role: "receipt" },
    { kind: "text", text: "usage tokens=50", role: "usage" },
    { kind: "text", text: 'Continue with cursor="opaque"', role: "continuation" },
  ] }, 1, renderToolDiff, { isError: false, content: [{ kind: "text", text }] });
  try {
    const lines = row.resultComponent.render(100).map(stripTerminalSequences);
    assert.ok(lines.some(line => line.includes("Show full result (2 rows)")));
    assert.ok(!lines.some(line => /usage|result ok|opaque/.test(line)));
    assert.ok(row.inspectionLines("result", 100).map(stripTerminalSequences).join("\n").includes(text));
  } finally { row.retire(); }
});

test("metadata-only results do not resurrect hidden data through the details fallback", () => {
  const { row } = fixture({ kind: "uninterpreted" }, { parts: [{ kind: "text", text: "usage tokens=50", role: "usage" }] },
    null, renderToolDiff, { isError: false, content: [], details: { usage: { tokens: 50 } } });
  try {
    assert.deepEqual(row.resultComponent.render(100), []);
    assert.ok(row.inspectionLines("result", 100).join("\n").includes("50"));
  } finally { row.retire(); }
});

test("unknown text and partial application are not hidden as clean completion receipts", () => {
  const { row } = fixture({ kind: "uninterpreted" }, { parts: [
    { kind: "text", text: "Successfully replaced 1 block", role: "receipt" },
    { kind: "changes", changes: [], application: { scope: { kind: "call" }, outcome: "reported-partial" } },
    { kind: "text", text: "Unknown usage message and a warning remain literal." },
  ] });
  try {
    const lines = row.resultComponent.render(100).map(stripTerminalSequences).join("\n");
    assert.ok(lines.includes("Successfully replaced 1 block") && lines.includes("partial"));
    assert.ok(lines.includes("Unknown usage message and a warning remain literal."));
  } finally { row.retire(); }
});

test("short coverage notices retain their style across every physical row", async () => {
  for (const width of [1, 4, 12, 80]) {
    const { row } = fixture({ kind: "uninterpreted" }, { parts: [
      { kind: "coverage", reason: "limit", producerText: 'Continue with cursor="opaque"' },
      { kind: "coverage", reason: "limit" },
    ] });
    const lines = row.resultComponent.render(width);
    const terminal = new Terminal({ cols: width, rows: lines.length + 2, allowProposedApi: true });
    try {
      await new Promise<void>(resolve => terminal.write(lines.map(line => "\x1b[0m" + line + "\x1b[0m").join("\r\n"), resolve));
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.equal(lines.map(stripTerminalSequences).join("").replaceAll(" ", ""), "Resultlimitreached.");
      for (let index = 0; index < lines.length; index++) {
        const text = stripTerminalSequences(lines[index]!);
        for (let column = 0; column < text.length; column++) {
          const cell = terminal.buffer.active.getLine(index)!.getCell(column)!;
          assert.ok(cell.isFgPalette());
          assert.equal(cell.getFgColor(), 8);
        }
      }
    } finally { terminal.dispose(); row.retire(); }
  }
});

test("operation headings use normal foreground while disclosure controls keep accent", () => {
  const { row, colors } = fixture({ kind: "change.replacements", requestedEdits: [
    { path: "a.ts", oldText: "one", newText: "two" }, { path: "b.ts", oldText: "three", newText: "four" },
  ] }, { parts: [{ kind: "text", text: "first\nsecond\nthird" }] }, 1);
  try {
    row.callComponent.render(80);
    row.resultComponent.render(80);
    assert.ok(colors.some(color => color.name === "text" && color.text === "Edit"));
    assert.ok(!colors.some(color => color.name === "accent" && color.text === "Edit"));
    assert.ok(colors.some(color => color.name === "accent" && color.text.includes("Show full result")));
    assert.ok(row.inspectionLines("arguments", 100).join("\n").includes("all arguments remain inspectable"));
  } finally { row.retire(); }
});

test("file lists never acquire line numbers through a shared display setting", () => {
  const { row } = fixture({ kind: "search.list", root: "." }, { parts: [
    { kind: "file-list", entries: [{ path: "src", directory: true }, { path: "a.ts", annotation: "[modified]" }] },
  ] });
  try {
    assert.deepEqual(row.resultComponent.render(80).map(stripTerminalSequences), ["src/", "a.ts  [modified]"]);
  } finally { row.retire(); }
});

test("visible information, warnings and errors survive wrapping while hidden metadata cannot leak styles", async () => {
  const receipt = "R".repeat(31) + "\nR-END";
  const usage = "U".repeat(31) + "\nU-END";
  const continuation = "C".repeat(31) + "\nC-END";
  const green = "G".repeat(31) + "\nG-END";
  const warning = "W".repeat(31) + "\nW-END";
  const error = "E".repeat(31) + "\nE-END";
  for (const width of [12, 80]) {
    const { row } = fixture({ kind: "uninterpreted" }, { parts: [
      { kind: "text", text: "B-END" },
      { kind: "text", text: "\n\n" + receipt + "\n", role: "receipt" },
      { kind: "text", text: usage, role: "usage" },
      { kind: "text", text: "\x1b[32m" + green + "\x1b[39m\nA-END" },
      { kind: "notice", text: continuation, severity: "info", origin: "producer" },
      { kind: "notice", text: warning, severity: "warning", origin: "producer" },
      { kind: "notice", text: error, severity: "error", origin: "producer" },
    ] });
    const lines = row.resultComponent.render(width);
    const plain = lines.map(stripTerminalSequences);
    const expected = ["B-END", green, "A-END", continuation, warning, error].join("").replaceAll("\n", "");
    assert.equal(plain.join(""), expected, "style handling must not lose or duplicate visible content");
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const terminal = new Terminal({ cols: width, rows: lines.length + 2, allowProposedApi: true });
    try {
      await new Promise<void>(resolve => terminal.write(lines.map(line => "\x1b[0m" + line + "\x1b[0m").join("\r\n"), resolve));
      const colors: Record<string, number> = { R: 8, U: 8, C: 8, G: 2, W: 3, E: 1 };
      for (let index = 0; index < plain.length; index++) {
        const text = plain[index]!;
        if (!text) continue;
        const color = colors[text[0]!];
        const rendered = terminal.buffer.active.getLine(index)!;
        assert.equal(rendered.translateToString(true), text);
        for (let column = 0; column < text.length; column++) {
          const cell = rendered.getCell(column)!;
          if (color === undefined) assert.ok(cell.isFgDefault(), "informational color must not leak into ordinary text");
          else {
            assert.ok(cell.isFgPalette(), `row ${index} must carry its own style after a host reset`);
            assert.equal(cell.getFgColor(), color, `wrong foreground on row ${index}, column ${column}`);
          }
        }
      }
    } finally { terminal.dispose(); row.retire(); }
  }
});
