import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolViewRow } from "../../src/display/row.ts";
import type { LocalChoices, RenderContext, RowServices } from "../../src/display/row.ts";
import { defaults } from "../../src/settings/model.ts";
import type { Settings } from "../../src/settings/model.ts";
import type { RequestView, ResultView, SuppliedToolResult } from "../../src/presentation.ts";
import { clipRows, locationText, previewJson, safeText } from "../../src/display/text.ts";
import { titleFacts } from "../../src/display/title.ts";
import { getToolViewParts } from "../../src/composition.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const theme = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value,
  bold: (value: string) => value } as Theme;

function context(args: unknown = {}): RenderContext {
  return { args, state: {}, toolCallId: "test", cwd: "/fixture", argsComplete: true, executionStarted: true,
    isPartial: false, isError: false, durationMs: 10, expanded: true, showImages: true, outputPad: 1,
    lastComponent: undefined, invalidate() {} };
}

function fixture(request: RequestView = { kind: "program.javascript", source: "first();\nsecond();" }, native?: ToolRenderers) {
  let settings: Settings = { ...defaults };
  let comparisons = 0;
  let projections = 0;
  const choices = new Map<string, LocalChoices>();
  const services: RowServices = {
    settings: () => settings, initialSettings: () => defaults, home: "/fixture", now: () => 100,
    choices: (key, value) => { if (!choices.has(key)) choices.set(key, value); return choices.get(key)!; },
    compile: () => ({ request: () => { projections++; return request; }, result: result => ({ parts: [{ kind: "original-content" }] }) }),
    compare: (_request, result) => { comparisons++; return { units: request.kind === "change.patch"
      ? [{ scope: { kind: "call" }, origin: "request", sections: [{ kind: "raw", sources: [{ text: request.text }] }] }] : [],
      applicationReports: [], context: result?.parts.filter(part => part.kind !== "diff") ?? [] }; },
    renderDiff: () => ["supplied diff"],
  };
  const args = request.kind === "program.javascript" ? { code: request.source } : { input: "requested patch" };
  const ctx = context(args);
  let invalidations = 0;
  ctx.invalidate = () => { invalidations++; };
  const row = new ToolViewRow("some_tool", "test", args, ctx, theme, services, native, "fallback");
  row.parts.admitNested({ identity: "owner/child", arguments: args, complete: true });
  return { row, ctx, args, services, setSettings(value: Partial<Settings>) { settings = { ...settings, ...value }; },
    get counts() { return { comparisons, projections, invalidations }; } };
}

function click(component: { handleMouse?(event: TuiMouseEvent): unknown }, lines: readonly string[], label: string) {
  const plain = lines.map(stripTerminalSequences);
  const y = plain.findIndex(line => line.includes(`[${label}`));
  assert.ok(y >= 0, `visible control ${label}`);
  const x = visibleWidth(plain[y]!.slice(0, plain[y]!.indexOf(`[${label}`)));
  return component.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y,
    width: 80, height: lines.length, shift: false, ctrl: false, alt: false });
}

test("source, arguments and output controls are independent of host expansion", () => {
  const f = fixture();
  const result: SuppliedToolResult = { content: [{ kind: "text", text: Array.from({ length: 30 }, (_, i) => `result ${i}`).join("\n") }], isError: false };
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true, result });
  let call = f.row.callComponent.render(80);
  assert.ok(!call.some(line => line === "second();"));
  click(f.row.callComponent, call, "Show source");
  call = f.row.callComponent.render(80);
  assert.ok(call.some(line => line.includes("second();")));

  let output = f.row.resultComponent.render(80);
  assert.ok(output.some(line => line.includes("Show full result")));
  assert.ok(!output.some(line => line === "result 20"));
  click(f.row.resultComponent, output, "Show full result");
  output = f.row.resultComponent.render(80);
  assert.ok(output.includes("result 20"));
  assert.ok(f.row.callComponent.render(80).some(line => line.includes("Hide source")));
  assert.deepEqual(click(f.row.resultComponent, output, "Collapse result"), { handled: true });
  assert.equal(f.ctx.expanded, true);
});

test("interpreted cards use semantic content, while generic calls retain argument inspection", () => {
  const known = fixture({ kind: "change.replacements", requestedEdits: [{ path: "module.ts", oldText: "before", newText: "after" }] });
  const call = known.row.callComponent.render(100).join("\n");
  assert.ok(call.includes("module.ts"));
  assert.ok(!call.includes(JSON.stringify(known.args)));
  assert.ok(!call.includes("Show full arguments"));
  assert.ok(known.row.inspectionLines("arguments", 100).join("\n").includes("requested patch"));

  const generic = fixture({ kind: "uninterpreted" });
  const value = "opaque value ".repeat(80);
  generic.row.parts.admitNested({ identity: "owner/child", arguments: { value }, complete: true });
  const preview = generic.row.callComponent.render(60);
  assert.ok(preview.some(line => line.includes("opaque value")));
  click(generic.row.callComponent, preview, "Show full arguments");
  assert.ok(generic.row.callComponent.render(60).length > preview.length);
  assert.ok(generic.row.inspectionLines("arguments", 2000).join("\n").includes(value));
});

test("read range and source numbering reflect admitted request facts and the shared setting", () => {
  const args = { path: "module.ts", offset: 11, limit: 2 };
  const f = fixture();
  const services: RowServices = { ...f.services, compile: compileProjection };
  const row = new ToolViewRow("read", "read-call", args, context(args), theme, services, undefined, "read-fallback");
  row.parts.admitNested({ identity: "owner/read", arguments: args, complete: true, declaration: {
    description: "Read the contents of a file.", input: { kind: "json", schema: {
      type: "object", required: ["path"], properties: {
        path: { type: "string", description: "Path to the file to read." },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)." },
        limit: { type: "number", description: "Maximum number of lines to read." },
      },
    } },
  }, result: { isError: false, content: [{ kind: "text", text: "const first = 1;\nconst second = 2;\n\n[6 more lines in file. Use offset=13 to continue.]" }] } });

  const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);
  assert.ok(plain(row.callComponent.render(100)).some(line => line.includes("module.ts (L11–12)")));
  const numbered = plain(row.resultComponent.render(100));
  assert.ok(numbered.some(line => /^11 const first/.test(line)));
  assert.ok(numbered.some(line => /^12 const second/.test(line)));
  assert.ok(numbered.includes("Continuation available."));
  assert.ok(row.inspectionLines("result", 200).map(stripTerminalSequences).join("\n").includes("offset=13"));

  f.setSettings({ lineNumbers: false });
  const unnumbered = plain(row.resultComponent.render(100));
  assert.ok(unnumbered.includes("const first = 1;"));
  assert.ok(!unnumbered.some(line => /^11 /.test(line)));
  assert.ok(plain(row.callComponent.render(100)).some(line => line.includes("(L11–12)")));
  row.retire();
});

