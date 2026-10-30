import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { ToolViewRow } from "../../src/display/row.ts";
import type { RenderContext, RowServices } from "../../src/display/row.ts";
import type { RequestView, ResultView } from "../../src/presentation.ts";
import { defaults } from "../../src/settings/model.ts";
import type { Settings } from "../../src/settings/model.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text,
  bold: (text: string) => text } as Theme;
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);

function fixture(request: RequestView, resultView?: ResultView, native?: ToolRenderers, nativeMode = false) {
  const args = { request: "opaque original input" };
  const context: RenderContext = { args, state: {}, toolCallId: "actual-call", cwd: "/fixture", argsComplete: true,
    executionStarted: true, isPartial: true, isError: false, expanded: true, showImages: true, outputPad: 1,
    lastComponent: undefined, durationMs: 12, invalidate() {} };
  let settings: Settings = { ...defaults, diffMode: nativeMode ? "native" as const : "unified" as const,
    horizontalRules: "both" as const, resultRows: null };
  const services: RowServices = { settings: () => settings, initialSettings: () => settings,
    choices: (_key, fallback) => fallback, compile: () => ({ request: () => request,
      result: () => resultView ?? { parts: [{ kind: "original-content" }] } }),
    compare: buildDiffPresentation, renderDiff: renderToolDiff, home: "/fixture", now: () => 100 };
  const row = new ToolViewRow("original_batch_tool", "actual-call", args, context, theme, services, native, "actual-call");
  row.parts.admitNested({ identity: "actual-owner/call", arguments: args, complete: true,
    ...(resultView ? { result: { isError: false, content: [{ kind: "text", text: "aggregate receipt" }] } } : {}) });
  return { row, context, args, setSettings(value: Partial<Settings>) { settings = { ...settings, ...value }; },
    replaceResult(value: ResultView) {
      resultView = value;
      row.parts.admitNested({ identity: "actual-owner/call", arguments: args, complete: true,
        result: { isError: false, content: [{ kind: "text", text: "replacement receipt" }] } });
    } };
}

const replacements: RequestView = { kind: "change.replacements", requestedEdits: [
  { path: "a.ts", oldText: "firstBefore", newText: "firstAfter" },
  { path: "b.ts", oldText: "secondBefore", newText: "secondAfter" },
  { path: "a.ts", oldText: "thirdBefore", newText: "thirdAfter" },
] };

test("same-file compound titles retain their target and secondary count in both title modes and result phases", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "src/common.ts", oldText: "beforeOne", newText: "afterOne" },
    { path: "src/common.ts", oldText: "beforeTwo", newText: "afterTwo" },
  ] };
  const results: readonly (ResultView | undefined)[] = [undefined,
    { parts: [{ kind: "text", text: "Producer result" }] },
    { parts: [{ kind: "text", text: "Producer failure" }], reportedFailure: true },
  ];
  for (const result of results) {
    const f = fixture(request, result);
    f.setSettings({ horizontalRules: "none", showDuration: false });
    for (const titleMode of ["action", "tool"] as const) {
      f.setSettings({ titleMode });
      const header = plain(f.row.callComponent.render(120))[0]!;
      assert.match(header, /src\/common\.ts.*2 operations/);
      if (titleMode === "tool") assert.ok(header.includes("original_batch_tool"));
    }
    assert.ok(f.row.inspectionLines("arguments", 120).join("\n").includes("opaque original input"));
    f.row.retire();
  }
});

test("same-file patch operations share a title target without reparsing their diff in display", () => {
  const f = fixture({ kind: "change.patch", format: "codex", text: [
    "*** Begin Patch", "*** Update File: common.ts", "@@", "-beforeOne", "+afterOne",
    "*** Update File: common.ts", "@@", "-beforeTwo", "+afterTwo", "*** End Patch",
  ].join("\n") });
  f.setSettings({ horizontalRules: "none", showDuration: false });
  assert.match(plain(f.row.callComponent.render(100))[0]!, /common\.ts.*2 operations/);
  f.row.retire();
});

