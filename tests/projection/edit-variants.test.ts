import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";

const text = { type: "string" };
const item = (key: string, properties: Record<string, { type: string; description?: string }>) => ({ type: "object", properties: { [key]: { type: "object", properties } } });
const readmap = compileProjection({ description: "Edit anchored lines", input: { kind: "json", schema: {
  type: "object", required: ["path"], properties: { path: text, edits: { type: "array", items: { anyOf: [
    item("set_line", { anchor: { type: "string", description: "Fresh LINE:HASH anchor" }, new_text: text }),
    item("replace", { old_text: { type: "string", description: "Non-empty exact target text" }, new_text: text, all: { type: "boolean" }, fuzzy: { type: "boolean" } }),
    item("replace_symbol", { symbol: text, new_body: { type: "string", description: "Non-blank complete symbol body" } }),
    item("copy_lines", { start_anchor: { type: "string", description: "First source line (LINE:HASH)" }, end_anchor: { type: "string", description: "Last source line (LINE:HASH)" }, after_anchor: { type: "string", description: "Insert the copy after this line of path (LINE:HASH)" }, from_path: { type: "string", description: "Source file to copy from; default path" } }),
    item("move_lines", { start_anchor: { type: "string", description: "First line to move (LINE:HASH)" }, end_anchor: { type: "string", description: "Last line to move (LINE:HASH)" }, after_anchor: { type: "string", description: "Move the lines after this line (LINE:HASH)" }, from_path: { type: "string", description: "Move from this file into path; default path" } }),
  ] } } },
} } });

test("mixed anchored, matching, symbol and transfer edits retain their request semantics", () => {
  const request = readmap.request({ path: "dest.ts", edits: [
    { set_line: { anchor: "2:abc", new_text: "next" } },
    { replace: { old_text: "old", new_text: "new", all: true, fuzzy: true } },
    { replace_symbol: { symbol: "Thing.run", new_body: "run() { return 1; }" } },
    { copy_lines: { from_path: "src.ts", start_anchor: "3:abc", end_anchor: "5:def", after_anchor: "8:ghi" } },
    { move_lines: { from_path: "src.ts", start_anchor: "4:abc", end_anchor: "6:def", after_anchor: "9:ghi" } },
  ] });
  assert.equal(request.kind, "change.replacements");
  if (request.kind !== "change.replacements") return;
  assert.deepEqual(request.requestedEdits.map(edit => "kind" in edit ? edit.kind : "replacement"), ["located", "match", "symbol", "transfer", "transfer"]);
  assert.deepEqual(request.requestedEdits[1], { kind: "match", path: "dest.ts", oldText: "old", newText: "new", all: true, fuzzy: true });
  assert.deepEqual(request.requestedEdits[4], { kind: "transfer", path: "", operation: "move",
    source: { path: "src.ts", start: "4:abc", end: "6:def" }, destination: { path: "dest.ts", anchor: "9:ghi", direction: "after" } });
  for (const layout of ["unified", "split"] as const) {
    const output = renderDiffPresentation(buildDiffPresentation(request, undefined), 120, { layout }).join("\n");
    assert.match(output, /Requested match \(all matches, fuzzy fallback\)/);
    assert.match(output, /symbol Thing\.run/);
    assert.match(output, /Copy src\.ts 3:abc–5:def → dest\.ts after 8:ghi/);
    assert.match(output, /Move src\.ts 4:abc–6:def → dest\.ts after 9:ghi/);
    assert.ok(output.includes("run() { return 1; }") && output.includes("old") && output.includes("new"));
  }
});

const transferSchema = { type: "object", required: ["source_from", "source_to", "anchor", "direction"], properties: {
  path: text, source_from: { type: "string", description: "5-char anchor of the FIRST source line." },
  source_to: { type: "string", description: "5-char anchor of the LAST source line." },
  anchor: { type: "string", description: "5-char anchor of the destination line; the block lands before or after it and it may live in another file." },
  direction: { type: "string", enum: ["after", "before"], description: "after places the block below the anchor line, before above it" },
} };
test("standalone transfer declarations distinguish copy from move without assigning the supplied path to an endpoint", () => {
  for (const [description, operation] of [["Duplicate a range of lines at another anchor.", "copy"], ["Relocate a range of lines to another anchor.", "move"]] as const) {
    const projection = compileProjection({ description, input: { kind: "json", schema: transferSchema } });
    assert.deepEqual(projection.request({ path: "source-or-target.ts", source_from: "abcde", source_to: "fghij", anchor: "klmno", direction: "before" }), {
      kind: "change.replacements", requestedEdits: [{ kind: "transfer", path: "", operation, source: { start: "abcde", end: "fghij" },
        destination: { anchor: "klmno", direction: "before" }, contextPath: "source-or-target.ts" }],
    });
  }
  assert.equal(compileProjection({ description: "Edit lines", input: { kind: "json", schema: transferSchema } }).request({ source_from: "abcde", source_to: "fghij", anchor: "klmno", direction: "before" }).kind, "uninterpreted");
});