test("source style isolation preserves an enabled card backdrop through the final padding cell", async () => {
  const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
  const f = fixture();
  const background = "\x1b[48;2;34;51;68m";
  const painted = { fg: theme.fg, bg: (_key: string, text: string) => background + text + "\x1b[49m", getBgAnsi: () => background } as unknown as Theme;
  const row = new ToolViewRow("script", "backdrop-call", f.args, context(f.args), painted, f.services, undefined, "backdrop");
  row.parts.admitNested({ identity: "owner/backdrop", arguments: f.args, complete: true,
    declaration: { description: "Execute JavaScript.", input: { kind: "json", schema: { type: "object" } } } });
  f.setSettings({ backdrop: true });
  click(row.callComponent, row.callComponent.render(80), "Show source");
  const lines = row.callComponent.render(80);
  const sourceRow = lines.findIndex(line => stripTerminalSequences(line).includes("first();"));
  assert.ok(sourceRow >= 0);
  const terminal = new Terminal({ cols: 80, rows: lines.length + 2, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(lines.join("\r\n"), resolve));
    assert.equal(terminal.buffer.active.getLine(sourceRow)!.getCell(0)!.getBgColor(), 0x223344);
    assert.equal(terminal.buffer.active.getLine(sourceRow)!.getCell(79)!.getBgColor(), 0x223344);
  } finally { terminal.dispose(); row.retire(); }
});

test("pure redraw and width changes reuse semantic facts; changed snapshots rebuild them", () => {
  const f = fixture();
  f.row.callComponent.render(80);
  const before = f.counts;
  f.row.callComponent.render(30);
  f.row.resultComponent.render(80);
  f.row.capture(f.args, { ...f.ctx, expanded: false }, theme);
  f.row.callComponent.render(70);
  assert.deepEqual(f.counts, before);
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true,
    result: { content: [{ kind: "text", text: "new final result" }], isError: false } });
  assert.ok(f.row.resultComponent.render(80).includes("new final result"));
  assert.equal(f.counts.projections, before.projections + 1);
});

test("read-only inspection exposes full data without changing card choices or admitting an incomplete source", () => {
  const f = fixture();
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true,
    result: { content: [{ kind: "text", text: Array.from({ length: 30 }, (_, index) => `result ${index}`).join("\n") }], isError: false } });
  assert.ok(f.row.inspectionLines("result", 80).map(stripTerminalSequences).includes("result 29"));
  assert.ok(!f.row.resultComponent.render(80).includes("result 29"));
  assert.ok(f.row.inspectionLines("source", 80).some(line => line.includes("second();")));
  assert.ok(f.row.callComponent.render(80).some(line => line.includes("[Show source]")));
  f.row.parts.withdraw();
  assert.deepEqual(f.row.inspectionLines("result", 80), ["This card is no longer active."]);

  const args = { value: "previous argument" };
  const row = new ToolViewRow("raw", "same-id", args, context(args), theme, f.services, undefined, "unbound-test");
  assert.ok(row.inspectionLines("arguments", 80).some(line => line.includes("previous argument")));
  assert.ok(row.inspectionLines("source", 80).some(line => line.includes("No source or diff")));
  row.capture(undefined, context(undefined), theme);
  assert.deepEqual(row.inspectionLines("arguments", 80), ["Arguments are unavailable."]);
  row.retire();
  assert.deepEqual(row.inspectionLines("arguments", 80), ["This card is no longer active."]);
});

test("composition supplies one source control and withdrawals remove child-specific data", () => {
  const f = fixture();
  const parts = getToolViewParts(f.row.callComponent)!;
  assert.ok(parts);
  const source = parts.source.render(80);
  assert.equal(source.filter(line => line.includes("Show source")).length, 1);
  assert.equal(parts.header.render(80).filter(line => line.startsWith("[Show source]")).length, 0);
  parts.withdraw();
  assert.ok(!parts.source.render(80).some(line => line.includes("Show source")));
  assert.deepEqual(parts.header.render(80), []);
  assert.deepEqual(parts.result.render(80), []);
});

test("a composition capability cannot migrate to another invocation or act after retirement", () => {
  const f = fixture();
  const before = f.row.callComponent.render(80);
  assert.equal(f.row.parts.admitNested({ identity: "another-invocation", arguments: { value: "not owned" }, complete: true }), false);
  const count = f.counts.invalidations;
  f.row.callComponent.handleMouse({ type: "click", button: "left", x: 0, y: before.findIndex(line => line.includes("[Show source]")),
    screenX: 0, screenY: 0, width: 80, height: 40, shift: false, ctrl: false, alt: false });
  assert.equal(f.counts.invalidations, count);
  assert.deepEqual(f.row.callComponent.render(80), []);
  f.row.retire();
  assert.equal(f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true }), false);
});

test("an owning snapshot preserves explicit null input and does not borrow an absent result", () => {
  let received: unknown = "not called";
  const f = fixture({ kind: "change.patch", text: "requested patch", format: "unconfirmed" }, {
    renderShell: "self", renderCall(args, _theme, context) {
      received = args;
      assert.equal(args, context.args);
      return { render: () => ["Native"], invalidate() {} };
    },
  });
  f.row.capture(f.args, f.ctx, theme, { content: [{ kind: "text", text: "stale host result" }], isError: false });
  f.row.parts.admitNested({ identity: "owner/child", arguments: null, complete: true });
  assert.deepEqual(f.row.inspectionLines("arguments", 80).map(stripTerminalSequences), ["null"]);
  assert.deepEqual(f.row.inspectionLines("result", 80), ["No result has been supplied."]);
  f.setSettings({ diffMode: "native" });
  f.row.callComponent.render(80);
  assert.equal(received, null);
});

test("bottom rule is omitted before native images but explicit post-media part remains usable", () => {
  const f = fixture();
  f.setSettings({ horizontalRules: "both" });
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true,
    result: { content: [{ kind: "text", text: "caption" }, { kind: "image", data: "synthetic", mimeType: "image/png" }], isError: false } });
  assert.equal(f.row.callComponent.render(20).filter(line => /^─+$/.test(line)).length, 1);
  assert.equal(f.row.resultComponent.render(20).filter(line => /^─+$/.test(line)).length, 0);
  assert.equal(f.row.parts.bottom.render(20).filter(line => /^─+$/.test(line)).length, 1);
});

test("preview budgets include the marker and never discard the full-output choice", () => {
  const rows = Array.from({ length: 20 }, (_, index) => String(index));
  const clipped = clipRows(rows, 12, "head-tail");
  assert.equal(clipped.lines.length, 12);
  assert.deepEqual(clipped.lines.slice(0, 6), rows.slice(0, 6));
  assert.deepEqual(clipped.lines.slice(-5), rows.slice(-5));
  assert.deepEqual(clipRows(rows, 0, "head").lines, []);
  assert.deepEqual(clipRows(rows, null, "head").lines, rows);
  assert.equal(safeText("\x1b[31mred\x1b[0m\x1b[2J\x1b]52;c;secret\x07"), "\x1b[31mred\x1b[0m");
});