test("compound titles do not choose a representative file from differing or missing targets", () => {
  const first = { path: "a.ts", oldText: "before", newText: "after" };
  const unknown = { ...first, path: "" };
  const requests: RequestView[] = [replacements,
    { kind: "change.replacements", requestedEdits: [first, unknown] },
    { kind: "change.replacements", requestedEdits: [unknown, first] },
    { kind: "change.patch", format: "codex", text: [
      "*** Begin Patch", "*** Update File: a.ts", "@@", "-beforeOne", "+afterOne",
      "*** Update File: a.ts", "*** Move to: b.ts", "@@", "-beforeTwo", "+afterTwo", "*** End Patch",
    ].join("\n") },
  ];
  for (const request of requests) {
    const f = fixture(request);
    f.setSettings({ horizontalRules: "none", showDuration: false });
    const header = plain(f.row.callComponent.render(100))[0]!;
    const count = request.kind === "change.replacements" ? request.requestedEdits.length : 2;
    assert.ok(header.endsWith(`${count} operations`));
    assert.ok(!header.includes("a.ts") && !header.includes("b.ts"));
    f.row.retire();
  }
});

test("narrow compound titles prioritize the file and duration over the secondary count", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "source/deeply/nested/common.ts", oldText: "beforeOne", newText: "afterOne" },
    { path: "source/deeply/nested/common.ts", oldText: "beforeTwo", newText: "afterTwo" },
  ] };
  const f = fixture(request);
  f.setSettings({ horizontalRules: "none", showDuration: true });
  for (const titleMode of ["action", "tool"] as const) {
    f.setSettings({ titleMode });
    const wide = plain(f.row.callComponent.render(120))[0]!;
    assert.match(wide, /source\/deeply\/nested\/common\.ts.*2 operations.*12ms$/);
    const narrow = plain(f.row.callComponent.render(titleMode === "action" ? 30 : 46))[0]!;
    assert.ok(narrow.includes("common.ts"));
    assert.ok(!narrow.includes("operations"));
    assert.match(narrow, /12ms$/);
    for (const width of [1, 12, 30, 46, 120]) {
      assert.ok(f.row.callComponent.render(width).every(line => visibleWidth(line) <= width));
    }
  }
  f.row.retire();
});

test("single-operation and compound web titles keep their existing target selection", () => {
  const requests: readonly [RequestView, string][] = [
    [{ kind: "change.replacements", requestedEdits: [{ path: "single.ts", oldText: "before", newText: "after" }] }, "single.ts"],
    [{ kind: "web.search", input: { kind: "multiple", queries: ["one", "two"] } }, "2 operations"],
    [{ kind: "web.fetch", targets: { kind: "multiple", urls: ["https://one.test", "https://two.test"] } }, "2 operations"],
    [{ kind: "web.source-check", claim: "original claim", queries: ["one", "two"] }, "original claim"],
  ];
  for (const [request, target] of requests) {
    const f = fixture(request);
    f.setSettings({ horizontalRules: "none", showDuration: false });
    const header = plain(f.row.callComponent.render(100))[0]!;
    assert.ok(header.endsWith(` ${target}`));
    assert.equal(header.includes("operations"), target === "2 operations");
    f.row.retire();
  }
});

test("confirmed aggregate keeps each requested diff beside its file", (context) => {
  context.mock.method(performance, "now", () => 0);
  context.mock.method(Date, "now", () => 0);
  const view: ResultView = { completeEditReceipt: true, parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 firstBefore\n+1 firstAfter\n-2 thirdBefore\n+2 thirdAfter\n-1 secondBefore\n+1 secondAfter" } },
    { kind: "text", text: "Applied 3 edit(s) successfully." },
  ] };
  const { row, setSettings } = fixture(replacements, view);
  for (const diffMode of ["split", "unified"] as const) {
    setSettings({ diffMode });
    const call = plain(row.callComponent.render(100)).join("\n");
    const result = plain(row.resultComponent.render(100)).join("\n");
    assert.ok(call.indexOf("Edit a.ts") < call.indexOf("firstAfter"));
    assert.ok(call.indexOf("firstAfter") < call.indexOf("Edit b.ts"));
    assert.ok(call.indexOf("Edit b.ts") < call.indexOf("secondAfter"));
    assert.ok(call.indexOf("secondAfter") < call.lastIndexOf("Edit a.ts"));
    assert.ok(call.lastIndexOf("Edit a.ts") < call.indexOf("thirdAfter"));
    assert.ok(!call.includes("Reported changes"));
    assert.ok(result.includes("Applied 3 edit(s) successfully."));
    assert.ok(result.includes("[Show reported changes]"));
    assert.ok(!result.includes("firstAfter"));
    assert.ok(row.inspectionLines("source", 100).join("\n").includes("firstAfter"));
  }
});