test("replace-match retains its anchored range and fragment semantics", () => {
  const schema = { type: "object", required: ["replace_from", "replace_to", "match", "replacement"], properties: {
    path: text, replace_from: { type: "string", description: "5-char anchor of the FIRST line of the range searched." },
    replace_to: { type: "string", description: "5-char anchor of the LAST line of the range searched" },
    match: { type: "string", description: "The exact text to find inside the selected lines. Every occurrence inside the range is replaced." },
    replacement: { type: "string", description: "The exact replacement for every matched occurrence within the range." },
  } };
  const projection = compileProjection({ description: "Replace part of a line", input: { kind: "json", schema } });
  const request = projection.request({ path: "a.ts", replace_from: "abcde", replace_to: "fghij", match: "old\r\n", replacement: "new\n" });
  assert.deepEqual(request, { kind: "change.replacements", requestedEdits: [{ kind: "match", path: "a.ts", oldText: "old", newText: "new", all: true, fuzzy: false, range: { start: "abcde", end: "fghij" } }] });
  const output = renderDiffPresentation(buildDiffPresentation(request, undefined), 80, { layout: "unified" }).join("\n");
  assert.match(output, /Requested match in abcde–fghij \(all matches\)/);
  assert.ok(output.includes("old") && output.includes("new"));
  assert.equal(projection.request({ replace_from: "abcde", replace_to: "fghij", match: "bad\nline", replacement: "x" }).kind, "uninterpreted");
});

test("edit variants preserve unknown values and do not partially interpret mixed requests", () => {
  const copy = { copy_lines: { start_anchor: "1:abc", end_anchor: "2:def", after_anchor: "7:ghi" } };
  const request = readmap.request({ path: "same.ts", edits: [copy] });
  assert.deepEqual(request, { kind: "change.replacements", requestedEdits: [{ kind: "transfer", path: "same.ts", operation: "copy",
    source: { path: "same.ts", start: "1:abc", end: "2:def" }, destination: { path: "same.ts", anchor: "7:ghi", direction: "after" } }] });
  const defaults = readmap.request({ path: "a", edits: [{ replace: { old_text: "x", new_text: "" } }] });
  assert.deepEqual(defaults, { kind: "change.replacements", requestedEdits: [{ kind: "match", path: "a", oldText: "x", newText: "", all: false, fuzzy: false }] });
  for (const edits of [
    [copy, { replace_symbol: { symbol: "x", new_body: " " } }],
    [copy, { replace: { old_text: "", new_text: "y" } }],
    [copy, { replace: { old_text: "x", new_text: "y", all: "true" } }],
    [copy, { move_lines: { start_anchor: "0:bad", end_anchor: "2:def", after_anchor: "7:ghi" } }],
    [copy, { move_lines: { start_anchor: "1:abc", end_anchor: "2:def", after_anchor: "7:ghi", extra: true } }],
  ]) assert.equal(readmap.request({ path: "a", edits }).kind, "uninterpreted");
});

test("transfer previews contain the supplied targets but do not invent copied source text", () => {
  const request = readmap.request({ path: "dest.ts", edits: [{ move_lines: {
    from_path: "src.ts", start_anchor: "3:abc", end_anchor: "5:def", after_anchor: "8:ghi",
  } }] });
  const plan = buildDiffPresentation(request, undefined);
  assert.equal(plan.units[0]?.scope.kind, "call");
  for (const layout of ["unified", "split"] as const) {
    const rows = renderDiffPresentation(plan, 100, { layout, context: 0 });
    const text = rows.join("\n");
    assert.match(text, /Move src\.ts 3:abc–5:def → dest\.ts after 8:ghi/);
    assert.ok(!rows.some(row => /^\s*[+-]\s/.test(row)));
  }
});