test("titles distinguish partial application, active processes and nonzero normal returns", () => {
  const request: RequestView = { kind: "shell.launch", command: "command" };
  const active: ResultView = { parts: [{ kind: "original-content" }], process: { state: "active", sessionId: 2 } };
  assert.equal(titleFacts("tool", request, active, true, true, false, false, true).state, "active");
  const failed: ResultView = { parts: [{ kind: "original-content" }], process: { state: "exited", exitCode: 2 } };
  assert.equal(titleFacts("tool", request, failed, true, true, false, false, true).state, "error");
  const partial: ResultView = { parts: [{ kind: "changes", changes: [], application: { scope: { kind: "call" }, outcome: "reported-partial" } }] };
  assert.equal(titleFacts("tool", request, partial, true, true, false, false, true).state, "partial");
  const fileFailure: ResultView = { parts: [{ kind: "changes", changes: [], application: { scope: { kind: "file", path: "a" }, outcome: "reported-failure" } }] };
  const scoped = titleFacts("tool", request, fileFailure, true, true, false, false, true);
  assert.equal(scoped.state, "complete");
  assert.equal(scoped.warning, true);
});

test("completed fetch coverage is distinct from in-progress, full, empty and host-error outcomes", () => {
  const request: RequestView = { kind: "web.fetch", targets: { kind: "multiple", urls: ["https://a.test", "https://b.test"] } };
  const partial: ResultView = { parts: [{ kind: "original-content" }], targetCoverage: { kind: "fetch", completedTargets: 1, attemptedTargets: 2 } };
  const facts = (view: ResultView, complete = true, isError = false) => titleFacts("fetch", request, view, true, complete, isError, false, true);
  assert.equal(facts(partial).state, "partial");
  assert.equal(facts(partial).label, "Fetched 1/2 targets");
  assert.equal(facts(partial, false).state, "running", "unfinished contributors are normal while the tool is still running");
  assert.equal(facts(partial, true, true).state, "error");
  assert.equal(facts(partial, true, true).label, "Fetch failed");
  assert.equal(facts({ ...partial, targetCoverage: { kind: "fetch", completedTargets: 0, attemptedTargets: 2 } }).label, "Fetched 0/2 targets");
  assert.equal(facts({ ...partial, targetCoverage: { kind: "fetch", completedTargets: 2, attemptedTargets: 2 } }).state, "complete");
  assert.equal(facts({ ...partial, targetCoverage: { kind: "fetch", completedTargets: 0, attemptedTargets: 0 } }).state, "complete");
});

test("reported outcome and diagnostic coverage drive titles independently of host success", () => {
  const process: ResultView = { parts: [{ kind: "original-content" }], process: { state: "active", sessionId: 2 }, reportedFailure: true };
  assert.equal(titleFacts("execute", { kind: "shell.launch", command: "run" }, process, true, true, false, false, true).state, "error");
  const diagnostics: ResultView = { parts: [{ kind: "original-content" }], targetCoverage: { kind: "diagnostics", completedTargets: 0, attemptedTargets: 1 } };
  const facts = titleFacts("check", { kind: "code.diagnostics" }, diagnostics, true, true, false, false, true);
  assert.equal(facts.state, "partial");
  assert.equal(facts.label, "Checked 0/1 diagnostic targets");
  assert.equal(titleFacts("check", { kind: "code.diagnostics" }, diagnostics, true, false, false, false, true).state, "running");
  assert.equal(titleFacts("check", { kind: "code.diagnostics" }, { parts: [{ kind: "original-content" }] }, true, true, false, false, true).label, "Diagnostics");
  assert.equal(titleFacts("image", { kind: "image.synthesize", prompt: "sample", referenceRequests: [] },
    { parts: [{ kind: "original-content" }] }, true, true, false, false, true).label, "Image generation");
});

test("source title uses returned symbol and range rather than the requested locator", () => {
  const request: RequestView = { kind: "source.enclosing", path: "src/math.ts", line1: 6 };
  const view: ResultView = { parts: [{ kind: "source", path: "src/math.ts", source: {
    text: "function add() {}", firstLine1: 3,
  } }], sourceSelection: { path: "src/math.ts", symbol: { kind: "function", name: "add" },
    range: { firstLine1: 3, lastLine1: 8 } } };
  assert.equal(titleFacts("read_enclosing", request, undefined, true, false, false, false, true).target, "src/math.ts");
  assert.equal(titleFacts("read_enclosing", request, view, true, true, false, false, true).target, "src/math.ts (function add; L3–8)");
  assert.equal(titleFacts("read_enclosing", request, view, true, true, false, true, true).label, "read_enclosing");
  const multiple: ResultView = { parts: [view.parts[0]!, view.parts[0]!] };
  assert.equal(titleFacts("read_enclosing", request, multiple, true, true, false, false, true).target, "src/math.ts");
  const partial: ResultView = { parts: [{ kind: "source", path: "src/math.ts", source: { text: "slice", firstLine1: 3 } }],
    sourceSelection: { path: "src/math.ts", symbol: { kind: "function", name: "add" }, range: { firstLine1: 3, lastLine1: 8 },
      partial: true, enclosingRange: { firstLine1: 1, lastLine1: 20 } } };
  assert.equal(titleFacts("read_enclosing", request, partial, true, true, false, false, true).target,
    "src/math.ts (function add; L3–8; partial of L1–20)");
});

test("failed reads retain known request targets without fabricating symbol kind or returned range", () => {
  const fail = (request: RequestView, actualName = false) => titleFacts("read_tool", request, undefined, true, true, true, actualName, true);
  assert.equal(fail({ kind: "source.symbol", path: "src/math.ts", symbol: "add" }).target, "src/math.ts (add)");
  assert.equal(fail({ kind: "source.symbol", path: "src/math.ts", symbol: "add", kindFilter: "function" }).target,
    "src/math.ts (function add)");
  assert.equal(fail({ kind: "source.enclosing", path: "src/math.ts", line1: 6 }).target, "src/math.ts (L6)");
  assert.equal(fail({ kind: "source.enclosing", path: "src/math.ts", line1: -1 }).target, "src/math.ts");
  assert.equal(fail({ kind: "source.lines", path: "src/math.ts", firstLine1: 3, lineLimit: 6 }).target, "src/math.ts (requested L3–8)");
  assert.equal(fail({ kind: "source.lines", path: "src/math.ts", lineLimit: 6 }).target, "src/math.ts (requested up to 6 lines)");
  assert.equal(fail({ kind: "source.lines", path: "src/math.ts" }).target, "src/math.ts");
  assert.equal(fail({ kind: "source.lines", path: "src/math.ts", firstLine1: 1.5 }).target, "src/math.ts");
  assert.equal(fail({ kind: "source.lines", path: "src/math.ts", firstLine1: Number.MAX_SAFE_INTEGER, lineLimit: 3 }).target,
    `src/math.ts (requested L${Number.MAX_SAFE_INTEGER}–; up to 3 lines)`);
  const selection: ResultView = { parts: [{ kind: "original-content" }], sourceSelection: {
    path: "src/math.ts", symbol: { name: "add", kind: "function" }, range: { firstLine1: 3, lastLine1: 8 },
  } };
  assert.equal(titleFacts("read_tool", { kind: "source.enclosing", path: "src/math.ts", line1: 6 }, selection,
    true, true, true, false, true).target, "src/math.ts (function add; L3–8)");
  assert.equal(titleFacts("read_tool", { kind: "source.enclosing", path: "src/math.ts", line1: 6 }, selection,
    true, true, false, false, true).target, "src/math.ts (function add; selected L3–8)");
  assert.equal(fail({ kind: "source.symbol", path: "src/math.ts", symbol: "add" }, true).label, "read_tool");
  const pending = titleFacts("read_tool", { kind: "source.symbol", path: "src/math.ts", symbol: "add" }, undefined,
    true, false, false, false, true);
  assert.equal(pending.target, "src/math.ts");
  const reportedKind: ResultView = { parts: [{ kind: "original-content" }], sourceSelection: {
    path: "src/math.ts", symbol: { kind: "function" }, range: { lastLine1: 8 },
  } };
  assert.equal(titleFacts("read_tool", { kind: "source.symbol", path: "src/math.ts", symbol: "add" }, reportedKind,
    true, true, true, false, true).target, "src/math.ts (function; requested add; L–8)");
  assert.equal(titleFacts("read_tool", { kind: "source.symbol", path: "src/math.ts", symbol: "missing" }, selection,
    true, true, true, false, true).target, "src/math.ts (function add; requested missing; L3–8)");
});