test("reported changes can be revealed and are cleared on result replacement", (context) => {
  context.mock.method(performance, "now", () => 0);
  context.mock.method(Date, "now", () => 0);
  const view: ResultView = { completeEditReceipt: true, parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 firstBefore\n+1 firstAfter\n-2 thirdBefore\n+2 thirdAfter\n-1 secondBefore\n+1 secondAfter" } },
    { kind: "text", text: "Applied 3 edit(s) successfully." },
  ] };
  const f = fixture(replacements, view);
  let lines = plain(f.row.resultComponent.render(100));
  const y = lines.findIndex(line => line === "[Show reported changes]");
  assert.ok(y >= 0);
  f.row.resultComponent.handleMouse({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width: 100, height: lines.length, shift: false, ctrl: false, alt: false });
  lines = plain(f.row.resultComponent.render(100));
  assert.ok(lines.some(line => line.includes("secondAfter")));
  assert.ok(lines.includes("[Hide reported changes]"));
  assert.ok(plain(f.row.callComponent.render(100)).join("\n").includes("firstAfter"));
  f.replaceResult({ parts: [{ kind: "text", text: "Replacement result" }] });
  assert.ok(!plain(f.row.resultComponent.render(100)).includes("Reported changes"));
  assert.ok(plain(f.row.resultComponent.render(100)).includes("Replacement result"));
});

test("unconfirmed or additional changes remain visible beside the requested previews", () => {
  const view: ResultView = { completeEditReceipt: true, parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 firstBefore\n+1 firstAfter\n-2 unexpectedOld\n+2 unexpectedNew" } },
    { kind: "text", text: "Applied 3 edit(s) successfully." },
  ] };
  const { row } = fixture(replacements, view);
  const call = plain(row.callComponent.render(100)).join("\n");
  const result = plain(row.resultComponent.render(100)).join("\n");
  assert.ok(call.includes("thirdAfter"));
  assert.ok(result.includes("unexpectedNew"));
});

test("missing receipt, incomplete rows and omitted regions do not hide reported material", () => {
  const diff = "-1 firstBefore\n+1 firstAfter\n-2 thirdBefore\n+2 thirdAfter\n-1 secondBefore\n+1 secondAfter";
  const variants: ResultView[] = [
    { parts: [{ kind: "diff", origin: "reported", representations: { numbered: diff } }, { kind: "text", text: "Unknown outcome" }] },
    { completeEditReceipt: true, parts: [{ kind: "diff", origin: "reported", representations: { numbered: diff + "\n   ..." } }, { kind: "text", text: "Partial" }] },
    { completeEditReceipt: true, parts: [{ kind: "diff", origin: "reported", representations: { numbered: "-1 firstBefore\n+1 firstAfter\n-2 thirdBefore\n+2 thirdAfter\n+1 secondAfter" } }, { kind: "text", text: "Partial" }] },
    { completeEditReceipt: true, parts: [{ kind: "diff", origin: "reported", representations: { numbered: diff,
      unified: "--- a/other\n+++ b/other\n@@ -1 +1 @@\n-old\n+different" } }, { kind: "text", text: "Conflicting formats" }] },
  ];
  for (const view of variants) {
    const { row } = fixture(replacements, view);
    const call = plain(row.callComponent.render(100)).join("\n");
    const result = plain(row.resultComponent.render(100)).join("\n");
    assert.ok(call.includes("firstAfter"));
    assert.ok(result.includes("firstAfter") || result.includes("different"));
  }
});