test("ambiguous transfer contracts and missing required paths remain uninterpreted", () => {
  const args = { source_from: "abcde", source_to: "fghij", anchor: "klmno", direction: "after" };
  const descriptions = ["Edit lines", "Duplicate a range of lines at another anchor. Relocate a range of lines to another anchor."];
  for (const description of descriptions) {
    assert.equal(compileProjection({ description, input: { kind: "json", schema: transferSchema } }).request(args).kind, "uninterpreted");
  }
  const requiredPath = { ...transferSchema, required: [...transferSchema.required, "path"] };
  const projection = compileProjection({ description: "Duplicate a range of lines at another anchor.", input: { kind: "json", schema: requiredPath } });
  assert.equal(projection.request(args).kind, "uninterpreted");
  const ambiguousDirection = { ...transferSchema, properties: { ...transferSchema.properties, direction: { type: "string" } } };
  assert.equal(compileProjection({ description: "Duplicate a range of lines at another anchor.", input: { kind: "json", schema: ambiguousDirection } }).request(args).kind, "uninterpreted");
  const reversed = { ...transferSchema, properties: { ...transferSchema.properties, direction: { type: "string", description: "after above it, before below it" } } };
  assert.equal(compileProjection({ description: "Duplicate a range of lines at another anchor.", input: { kind: "json", schema: reversed } }).request(args).kind, "uninterpreted");

});

test("conflicting nested variant declarations do not select an arbitrary interpretation", () => {
  const schema = { type: "object", required: ["path"], properties: { path: text, edits: { type: "array", items: { anyOf: [
    item("set_line", { anchor: { type: "string", description: "Fresh LINE:HASH anchor" }, new_text: text }),
    item("replace", { old_text: { type: "string", description: "Non-empty exact target text" }, new_text: text }),
    item("replace", { old_text: { type: "string", description: "A different matching contract" }, new_text: text }),
  ] } } } };
  const projection = compileProjection({ description: "Edit anchored lines", input: { kind: "json", schema } });
  assert.equal(projection.request({ path: "a", edits: [{ replace: { old_text: "old", new_text: "new" } }] }).kind, "uninterpreted");
});

test("a cross-file move keeps reported diffs and failure details separate from its request", () => {
  const request = readmap.request({ path: "dest.ts", edits: [{ move_lines: {
    from_path: "src.ts", start_anchor: "3:abc", end_anchor: "5:def", after_anchor: "8:ghi",
  } }] });
  const result = { parts: [
    { kind: "diff" as const, origin: "reported" as const, representations: { unified: "--- src.ts\n+++ src.ts\n@@ -1 +1 @@\n-old\n+new\n" } },
    { kind: "original-content" as const },
  ] as const, reportedFailure: true as const };
  const plan = buildDiffPresentation(request, result);
  assert.ok(plan.units.every(unit => unit.origin === "reported"));
  assert.ok(plan.context.some(part => part.kind === "original-content"));
  assert.ok(renderDiffPresentation(plan, 80, { layout: "unified" }).some(row => row.includes("old")));
  assert.ok(renderDiffPresentation(plan, 120, { layout: "unified" }).some(row => row.includes("Requested: Move src.ts 3:abc–5:def → dest.ts after 8:ghi")));
  const preview = buildDiffPresentation(request, undefined);
  assert.ok(renderDiffPresentation(preview, 80, { layout: "unified" }).some(row => row.includes("Move src.ts")));
});

test("recognized matching edits display a reported indexed diff and preserve warnings", () => {
  const request = readmap.request({ path: "a.ts", edits: [{ replace: { old_text: "old", new_text: "new" } }] });
  const patch = "Index: a.ts\n====================================\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const original = "Edit completed with a warning";
  const view = readmap.result({ content: [{ kind: "text", text: original }], details: { diff: "-1 old\n+1 new", patch }, isError: false }, request);
  const plan = buildDiffPresentation(request, view);
  assert.ok(plan.units.some(unit => unit.origin === "reported"));
  assert.ok(plan.context.some(part => part.kind === "original-content"));
  const rendered = renderDiffPresentation(plan, 80, { layout: "split" }).join("\n");
  assert.ok(rendered.includes("old") && rendered.includes("new"));
});