test("failed source results show supplied selections and replace them when the result changes", () => {
  const args = { path: "src/math.ts", line: 6, maxLines: 2 };
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null });
  const row = new ToolViewRow("read_enclosing", "failed-source", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "failed-source-fallback");
  const declaration = { description: "Read the enclosing symbol", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "line"], properties: {
      path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
      line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
      maxLines: { type: "number", description: "Optional maximum body size to return." },
    },
  } } };
  const error = "Enclosing function spans 6 lines, above maxLines 2";
  const details = { found: false, line: 6, name: "add", kind: "function", startLine: 3, endLine: 8,
    selection: { strategy: "oversize-outline", source: "tree-sitter", confidence: "medium" } };
  row.parts.admitNested({ identity: "owner/failed-source", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: error }], details } });
  let header = row.callComponent.render(100).map(stripTerminalSequences)[0]!;
  assert.ok(header.includes("× Read failed src/math.ts (function add; L3–8)"));
  assert.ok(row.resultComponent.render(100).map(stripTerminalSequences).includes(error));
  assert.ok(row.inspectionLines("arguments", 100).map(stripTerminalSequences).join("\n").includes('"line": 6'));
  for (const width of [1, 12, 30, 60]) assert.ok(visibleWidth(row.callComponent.render(width)[0]!) <= width);
  const corroborated = { found: false, line: 6, name: "add", kind: "function", startLine: 3, endLine: 8,
    enclosingStartLine: 3, enclosingEndLine: 8, error };
  row.parts.admitNested({ identity: "owner/failed-source", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: error }], details: corroborated } });
  assert.ok(row.callComponent.render(100).map(stripTerminalSequences)[0]?.includes("× Read failed src/math.ts (function add; L3–8)"));
  assert.ok(row.resultComponent.render(100).map(stripTerminalSequences).includes(error));
  assert.ok(row.inspectionLines("result", 200).map(stripTerminalSequences).join("\n").includes(error));
  row.parts.admitNested({ identity: "owner/failed-source", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: "no enclosing symbol" }], details: { found: false, line: 6 } } });
  header = row.callComponent.render(100).map(stripTerminalSequences)[0]!;
  assert.ok(header.includes("× Read failed src/math.ts (L6)"));
  assert.ok(!header.includes("function add"));
  assert.ok(row.resultComponent.render(100).map(stripTerminalSequences).includes("no enclosing symbol"));
  row.parts.withdraw();
  assert.deepEqual(row.callComponent.render(100), []);
});

test("located source updates the real Read title and follows it without a blank line", () => {
  const args = { path: "src/math.ts", line: 4 };
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null });
  const services: RowServices = { ...f.services, compile: compileProjection };
  const row = new ToolViewRow("read_enclosing", "source-call", args, context(args), theme, services, undefined, "source-fallback");
  const declaration = { description: "Read the enclosing symbol", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "line"], properties: {
      path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
      line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
      maxLines: { type: "number", description: "Optional maximum body size to return." },
    },
  } } };
  const body = "function add  math.ts:3-4\n\nexport function add() {\n  return 1;\n\nresult ok\nusage tokens=9 elapsed-ms=0 bytes=80 truncated=false";
  const result: SuppliedToolResult = { isError: false, content: [{ kind: "text", text: body }],
    details: { found: true, kind: "function", name: "add", startLine: 3, endLine: 4 } };
  row.parts.admitNested({ identity: "owner/source", arguments: args, complete: true, declaration });
  assert.ok(row.callComponent.render(100).map(stripTerminalSequences)[0]?.includes("src/math.ts"));
  assert.ok(!row.callComponent.render(100).map(stripTerminalSequences)[0]?.includes("function add"));
  row.parts.admitNested({ identity: "owner/source", arguments: args, complete: true, declaration, result });
  const call = row.callComponent.render(100).map(stripTerminalSequences);
  const output = row.resultComponent.render(100).map(stripTerminalSequences);
  assert.ok(call[0]?.includes("Read src/math.ts (function add; L3–4)"));
  assert.ok(output[0]?.startsWith("3 export function add"));
  assert.ok(!output.some(line => line.includes("function add  math.ts")));
  assert.ok(!output.some(line => line.includes("result ok")));
  assert.ok(row.inspectionLines("result", 200).map(stripTerminalSequences).join("\n").includes(body));
  for (const width of [1, 12, 30, 60]) {
    for (const line of [...row.callComponent.render(width), ...row.resultComponent.render(width)]) assert.ok(visibleWidth(line) <= width);
  }
  row.parts.admitNested({ identity: "owner/source", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: "original failure" }] } });
  assert.ok(!row.callComponent.render(100).map(stripTerminalSequences)[0]?.includes("function add"));
  assert.ok(row.resultComponent.render(100).map(stripTerminalSequences).includes("original failure"));
  row.parts.withdraw();
  assert.deepEqual(row.callComponent.render(100), []);
});

test("failed enclosing reads show the error and reported nested outline", () => {
  const args = { path: "src/math.ts", line: 10, maxLines: 2 };
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null });
  const row = new ToolViewRow("read_enclosing", "source-outline", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "source-fallback");
  const declaration = { description: "Read the enclosing symbol", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "line"], properties: {
      path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
      line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
      maxLines: { type: "number", description: "Optional maximum body size to return." },
    },
  } } };
  const error = "Enclosing class spans 8 lines, above maxLines 2";
  const outline = [{ name: "calculate", kind: "method", startLine: 11, endLine: 16, signature: "(values: number[])",
    parentChain: ["Calculator"], read: { path: "/fixture/src/math.ts", offset: 11, limit: 6 } }];
  const body = `Could not read: ${error}\n\nNested outline:\n${JSON.stringify(outline)}`;
  const details = { found: false, line: 10, name: "Calculator", kind: "class", startLine: 10, endLine: 17,
    selection: { strategy: "oversize-outline" }, error, outline };
  row.parts.admitNested({ identity: "owner/source-outline", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: body }], details } });
  const header = row.callComponent.render(120).map(stripTerminalSequences).join("\n");
  const output = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(header, /× Read failed.*Calculator.*L10–17/);
  assert.match(output, /Enclosing class spans[\s\S]*Nested outline:[\s\S]*src\/math\.ts[\s\S]*L11–16 method calculate/);
  assert.ok(!output.includes(JSON.stringify(outline)));
  assert.ok(row.inspectionLines("result", 500).map(stripTerminalSequences).join("\n").includes(body));
  row.parts.admitNested({ identity: "owner/source-outline", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: "new failure" }], details: { found: false, line: 10 } } });
  assert.ok(!row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("calculate"));
  row.parts.withdraw();
  assert.deepEqual(row.callComponent.render(120), []);
});