test("repeated identical requested edits require the same number of reported changes", () => {
  const repeated: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a", oldText: "before", newText: "after" }, { path: "b", oldText: "before", newText: "after" },
  ] };
  for (const [numbered, expectedOccurrences] of [["-1 before\n+1 after", 1], ["-1 before\n+1 after\n-1 before\n+1 after", 2]] as const) {
    const { row } = fixture(repeated, { completeEditReceipt: true, parts: [
      { kind: "diff", origin: "reported", representations: { numbered } }, { kind: "text", text: "Completed" },
    ] });
    const call = plain(row.callComponent.render(100)).join("\n");
    const result = plain(row.resultComponent.render(100)).join("\n");
    assert.equal(call.split("after").length - 1, 2);
    assert.equal(result.split("after").length - 1, expectedOccurrences === 1 ? 1 : 0);
  }
});

test("compound edit bodies preserve A,B,A occurrences rather than file bundles", () => {
  const { row } = fixture(replacements);
  const lines = plain(row.callComponent.render(100));
  assert.deepEqual(lines.filter(line => line.startsWith("Edit ")), ["Edit a.ts", "Edit b.ts", "Edit a.ts"]);
  const output = lines.join("\n");
  assert.ok(output.indexOf("firstAfter") < output.indexOf("secondAfter"));
  assert.ok(output.indexOf("secondAfter") < output.indexOf("thirdAfter"));
  assert.ok(!output.includes("opaque original input"));
  assert.equal(lines.filter(line => /^─+$/.test(line)).length, 2);
  row.retire();
  assert.deepEqual(row.callComponent.render(100), []);
});

test("patch cards preserve file-operation semantics and do not split hunks", () => {
  const { row } = fixture({ kind: "change.patch", format: "codex", text: [
    "*** Begin Patch", "*** Add File: new.ts", "+new source", "*** Delete File: gone.ts",
    "*** Update File: old.ts", "*** Move to: moved.ts", "@@ first", "-beforeOne", "+afterOne",
    "@@ second", "-beforeTwo", "+afterTwo", "*** End Patch",
  ].join("\n") });
  const lines = plain(row.callComponent.render(100));
  assert.deepEqual(lines.filter(line => /^(Add|Delete|Move) /.test(line)), [
    "Add new.ts", "Delete gone.ts", "Move old.ts → moved.ts",
  ]);
  assert.ok(lines.some(line => line.includes("afterOne")));
  assert.ok(lines.some(line => line.includes("afterTwo")));
});

test("compound web actions render duplicate requests and distinct action meanings", () => {
  const { row } = fixture({ kind: "web.compound", actions: [
    { kind: "search", query: "same query" }, { kind: "open", reference: "https://example.com/", line: 12 },
    { kind: "search", query: "same query" }, { kind: "find", reference: "page-one", pattern: "needle" },
  ] }, { parts: [{ kind: "original-content" }, { kind: "notice", severity: "warning", origin: "producer", text: "partial producer notice" }] });
  const call = plain(row.callComponent.render(100));
  assert.deepEqual(call.filter(line => /^(Search|Open|Find) /.test(line)), [
    "Search same query", "Open https://example.com/ (L12)", "Search same query", "Find needle · page-one",
  ]);
  const result = plain(row.resultComponent.render(100));
  assert.equal(result.filter(line => line === "aggregate receipt").length, 1);
  assert.equal(result.filter(line => line === "partial producer notice").length, 1);
  assert.equal(call.filter(line => /^─+$/.test(line)).length, 1);
  assert.equal(result.filter(line => /^─+$/.test(line)).length, 1);
  for (const width of [1, 12, 40, 100]) {
    for (const line of [...row.callComponent.render(width), ...row.resultComponent.render(width)]) assert.ok(visibleWidth(line) <= width);
  }
});

