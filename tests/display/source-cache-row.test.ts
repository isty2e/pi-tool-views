import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { ToolViewRow } from "../../src/display/row.ts";
import type { RenderContext, RowServices } from "../../src/display/row.ts";
import type { Json, RequestView } from "../../src/presentation.ts";
import { defaults } from "../../src/settings/model.ts";

initTheme("light", false);
const theme = { fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => value,
  bold: (value: string) => value } as Theme;
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");

function fixture(request: () => RequestView, args: Json = { value: "input" }) {
  let now = 100;
  let settings = { ...defaults, codeInitiallyVisible: true, shellSourceInitiallyVisible: true };
  const context: RenderContext = { toolCallId: "source-cache", args, state: {}, cwd: "/fixture", expanded: true, isPartial: true,
    argsComplete: true, executionStarted: true, isError: false, durationMs: undefined, showImages: false, outputPad: 0, lastComponent: undefined, invalidate() {} };
  const services: RowServices = {
    settings: () => settings, initialSettings: () => settings, home: "/fixture",
    choices: (_key, fallback) => fallback,
    compile: () => ({ request, result: () => ({ parts: [{ kind: "original-content" }] }) }), compare: buildDiffPresentation, renderDiff: renderToolDiff,
    now: () => now,
  };
  const row = new ToolViewRow("source", "source-cache", args, context, theme, services, undefined, "fallback");
  row.capture(args, context, theme);
  row.parts.admitNested({ identity: "owned/source", arguments: args, complete: true });
  return { row, args, context, advance() { now = 500; }, settings(value: typeof settings) { settings = value; } };
}

test("owned-source variants refresh value/layout while timing and source controls remain live", () => {
  for (const initial of [
    { kind: "program.javascript", source: "const before = 1;" }, { kind: "program.typescript", source: "const before: number = 1;" },
    { kind: "shell.launch", command: "echo before" }, { kind: "change.write", path: "a.ts", content: "const before = 1;" },
    { kind: "code.ast-dump", source: "const before = 1;", language: "javascript" },
  ] satisfies RequestView[]) {
    let request: RequestView = initial;
    const f = fixture(() => request);
    const first = f.row.callComponent.render(80);
    assert.ok(plain(first).includes("before"));
    const source = f.row.inspectionLines("source", 80);
    f.advance();
    const later = f.row.callComponent.render(80);
    assert.ok(plain(later).includes("400ms"));
    assert.deepEqual(f.row.inspectionLines("source", 80), source);
    if (request.kind === "shell.launch") request = { ...request, command: "echo after" };
    else if (request.kind === "change.write") request = { ...request, content: "const after = 2;" };
    else if (request.kind === "program.javascript" || request.kind === "program.typescript" || request.kind === "code.ast-dump") request = { ...request, source: "const after = 2;" };
    f.row.markDirty();
    assert.ok(plain(f.row.callComponent.render(40)).includes("after"));
    f.settings({ ...defaults, codeInitiallyVisible: true, shellSourceInitiallyVisible: true, lineNumbers: false });
    assert.ok(plain(f.row.inspectionLines("source", 40)).includes("after"));
    f.row.retire();
    assert.deepEqual(f.row.callComponent.render(80), []);
    assert.ok(!plain(f.row.inspectionLines("source", 80)).includes("after"));
  }
});

test("same-object prepared arguments refresh expanded JSON without resetting its choice", () => {
  const args = { value: "before ".repeat(30) };
  const f = fixture(() => ({ kind: "uninterpreted" }), args);
  const call = f.row.render("call", 60);
  const expand = call.buttons.find(button => plain([call.lines[button.y]!]).includes("Show full arguments"))!;
  assert.ok(expand);
  f.row.callComponent.render(60);
  f.row.callComponent.handleMouse({ type: "click", button: "left", x: expand.x, y: expand.y, screenX: expand.x, screenY: expand.y,
    width: 60, height: call.lines.length, shift: false, ctrl: false, alt: false });
  assert.ok(plain(f.row.callComponent.render(60)).includes("before"));
  args.value = "after ".repeat(30);
  f.row.capture(args, { ...f.context, argsComplete: false, executionStarted: false }, theme);
  f.row.capture(args, f.context, theme);
  const updated = plain(f.row.callComponent.render(60));
  assert.ok(updated.includes("after") && !updated.includes("before"));
  assert.ok(plain(f.row.inspectionLines("arguments", 60)).includes("after"));
  assert.ok(updated.includes("Collapse arguments"));
  f.row.retire();
});

test("source and inspection repaint after palette replacement behind a stable theme facade", () => {
  const f = fixture(() => ({ kind: "program.javascript", source: "const value = 123;" }));
  let colors: Readonly<{ revision: number }> = Object.freeze({ revision: 1 });
  const facade = { ...theme, get colors() { return colors; }, getColorMode: () => "truecolor" } as unknown as Theme;
  try {
    f.row.capture(f.args, f.context, facade);
    const light = f.row.inspectionLines("source", 80);
    f.row.callComponent.render(80);
    initTheme("dark", false);
    colors = Object.freeze({ revision: 2 });
    f.row.capture(f.args, f.context, facade);
    const dark = f.row.inspectionLines("source", 80);
    assert.equal(plain(light), plain(dark));
    assert.notDeepEqual(light, dark);
    assert.ok(f.row.callComponent.render(80).includes(dark[0]!));
  } finally { f.row.retire(); initTheme("light", false); }
});