test("source warnings from result metadata appear before the code and retire on result update", () => {
  const args = { path: "src/math.ts", line: 3 };
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null });
  const row = new ToolViewRow("read_enclosing", "source-warning", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "source-fallback");
  const declaration = { description: "Read the enclosing symbol", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "line"], properties: {
      path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
      line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
      maxLines: { type: "number", description: "Optional maximum body size to return." },
    },
  } } };
  const body = "function add  math.ts:3-3\n\nfunction add() {}";
  const details = { found: true, kind: "function", name: "add", line: 3, startLine: 3, endLine: 3,
    warnings: ["Callback extraction failed: parser unavailable"] };
  row.parts.admitNested({ identity: "owner/source-warning", arguments: args, complete: true, declaration,
    result: { isError: false, content: [{ kind: "text", text: body }], details } });
  let output = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(output, /Warning: Callback extraction failed: parser unavailable[\s\S]*3 function add\(\) \{\}/);
  assert.ok(row.inspectionLines("result", 500).map(stripTerminalSequences).join("\n").includes(body));
  row.parts.admitNested({ identity: "owner/source-warning", arguments: args, complete: true, declaration,
    result: { isError: false, content: [{ kind: "text", text: body }], details: { ...details, warnings: [] } } });
  output = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.ok(!output.includes("Callback extraction failed"));
  assert.ok(output.includes("3 function add() {}"));
  row.retire();
});

test("explicit result inspection preserves metadata without adding JSON or image bytes to ordinary cards", () => {
  const f = fixture();
  const result: SuppliedToolResult = { content: [{ kind: "text", text: "Supplied output" }, { kind: "image", data: "image-data-bytes", mimeType: "image/png" }],
    details: { metadataOnlyValue: 14 }, structuredContent: { type: "image", data: "image-data-bytes", note: "Image note" }, isError: false };
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true, result });
  const inspection = f.row.inspectionLines("result", 100).map(stripTerminalSequences).join("\n");
  assert.ok(inspection.includes("Supplied output"));
  assert.ok(inspection.includes('"metadataOnlyValue": 14'));
  assert.ok(inspection.includes("Image note"));
  assert.ok(!inspection.includes("image-data-bytes"));
  assert.ok(!f.row.resultComponent.render(100).join("\n").includes("metadataOnlyValue"));
});

test("raw result inspection does not leak producer color into following UI", async () => {
  const f = fixture();
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true,
    result: { content: [{ kind: "text", text: "\x1b[31mproducer output" }], isError: false } });
  const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
  const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => terminal.write(f.row.inspectionLines("result", 80).join("\r\n") + "\r\nfooter", resolve));
    const cell = terminal.buffer.active.getLine(terminal.buffer.active.cursorY)?.getCell(0);
    assert.equal(cell?.getChars(), "f");
    assert.equal(cell?.isFgDefault(), true);
  } finally { terminal.dispose(); }
});

test("streaming output renders without final metadata and replaces the previous snapshot", () => {
  const args = { command: "long-running-command" };
  const f = fixture();
  const ctx = { ...context(args), isPartial: true };
  const row = new ToolViewRow("execute", "stream", args, ctx, theme,
    { ...f.services, compile: compileProjection }, undefined, "stream-fallback");
  row.bind({ key: "session/entry/0", entryId: "entry", ordinal: 0, eligible: true,
    call: { type: "toolCall", id: "stream", name: "execute", arguments: args },
    result: undefined, resultEntryId: undefined, declaration: {
      description: "Execute a shell command.", input: { kind: "json", schema: {
        type: "object", required: ["command"], properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
      } },
    } });
  const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");

  row.capture(args, ctx, theme, { content: [{ kind: "text", text: "first wave" }], isError: false });
  assert.ok(plain(row.resultComponent.render(100)).includes("first wave"));
  assert.ok(plain(row.callComponent.render(100)).includes("Running"));

  row.capture(args, ctx, theme, { content: [{ kind: "text", text: "second wave" }], isError: false });
  const current = plain(row.resultComponent.render(100));
  assert.ok(current.includes("second wave"));
  assert.ok(!current.includes("first wave"), "the renderer must not concatenate superseded snapshots");

  row.capture(args, { ...ctx, isPartial: false }, theme, {
    content: [{ kind: "text", text: "final failure" }], details: { exit_code: 7 }, isError: false,
  });
  assert.ok(plain(row.callComponent.render(100)).includes("Run failed"));
  assert.ok(plain(row.resultComponent.render(100)).includes("final failure"));
  assert.ok(!plain(row.resultComponent.render(100)).includes("second wave"));
  row.retire();
});

test("a returned persistent process is not titled as exited when its exit code is absent", () => {
  const args = { cmd: "node interactive.js", tty: true };
  const f = fixture();
  const row = new ToolViewRow("execute", "persistent", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "persistent-fallback");
  const snapshot = { identity: "owner/persistent", arguments: args, complete: true, declaration: {
    description: "Run shell commands; may return session_id", input: { kind: "json" as const, schema: {
      type: "object", required: ["cmd"], properties: {
        cmd: { type: "string", description: "Shell command; do not quote the entire command" },
        tty: { type: "boolean", description: "Keep stdin open for input or interruption" },
      },
    } },
  } };
  row.parts.admitNested({ ...snapshot, result: { isError: false,
    content: [{ kind: "text", text: "Session 41 still running.\nOutput:\nready for input\n" }],
    details: { output: "ready for input\n", session_id: 41 },
  } });
  const active = row.callComponent.render(100).map(stripTerminalSequences).join("\n");
  assert.ok(active.includes("Started"));
  assert.ok(!active.includes("✓"), "a completed tool invocation did not establish process exit");
  assert.ok(row.resultComponent.render(100).map(stripTerminalSequences).join("\n").includes("ready for input"));

  row.parts.admitNested({ ...snapshot, result: { isError: false,
    content: [{ kind: "text", text: "done" }], details: { output: "done", session_id: 41, exit_code: 0 },
  } });
  const exited = row.callComponent.render(100).map(stripTerminalSequences).join("\n");
  assert.ok(exited.includes("✓ Ran"));
  assert.ok(!exited.includes("Started"));
  row.retire();
});