test("unallocated reported edits remain visible beside ordered requested operations", () => {
  const { row } = fixture(replacements, { parts: [
    { kind: "diff", origin: "reported", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-beforeReported\n+afterReported\n" } },
    { kind: "original-content" },
  ] });
  const call = plain(row.callComponent.render(100)).join("\n");
  const result = plain(row.resultComponent.render(100)).join("\n");
  assert.ok(call.includes("firstAfter") && call.includes("thirdAfter"));
  assert.ok(!call.includes("afterReported"));
  assert.ok(result.includes("afterReported"));
  const inspected = plain(row.inspectionLines("source", 100)).join("\n");
  assert.ok(inspected.indexOf("firstAfter") < inspected.indexOf("secondAfter"));
  assert.ok(inspected.indexOf("secondAfter") < inspected.indexOf("thirdAfter"));
  assert.ok(inspected.includes("afterReported"));
});

test("anonymous reported regions and their following receipt are visually separated", () => {
  const { row, setSettings } = fixture(replacements, { parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 first old\n+1 first new\n-1 second old\n+1 second new" } },
    { kind: "text", text: "Applied both changes." },
  ] });
  for (const diffMode of ["split", "unified"] as const) {
    setSettings({ diffMode });
    const lines = plain(row.resultComponent.render(100));
    const second = lines.findIndex(line => line.includes("second old"));
    const receipt = lines.findIndex(line => line.includes("Applied both changes."));
    assert.equal(lines[second - 1], "");
    assert.equal(lines[receipt - 1], "");
  }
});

test("embedded result diffs preserve surrounding text and use the selected layout", () => {
  const f = fixture(replacements, { parts: [
    { kind: "text", text: "Changes reported\n" },
    { kind: "diff", origin: "reported", placement: "inline", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n" } },
    { kind: "text", text: "Warning: check output." },
  ] });
  for (const diffMode of ["split", "unified"] as const) {
    f.setSettings({ diffMode });
    const lines = plain(f.row.resultComponent.render(100));
    const text = lines.join("\n");
    assert.ok(text.indexOf("Changes reported") < text.indexOf("before"));
    assert.ok(text.indexOf("after") < text.indexOf("Warning: check output."));
    assert.equal(lines.some(line => line.includes("│")), diffMode === "split");
  }
});

test("embedded results remain readable within a narrow terminal", () => {
  const f = fixture(replacements, { parts: [
    { kind: "text", text: "Changes reported\n" },
    { kind: "diff", origin: "reported", placement: "inline", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n" } },
    { kind: "text", text: "Warning afterwards." },
  ] });
  f.setSettings({ diffMode: "split" });
  const lines = plain(f.row.resultComponent.render(24));
  assert.ok(lines.every(line => visibleWidth(line) <= 24));
  assert.ok(lines.join("\n").includes("Warning afterwards."));
  assert.ok(lines.join("\n").includes("before") && lines.join("\n").includes("after"));
});

test("a blank line following an embedded diff remains visible", () => {
  const f = fixture(replacements, { parts: [
    { kind: "text", text: "Changes reported\n" },
    { kind: "diff", origin: "reported", placement: "inline", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n" } },
    { kind: "text", text: "\nWarning: check output." },
  ] });
  const lines = plain(f.row.resultComponent.render(100));
  const warning = lines.findIndex(line => line.includes("Warning: check output."));
  assert.ok(warning > 0);
  assert.equal(lines[warning - 1], "");
});

test("a complete same-file inline diff stays available without duplicating edit previews", (context) => {
  context.mock.method(performance, "now", () => 0);
  context.mock.method(Date, "now", () => 0);
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "alpha.txt", oldText: "alpha one", newText: "first is longer now" },
    { path: "alpha.txt", oldText: "gamma three", newText: "last changed" },
  ] };
  const unified = "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,3 +1,3 @@\n-alpha one\n-beta two\n-gamma three\n+first is longer now\n+beta two\n+last changed";
  const f = fixture(request, { completeEditReceipt: true, parts: [
    { kind: "text", text: "Replaced 2 occurrences in alpha.txt\n" },
    { kind: "diff", origin: "reported", placement: "inline", representations: { unified } },
  ] });
  const call = plain(f.row.callComponent.render(100)).join("\n");
  assert.ok(call.includes("first is longer now") && call.includes("last changed"));
  let lines = plain(f.row.resultComponent.render(100));
  assert.ok(lines.includes("Replaced 2 occurrences in alpha.txt"));
  assert.ok(!lines.some(line => line.includes("beta two")));
  const y = lines.findIndex(line => line === "[Show reported changes]");
  assert.ok(y >= 0);
  f.row.resultComponent.handleMouse({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width: 100, height: lines.length, shift: false, ctrl: false, alt: false });
  lines = plain(f.row.resultComponent.render(100));
  assert.ok(lines.some(line => line.includes("beta two")));
  assert.ok(lines.findIndex(line => line.includes("Replaced 2")) < lines.findIndex(line => line.includes("beta two")));
  assert.ok(f.row.inspectionLines("source", 100).some(line => line.includes("beta two")));
});