test("a search advisory does not prevent structured rows from rendering alongside its original text", () => {
  const args = { pattern: "export", path: "schema.ts" };
  const f = fixture();
  const row = new ToolViewRow("search", "mixed-search", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "mixed-search-fallback");
  row.parts.admitNested({ identity: "owner/search", arguments: args, complete: true, declaration: {
    description: "Search file contents.", input: { kind: "json", schema: {
      type: "object", required: ["pattern"], properties: {
        pattern: { type: "string", description: "Search pattern (literal text or regex)." },
        path: { type: "string", description: "Path constraint on repository paths." },
        caseSensitive: { type: "boolean", description: "Force case-sensitive matching." },
      },
    } },
  }, result: { isError: false, details: { matchLimitReached: 4 }, content: [{ kind: "text", text:
    "schema.ts:3:export type Schema = JsonObject;\nschema.ts-4-\n\n[4 matches limit reached. Use limit=8 for more, or refine pattern]",
  }] } });
  const lines = row.resultComponent.render(120).map(stripTerminalSequences);
  assert.ok(lines.includes("schema.ts"));
  assert.ok(lines.some(line => line.startsWith("› 3 export type Schema")));
  assert.ok(lines.includes("Result limit reached."));
  assert.ok(row.inspectionLines("result", 200).map(stripTerminalSequences).join("\n").includes("4 matches limit reached"));
  assert.ok(!lines.some(line => line.includes("schema.ts:3:")));
  f.setSettings({ lineNumbers: false });
  assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).includes("› export type Schema = JsonObject;"));
  row.retire();
});

test("one-row argument previews bound long strings and do not mutate the full input", () => {
  const input = { code: "x".repeat(2_000_000), other: [false, null] };
  const preview = previewJson(input, 160);
  assert.equal(preview.clipped, true);
  assert.ok(preview.text.length <= 161);
  assert.equal(input.code.length, 2_000_000);
  assert.deepEqual(previewJson({ value: "actual" }, 100), { text: '{"value":"actual"}', clipped: false });
});

test("reported zero-based positions display one-based coordinates without changing column units", () => {
  assert.equal(locationText({ target: { kind: "file", path: "source.ts" }, line: 0, indexBase: 0, character: 2, characterUnit: "utf16" }),
    "source.ts:1:3 (UTF-16 column)");
  assert.equal(locationText({ target: { kind: "uri", uri: "custom:source" }, line: 4, indexBase: 1, characterUnit: "unreported" }), "custom:source:4");
});

test("Native uses owner arguments in both positions and retains delegate-owned previous components", () => {
  const received: unknown[] = [];
  const previous = { render: () => ["native"], invalidate() {} };
  const native: ToolRenderers = { renderShell: "self", renderCall: (args, _theme, context) => {
    received.push({ args, contextArgs: context.args, previous: context.lastComponent });
    return previous;
  } };
  const f = fixture({ kind: "change.patch", text: "patch", format: "codex" }, native);
  f.setSettings({ diffMode: "native" });
  f.row.parts.admitNested({ identity: "owner/child", arguments: { input: "SAFE" }, complete: true });
  f.row.callComponent.render(80);
  f.row.parts.admitNested({ identity: "owner/child", arguments: { input: "SAFE2" }, complete: true });
  f.row.callComponent.render(80);
  assert.deepEqual(received, [
    { args: { input: "SAFE" }, contextArgs: { input: "SAFE" }, previous: undefined },
    { args: { input: "SAFE2" }, contextArgs: { input: "SAFE2" }, previous },
  ]);
  assert.deepEqual(f.ctx.args, f.args);
});

test("outline cards show symbols while result inspection retains the complete supplied data", () => {
  const f = fixture();
  const args = { paths: ["src"] };
  const row = new ToolViewRow("outline", "outline-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "outline-fallback");
  const text = JSON.stringify({ outline: [{ path: "src/a.ts", items: [{ name: "run", symbolType: "function" }] }] }) + "\nsource footer";
  row.parts.admitNested({ identity: "owner/outline", arguments: args, complete: true, declaration: {
    description: "Inspect source structure.", input: { kind: "json", schema: {
      type: "object", required: ["paths"], properties: {
        paths: { type: "array", items: { type: "string" }, description: "Files or directories to outline." },
        lang: { type: "string", enum: ["typescript"] },
      },
    } },
  }, result: { content: [{ kind: "text", text }], details: { syntaxOnly: true, other: "retained detail" }, isError: false } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /src\/a\.ts[\s\S]*function run[\s\S]*source footer/);
  assert.ok(!visible.includes('"symbolType"'));
  const inspection = row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n");
  assert.ok(inspection.includes(text));
  assert.ok(inspection.includes("retained detail"));
  row.retire();
});

test("module reports display symbols and graph availability without discarding the original result", () => {
  const f = fixture();
  const args = { path: "src/a.ts" };
  const row = new ToolViewRow("report", "report-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "report-fallback");
  const text = JSON.stringify({ available: true, staleness: "fresh", path: "src/a.ts",
    api: [{ name: "run", kind: "function", startLine: 3, endLine: 5, signature: "()" }],
    callGraph: { available: false, reason: "stale" } });
  row.parts.admitNested({ identity: "owner/report", arguments: args, complete: true, declaration: {
    description: "Inspect a module.", input: { kind: "json", schema: {
      type: "object", required: ["path"], properties: {
        path: { type: "string", description: "Source file, e.g. src/a.ts." },
        maxRefsPerSymbol: { type: "number", description: "Cap on who-uses-this entries per symbol." },
      },
    } },
  }, result: { content: [{ kind: "text", text }], isError: false } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /src\/a\.ts[\s\S]*L3–5 function run\(\)[\s\S]*callGraph:[\s\S]*available: false[\s\S]*stale/);
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  row.retire();
});

test("navigation cards group reported locations and retain the original producer result", () => {
  const f = fixture();
  const args = { operation: "references", path: "/workspace/a.ts", line: 3 };
  const row = new ToolViewRow("navigation", "navigation-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "navigation-fallback");
  const uri = "file:///workspace/a.ts";
  const raw = (line: number) => ({ uri, range: { start: { line, character: 2 }, end: { line, character: 5 } } });
  const reported = (line: number) => ({ uri, filePath: "/workspace/a.ts", range: {
    start: { line: line + 1, character: 3 }, end: { line: line + 1, character: 6 },
  } });
  const text = JSON.stringify({ operation: "references", ok: true, status: "success", resultCount: 2,
    result: [raw(2), raw(5)], locations: [reported(2), reported(5)] });
  row.parts.admitNested({ identity: "owner/navigation", arguments: args, complete: true, declaration: {
    description: "Navigate code.", input: { kind: "json", schema: { type: "object", required: ["operation"], properties: {
      operation: { type: "string", description: "LSP operation to perform." },
      path: { type: "string", description: "Target file path." },
      line: { type: "number", description: "1-based line number." },
    } } },
  }, result: { content: [{ kind: "text", text }], isError: false } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /\/workspace\/a\.ts[\s\S]*L3:3–3:6[\s\S]*L6:3–6:6/);
  assert.equal(visible.split("/workspace/a.ts").length - 1, 1);
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  row.retire();
});

test("located edits display the supplied anchor and unknown before content as an Edit", () => {
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null, diffMode: "unified" });
  const args = { path: "src/math.ts", edits: [{ op: "replace", pos: "9#KT", lines: ["console.log('hello');"] }] };
  const row = new ToolViewRow("edit", "located-edit", args, context(args), theme,
    { ...f.services, compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }, undefined, "edit-fallback");
  const declaration = { description: "Edit anchored lines", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "edits"], properties: { path: { type: "string" }, edits: { type: "array", items: {
      anyOf: [{ type: "object", required: ["op", "pos", "lines"], properties: {
        op: { type: "string", enum: ["replace"] }, pos: { type: "string", description: "Start anchor" },
        lines: { type: "array", items: { type: "string" } },
      } }],
    } } },
  } } };
  row.parts.admitNested({ identity: "owner/located", arguments: args, complete: true, declaration });
  const body = [...row.callComponent.render(120), ...row.resultComponent.render(120)].map(stripTerminalSequences).join("\n");
  assert.match(body, /(?:Updating|Updated).*src\/math\.ts/);
  assert.match(body, /9#KT\s+-\s+…[\s\S]*9\s+\+\s+console\.log\('hello'\);/);
  assert.equal(body.split("9#KT").length - 1, 1);
  row.parts.admitNested({ identity: "owner/located", arguments: args, complete: true, declaration,
    result: { isError: true, content: [{ kind: "text", text: "stale anchor" }] } });
  assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("stale anchor"));
  assert.ok(row.inspectionLines("arguments", 500).map(stripTerminalSequences).join("\n").includes("9#KT"));
  row.retire();
});

test("ranked search cards present result facts and keep the original result inspectable", () => {
  const f = fixture();
  const args = { query: "add" };
  const row = new ToolViewRow("symbol_search", "symbol-search-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "search-fallback");
  const payload = { available: true, query: "add", coverage: { files: 4, truncated: false }, results: [
    { file: "src/app.ts", score: 1.089231283737057, hits: 2, startLine: 3, endLine: 5, annotations: { fanIn: 1 } },
  ] };
  const text = `Top 1 file(s) for "add":\n  1. src/app.ts (score 1.09, 2 hit(s), line 3)\nIndex covers 4 files.\n\n${JSON.stringify(payload)}`;
  row.parts.admitNested({ identity: "owner/search", arguments: args, complete: true, declaration: {
    description: "Find files by identifier.", input: { kind: "json", schema: { type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Identifier-ish query" },
      lang: { type: "string", description: "Restrict hits to one language" },
      paths: { type: "array", items: { type: "string" } },
    } } },
  }, result: { content: [{ kind: "text", text }], isError: false,
    details: { available: true, query: "add", count: 1, coverage: payload.coverage } } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /src\/app\.ts.*L3–5.*2 hit\(s\).*score 1\.09/);
  assert.ok(!visible.includes("1.089231283737057"));
  assert.match(visible, /Index covers 4 files/);
  assert.ok(!visible.includes(JSON.stringify(payload)));
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  row.parts.admitNested({ identity: "owner/search", arguments: args, complete: true,
    result: { content: [{ kind: "text", text: "Index is still building" }], isError: true } });
  const updated = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.ok(updated.includes("Index is still building"));
  assert.ok(!updated.includes("src/app.ts"));
  row.retire();
});

test("grouped search results retain pagination without inserting a blank line before locations", () => {
  const f = fixture();
  const args = { lang: "typescript", pattern: "call($X)", paths: ["src"] };
  const row = new ToolViewRow("search", "search-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "search-fallback");
  const text = "1 file, 1 match:\nsrc/a.ts (1): L4:2\n\n(Use skip=1 for the next page.)";
  row.parts.admitNested({ identity: "owner/search", arguments: args, complete: true, declaration: {
    description: "Search source syntax.", input: { kind: "json", schema: { type: "object", properties: {
      lang: { type: "string", enum: ["typescript"] }, pattern: { type: "string", description: "AST pattern." },
      validateOnly: { type: "boolean" }, paths: { type: "array", items: { type: "string" } },
    } } },
  }, result: { content: [{ kind: "text", text }], isError: false,
    details: { groupByFile: true, matchCount: 1, hasMore: true, matchLocations: [{ file: "src/a.ts", line: 4 }] } } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /1 file, 1 match:\nsrc\/a\.ts[^\n]*\n  L4:2\n\n\(Use skip=1 for the next page\.\)/);
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  row.retire();
});

test("structural rewrites show request templates without asserting that files changed", () => {
  const request: RequestView = { kind: "change.structural", language: "typescript", pattern: "console.log($MSG)",
    rewrite: "console.info($MSG)", paths: ["src/a.ts"], constraints: {}, intent: "apply" };
  const f = fixture(request);
  f.row.parts.admitNested({ identity: "owner/child", arguments: f.args, complete: true,
    result: { content: [{ kind: "text", text: "[NOT APPLIED] No matches found." }], details: { applied: true, matchCount: 0 }, isError: false } });
  const call = f.row.callComponent.render(120).map(stripTerminalSequences).join("\n");
  const result = f.row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(call, /Processed rewrite src\/a\.ts[\s\S]*Pattern[\s\S]*console\.log\(\$MSG\)[\s\S]*Replacement template[\s\S]*console\.info\(\$MSG\)/);
  assert.ok(!call.includes("Rewrote code"));
  assert.equal(result.split("\n")[0], "");
  assert.ok(result.includes("[NOT APPLIED] No matches found."));
  assert.ok(f.row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes("matchCount"));
  const preview: RequestView = { ...request, intent: "preview" };
  const title = titleFacts("tool", preview, undefined, true, true, false, false, true);
  assert.equal(title.label, "Previewed changes");
  assert.equal(title.target, "src/a.ts");
  f.row.retire();
});

test("structural search presents its selector and scope without treating it as file content", () => {
  const request: RequestView = { kind: "search.ast", language: "typescript", selector: { kind: "structural",
    pattern: "call($X)", constraints: { nodeKind: "call_expression", contains: { relation: "child", kind: "identifier" } } },
    paths: ["src", "test"] };
  const f = fixture(request);
  const call = f.row.callComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(call, /Pattern[\s\S]*call\(\$X\)[\s\S]*Constraints[\s\S]*nodeKind:[\s\S]*call_expression[\s\S]*child[\s\S]*identifier[\s\S]*Paths: src, test/);
  f.row.retire();
});

test("hover cards display reported code and location while preserving the original result", () => {
  const f = fixture();
  const args = { operation: "hover", path: "/workspace/a.ts", line: 3 };
  const row = new ToolViewRow("hover", "hover-call", args, context(args), theme,
    { ...f.services, compile: compileProjection }, undefined, "hover-fallback");
  const text = JSON.stringify({ operation: "hover", ok: true, status: "success", filePath: "/workspace/a.ts", resultCount: 1,
    result: { contents: { kind: "markdown", value: "\n```typescript\nfunction add(a: number): number\n```\n" },
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } } } });
  row.parts.admitNested({ identity: "owner/hover", arguments: args, complete: true, declaration: {
    description: "Navigate code.", input: { kind: "json", schema: { type: "object", properties: {
      operation: { type: "string", description: "LSP operation to perform." },
      path: { type: "string", description: "Target file path." }, line: { type: "number" },
    } } },
  }, result: { content: [{ kind: "text", text }], isError: false } });

  const visible = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(visible, /function add\(a: number\): number[\s\S]*\/workspace\/a\.ts[\s\S]*L3:5–3:8/);
  assert.ok(!visible.includes("```"));
  assert.ok(!visible.includes('"contents"'));
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  row.retire();
});

test("reported edit keeps its diff and warnings without the model-facing anchor list", () => {
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null, diffMode: "split" });
  const args = { path: "src/math.ts", edits: [{ op: "replace", pos: "3#WB", lines: ["new"] }] };
  const declaration = { description: "Edit anchored lines", input: { kind: "json" as const, schema: {
    type: "object", required: ["path", "edits"], properties: { path: { type: "string" }, edits: { type: "array", items: {
      anyOf: [{ type: "object", required: ["op", "pos", "lines"], properties: {
        op: { type: "string", enum: ["replace"] }, pos: { type: "string", description: "Start anchor" },
        lines: { type: "array", items: { type: "string" } },
      } }],
    } } },
  } } };
  const original = "--- Anchors 1-4 ---\n1#WY:before\n2#HJ:\n3#MP:new\n4#HQ:after\n\nWarnings:\nchanged elsewhere";
  const result: SuppliedToolResult = { content: [{ kind: "text", text: original }], isError: false,
    details: { classification: "applied", diff: "  1#WY:before\n  2#HJ:\n- 3    old\n+ 3#MP:new\n  4#HQ:after" } };
  const row = new ToolViewRow("edit", "anchor-output", args, context(args), theme,
    { ...f.services, compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }, undefined, "edit-fallback");
  row.parts.admitNested({ identity: "owner/anchor", arguments: args, complete: true, declaration, result });

  for (const settings of [{ diffMode: "split" as const, diffContext: 3, lineNumbers: true },
    { diffMode: "unified" as const, diffContext: 0, lineNumbers: false }]) {
    f.setSettings(settings);
    const displayed = [...row.callComponent.render(120), ...row.resultComponent.render(120)].map(stripTerminalSequences).join("\n");
    assert.ok(displayed.includes("old") && displayed.includes("new"));
    assert.ok(displayed.includes("Warnings:") && displayed.includes("changed elsewhere"));
    assert.ok(!displayed.includes("--- Anchors 1-4 ---"));
  }
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(original));
  row.retire();
});