test("native call fallback keeps an embedded result visible", () => {
  const native: ToolRenderers = { renderShell: "self", renderCall() { return { render: () => ["native call"], invalidate() {} }; } };
  const request: RequestView = { kind: "change.replacements", requestedEdits: [
    { path: "a.ts", oldText: "old", newText: "new" }, { path: "a.ts", oldText: "before", newText: "after" },
  ] };
  const view: ResultView = { completeEditReceipt: true, parts: [
    { kind: "text", text: "Replaced 2 occurrences in a.ts\n" },
    { kind: "diff", origin: "reported", placement: "inline", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n-before\n+new\n+after" } },
  ] };
  const f = fixture(request, view, native, true);
  assert.ok(plain(f.row.callComponent.render(100)).includes("native call"));
  const result = plain(f.row.resultComponent.render(100)).join("\n");
  assert.ok(result.includes("Replaced 2 occurrences") && result.includes("before") && result.includes("after"));
});

test("compound edits use compact preview labels and separate the shared result without changing it", () => {
  const resultView: ResultView = { parts: [
    { kind: "diff", origin: "reported", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-beforeReported\n+afterReported\n" } },
    { kind: "original-content" },
  ] };
  const f = fixture(replacements, resultView);
  const call = plain(f.row.callComponent.render(100));
  const result = plain(f.row.resultComponent.render(100));
  assert.deepEqual(call.filter(line => line.startsWith("Edit ")), ["Edit a.ts · preview", "Edit b.ts · preview", "Edit a.ts · preview"]);
  assert.ok(!call.includes("Requested changes"));
  assert.ok(!call.includes("a.ts") && !call.includes("b.ts"));
  assert.deepEqual(result.slice(0, 2), ["", "Result"]);
  assert.ok(!result.includes("Reported changes"));
  assert.equal(result.filter(line => line === "aggregate receipt").length, 1);
  const source = plain(f.row.inspectionLines("source", 100));
  const marker = source.indexOf("Result");
  assert.ok(marker > 0 && source[marker - 1] === "" && !source.includes("Reported changes"));
  const parts = plain(f.row.parts.result.render(100));
  assert.equal(parts[0], "Result");
  assert.deepEqual(plain(f.row.inspectionLines("result", 100)), ["aggregate receipt"]);
  f.replaceResult({ parts: [{ kind: "query-results", items: [] }] });
  assert.ok(!plain(f.row.resultComponent.render(100)).includes("Result"));
});

test("pending edits have no preview suffix and uniquely reported diffs are not labelled preview", () => {
  const pending = fixture(replacements);
  assert.deepEqual(plain(pending.row.callComponent.render(100)).filter(line => line.startsWith("Edit ")),
    ["Edit a.ts", "Edit b.ts", "Edit a.ts"]);
  const f = fixture({ kind: "change.replacements", requestedEdits: [
    { path: "a.ts", oldText: "old", newText: "new" }, { path: "b.ts", oldText: "old", newText: "new" },
  ] }, { parts: [{ kind: "diff", origin: "reported", representations: {
    unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+reported\n",
  } }] });
  const lines = plain(f.row.callComponent.render(100));
  assert.deepEqual(lines.filter(line => line.startsWith("Edit ")), ["Edit a.ts", "Edit b.ts · preview"]);
  assert.ok(lines.includes("+  reported") || lines.some(line => line.includes("reported")));
});

test("Native mode delegates the one real callback pair instead of synthetic children", () => {
  const calls: unknown[] = [];
  const results: unknown[] = [];
  const native: ToolRenderers = { renderShell: "self", renderCall(args, _theme, context) {
    calls.push([args, context.args, context.state, context.lastComponent]);
    return { render: () => ["native actual call"], invalidate() {} };
  }, renderResult(_result, _options, _theme, context) {
    results.push(context.state);
    return { render: () => ["native actual result"], invalidate() {} };
  } };
  const { row, context, args } = fixture(replacements, { parts: [{ kind: "original-content" }] }, native, true);
  assert.ok(plain(row.callComponent.render(100)).includes("native actual call"));
  assert.ok(plain(row.resultComponent.render(100)).includes("native actual result"));
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.deepEqual((calls[0] as unknown[]).slice(0, 3), [args, args, context.state]);
  assert.equal(results[0], context.state);
});

test("Native call without a native result still exposes the reported diff", () => {
  const native: ToolRenderers = { renderShell: "self", renderCall() {
    return { render: () => ["native call"], invalidate() {} };
  } };
  const view: ResultView = { completeEditReceipt: true, parts: [
    { kind: "diff", origin: "reported", representations: { numbered: "-1 firstBefore\n+1 firstAfter\n-2 thirdBefore\n+2 thirdAfter\n-1 secondBefore\n+1 secondAfter" } },
    { kind: "text", text: "Applied 3 edit(s) successfully." },
  ] };
  const { row } = fixture(replacements, view, native, true);
  assert.ok(plain(row.callComponent.render(100)).includes("native call"));
  const result = plain(row.resultComponent.render(100)).join("\n");
  assert.ok(result.includes("firstAfter"));
  assert.ok(result.includes("Applied 3 edit(s) successfully."));
});

test("associated query results share the existing preview control without hiding requested headings", () => {
  const f = fixture({ kind: "web.search", input: { kind: "multiple", queries: ["first", "second", "third"] } },
    { parts: [{ kind: "query-results", responseId: "stored-id", items: [
      { query: "first", answer: Array.from({ length: 20 }, (_, index) => `first line ${index}`).join("\n") },
      { query: "second", error: "genuine query error" }, { query: "third", answer: "third answer" },
    ] }] });
  f.setSettings({ resultRows: 3 });
  let lines = plain(f.row.callComponent.render(100));
  assert.deepEqual(lines.filter(line => line.startsWith("Search ")), ["Search first", "Search second", "Search third"]);
  assert.ok(!lines.includes("first line 19"));
  const y = lines.findIndex(line => line === "[Show full results]");
  assert.ok(y >= 0);
  f.row.callComponent.handleMouse({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width: 100, height: lines.length, shift: false, ctrl: false, alt: false });
  lines = plain(f.row.callComponent.render(100));
  assert.ok(lines.includes("first line 19"));
  assert.ok(lines.includes("genuine query error"));
  assert.ok(lines.includes("third answer"));
  const result = plain(f.row.resultComponent.render(100));
  assert.ok(result.includes("Stored search: stored-id"));
  assert.ok(!result.includes("third answer"));
  f.replaceResult({ parts: [{ kind: "original-content" }] });
  assert.ok(!plain(f.row.callComponent.render(100)).includes("third answer"));
  assert.ok(plain(f.row.resultComponent.render(100)).includes("replacement receipt"));
  f.row.parts.withdraw();
  assert.deepEqual(f.row.callComponent.render(100), []);
});

test("located source and surrounding text share line boundaries without extra blank rows", () => {
  const f = fixture({ kind: "source.enclosing", path: "src/math.ts", line1: 6 }, { parts: [
    { kind: "text", text: "function add  math.ts:3-4\n\n" },
    { kind: "source", path: "src/math.ts", source: { text: "const first = 1;\nreturn first;", firstLine1: 3 } },
    { kind: "text", text: "\n\nresult ok" },
  ] });
  f.setSettings({ horizontalRules: "none" });
  const lines = plain(f.row.resultComponent.render(100));
  assert.deepEqual(lines, ["function add  math.ts:3-4", "", "3 const first = 1;", "4 return first;", "", "result ok"]);
  f.setSettings({ lineNumbers: false });
  assert.deepEqual(plain(f.row.resultComponent.render(100)),
    ["function add  math.ts:3-4", "", "const first = 1;", "return first;", "", "result ok"]);
});