test("transfer requests show anchor intent and retain genuine failure output", () => {
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null, diffMode: "unified" });
  const args = { path: "example.ts", source_from: "abcde", source_to: "fghij", anchor: "klmno", direction: "after" };
  const declaration = { description: "Duplicate a range of lines at another anchor.", input: { kind: "json" as const, schema: {
    type: "object", required: ["source_from", "source_to", "anchor", "direction"], properties: { path: { type: "string" },
      source_from: { type: "string", description: "5-char anchor of the FIRST source line." },
      source_to: { type: "string", description: "5-char anchor of the LAST source line." },
      anchor: { type: "string", description: "5-char anchor of the destination line" },
      direction: { type: "string", description: "after places the block below the anchor line, before above it" },
    },
  } } };
  const row = new ToolViewRow("copy", "transfer", args, context(args), theme,
    { ...f.services, compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }, undefined, "copy-fallback");
  row.parts.admitNested({ identity: "owner/transfer", arguments: args, complete: true, declaration });
  const preview = row.callComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.match(preview, /Copy abcde–fghij → after klmno · supplied path example\.ts/);
  assert.ok(!preview.includes("+ copied content"));
  const result: SuppliedToolResult = { content: [{ kind: "text", text: "Source anchor no longer valid" }], isError: true };
  row.parts.admitNested({ identity: "owner/transfer", arguments: args, complete: true, declaration, result });
  assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("Source anchor no longer valid"));
  assert.ok(row.inspectionLines("arguments", 500).map(stripTerminalSequences).join("\n").includes("abcde"));
  assert.ok(row.inspectionLines("result", 500).map(stripTerminalSequences).join("\n").includes("Source anchor no longer valid"));
  row.retire();
});

test("recognized settled edit receipts are hidden but qualified summaries and uncertain outcomes remain", () => {
  const f = fixture();
  f.setSettings({ horizontalRules: "none", resultRows: null, diffMode: "unified" });
  const args = { path: "src/app.ts", edits: [{ set_line: { anchor: "1:abc", new_text: "new" } }] };
  const declaration = { description: "Edit anchored lines", input: { kind: "json" as const, schema: {
    type: "object", required: ["path"], properties: { path: { type: "string" }, edits: { type: "array", items: { anyOf: [
      { type: "object", properties: { set_line: { type: "object", properties: {
        anchor: { type: "string", description: "Fresh LINE:HASH anchor" }, new_text: { type: "string" },
      } } } },
    ] } } },
  } } };
  const text = "[Context hygiene] earlier read is stale\n\n---\nEdited src/app.ts (1 change, +1 -0 line)\n\nWarnings:\nretained warning";
  const numbered = " 1 old\n+2 new";
  const patch = "Index: src/app.ts\n==========\n--- src/app.ts\n+++ src/app.ts\n@@ -1 +1,2 @@\n old\n+new\n";
  const details = { diff: numbered, patch, diffData: { version: 1, entries: [], stats: { added: 1, removed: 0 } },
    ptcValue: { ok: true, tool: "edit", summary: "Updated src/app.ts", diff: numbered }, contextHygiene: { schemaVersion: 1, classification: "mutation" } };
  const result: SuppliedToolResult = { content: [{ kind: "text", text }], details, isError: false };
  const row = new ToolViewRow("edit", "receipt", args, context(args), theme,
    { ...f.services, compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }, undefined, "receipt-fallback");
  row.parts.admitNested({ identity: "owner/receipt", arguments: args, complete: true, declaration, result });

  const call = row.callComponent.render(120).map(stripTerminalSequences).join("\n");
  const body = row.resultComponent.render(120).map(stripTerminalSequences).join("\n");
  assert.ok(call.includes("new") && call.includes("old"));
  assert.ok(body.includes("[Context hygiene] earlier read is stale") && body.includes("retained warning"));
  assert.ok(!body.includes("Edited src/app.ts") && !body.includes("---"));
  assert.ok(row.inspectionLines("result", 1000).map(stripTerminalSequences).join("\n").includes(text));
  assert.ok(!row.parts.result.render(120).map(stripTerminalSequences).join("\n").includes("Edited src/app.ts"));

  const qualified = { ...result, content: [{ kind: "text" as const, text: text.replace("(1 change, +1 -0 line)", "(1 change, +1 -0 line) [semantic: moved]") }] };
  row.parts.admitNested({ identity: "owner/receipt", arguments: args, complete: true, declaration, result: qualified });
  assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("[semantic: moved]"));
  const retained: SuppliedToolResult[] = [
    { ...result, isError: true },
    { ...result, details: { ...details, truncated: true } },
    { ...result, details: { ...details, ptcValue: { ...details.ptcValue, summary: "Updated another.ts" } } },
    { ...result, details: { ...details, diffData: { ...details.diffData, stats: { added: 2, removed: 0 } } } },
    { ...result, content: [{ kind: "text", text: text.replace("+1 -0 line)", "+2 -0 lines)") }], details: { ...details, diffData: { ...details.diffData, stats: { added: 2, removed: 0 } } } },
    { ...result, details: { ...details, patch: "not a patch", diff: "not a diff", ptcValue: { ...details.ptcValue, diff: "not a diff" } } },
  ];
  for (const uncertain of retained) {
    row.parts.admitNested({ identity: "owner/receipt", arguments: args, complete: true, declaration, result: uncertain });
    assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("Edited src/app.ts"));
    assert.ok(row.resultComponent.render(120).map(stripTerminalSequences).join("\n").includes("retained warning"));
  }

  row.retire();
});
