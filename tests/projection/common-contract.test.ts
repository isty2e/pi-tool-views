import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import { titleFacts } from "../../src/display/title.ts";
import { parseNumbered } from "../../src/diff/formats.ts";
import type { EffectiveDeclaration, Json, RequestView, ResultView, SuppliedToolResult } from "../../src/presentation.ts";

const string = { type: "string" };
const declaration = (properties: Json, required: string[], description = ""): EffectiveDeclaration => ({
  description, input: { kind: "json", schema: { type: "object", properties, required } },
});
const replacement = compileProjection(declaration({ path: string, edits: { type: "array", items: {
  type: "object", required: ["oldText", "newText"], properties: { oldText: string, newText: string, path: string },
} } }, ["path", "edits"]));
const pair = { oldText: "alpha", newText: "beta" };
const top = { oldText: "return 1;", newText: "return 2;" };
const supplied = (text: string, details?: Json): SuppliedToolResult => ({ content: [{ kind: "text", text }], isError: false, ...(details ? { details } : {}) });

test("replacement carriers use the same constructor without simulating execution", () => {
  const expected = { kind: "change.replacements", requestedEdits: [{ path: "a.ts", ...pair }, { path: "a.ts", ...top }] };
  for (const edits of [[pair], pair, JSON.stringify([pair]), JSON.stringify(pair)]) {
    const args = { path: "a.ts", edits, ...top, displaySummary: "two replacements", unrelated: true };
    const before = structuredClone(args);
    assert.deepEqual(replacement.request(args), expected);
    assert.deepEqual(args, before);
  }
  assert.deepEqual(replacement.request({ path: "a.ts", ...pair }), {
    kind: "change.replacements", requestedEdits: [{ path: "a.ts", ...pair }],
  });
  assert.deepEqual(replacement.request({ path: "a.ts", edits: [pair, pair], ...pair }), {
    kind: "change.replacements", requestedEdits: Array.from({ length: 3 }, () => ({ path: "a.ts", ...pair })),
  });
});

test("malformed carriers are not repaired or allowed to erase an independent complete pair", () => {
  assert.deepEqual(replacement.request({ path: "a.ts", edits: [pair, { oldText: 4 }], ...top }), {
    kind: "change.replacements", requestedEdits: [{ path: "a.ts", ...top }],
  });
  assert.equal(replacement.request({ path: "a.ts", oldText: "x" }).kind, "uninterpreted");
  assert.equal(replacement.request({ path: "a.ts", edits: [pair, { oldText: 4 }] }).kind, "uninterpreted");
});

const readDeclaration = declaration({
  path: { ...string, description: "Path to the file to read" },
  offset: { type: "integer", description: "Line number to start reading from (1-indexed)" },
  limit: { type: "integer", description: "Maximum number of lines to read" },
  raw: { type: "boolean", description: "Return plain text without LINE#HASH anchors" },
}, ["path"], "Read a text file. Every line returns as LINE#HASH:content. Set raw: true to return plain file content without prefixes.");

test("numbered anchored reads normalize positions and identifiers but raw mode never strips source", () => {
  const projection = compileProjection(readDeclaration);
  const text = "40#MY:export const x = 1;\n41#QV:  tail\n\n[Showing lines 40-41 of 50. Use offset=42 to continue.]";
  const request = projection.request({ path: "a.ts", offset: 40, limit: 2 });
  const view = projection.result(supplied(text, { snapshotId: "snapshot" }), request);
  assert.deepEqual(view.parts[0], { kind: "source", path: "a.ts", source: {
    text: "export const x = 1;\n  tail", firstLine1: 40, lineIdentifiers: ["MY", "QV"],
  } });
  assert.equal(titleFacts("read", request, view, true, true, false, false, false).target, "a.ts (L40–41)");
  assert.ok(view.parts.some(part => part.kind === "notice" && part.text.includes("offset=42")));
  assert.deepEqual(projection.result(supplied("40#my:literal"), request).parts, [{ kind: "source", path: "a.ts", source: {
    text: "literal", firstLine1: 40, lineIdentifiers: ["my"],
  } }], "identifiers remain opaque and retain their supplied case across read/search/diff");
  for (const raw of [true, null, "false"]) {
    const rawRequest = projection.request({ path: "a.ts", raw });
    assert.deepEqual(projection.result(supplied("1#MY:literal source"), rawRequest).parts, [{ kind: "original-content" }]);
  }
  for (const invalid of ["40#MY:a\n42#QV:b", "40#MY:a\nnot annotated", "0#MY:a", "40#MY:a\n41#QV:b\n\n[Showing lines 40-41 of 50. Use offset=99 to continue.]"]) {
    assert.deepEqual(projection.result(supplied(invalid), request).parts, [{ kind: "original-content" }]);
  }
});

test("read titles prefer actual returned extent and never invent requested endpoints", () => {
  const target = (request: RequestView, view?: ResultView, complete = true, failed = false) =>
    titleFacts("read", request, view, true, complete, failed, false, false).target;
  const request = { kind: "source.lines", path: "a.ts", firstLine1: 40, lineLimit: 200 } as const;
  const view: ResultView = { parts: [{ kind: "source", path: "a.ts", source: { text: "one\ntwo", firstLine1: 40 } }] };
  assert.equal(target(request, view), "a.ts (L40–41)");
  assert.equal(target({ kind: "source.lines", path: "a.ts" }, view), "a.ts (L40–41)");
  assert.equal(target(request, { parts: [{ kind: "source", path: "a.ts", source: { text: "one\ntwo\n", firstLine1: 40 } }] }),
    "a.ts (L40–42)", "an explicitly returned final blank row has the same position in title and body");
  assert.equal(target({ kind: "source.lines", path: "a.ts" }, { parts: [{ kind: "text", text: "opaque" }],
    sourceSelection: { path: "a.ts", range: { lastLine1: 42 } } }), "a.ts (L–42)");
  assert.equal(target(request), "a.ts");
  assert.equal(target(request, undefined, false), "a.ts (requested L40–239)");
  assert.equal(target({ kind: "source.lines", path: "a.ts", lineLimit: 7 }, undefined, false), "a.ts (requested up to 7 lines)");
  assert.equal(target({ kind: "source.lines", path: "a.ts", firstLine1: 40 }, undefined, true, true), "a.ts (requested L40–)");
  for (const [range, label] of [[{ firstLine1: 40 }, "L40–"], [{ lastLine1: 42 }, "L–42"], [{}, ""]] as const) {
    assert.equal(target({ kind: "source.symbol", path: "a.ts", symbol: "x" }, { parts: [{ kind: "text", text: "opaque" }], sourceSelection: { path: "a.ts", range } }),
      label ? `a.ts (selected ${label})` : "a.ts");
  }
});

const searchDeclaration = declaration({
  pattern: { ...string, description: "Search pattern (regex or literal string)" },
  path: { ...string, description: "Directory or file to search" },
  literal: { type: "boolean", description: "Treat the pattern as literal text" },
  context: { type: "number", description: "Number of lines to show before and after each match" },
}, ["pattern"], "Search file contents for a pattern. Returns matching lines with file paths and line numbers.");

test("overlapping search context merges exact supplied rows and promotes matches", () => {
  const projection = compileProjection(searchDeclaration);
  const text = "a.ts-2- before\na.ts:3: hit\na.ts-4- other\na.ts-3- hit\na.ts:4: other\na.ts-5- tail\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]";
  const view = projection.result(supplied(text, { matchLimitReached: 2 }));
  assert.deepEqual(view.parts[0], { kind: "file-matches", groups: [{ path: "a.ts", rows: [
    { kind: "line", line1: 2, text: "before", role: "context" },
    { kind: "line", line1: 3, text: "hit", role: "match" },
    { kind: "line", line1: 4, text: "other", role: "match" },
    { kind: "line", line1: 5, text: "tail", role: "context" },
  ] }] });
  assert.ok(view.parts.some(part => part.kind === "coverage" && part.reason === "limit"));
  const conflicts = projection.result(supplied("a.ts:3: one\na.ts:3: two\na.ts:10: next\na.ts:3: one"));
  assert.equal(conflicts.parts[0]?.kind, "file-matches");
  assert.ok(JSON.stringify(conflicts).includes("two"));
  assert.equal(JSON.stringify(conflicts).split('"text":"one"').length - 1, 2, "separate regions retain repeated source");
});

test("grouped search keeps annotations, source indentation, cursor and unknown fragments", () => {
  const projection = compileProjection(searchDeclaration);
  const text = 'a.ts  [staged_new in git]\n 3-   before\n 4:   hit\n 3-   before\n\n[Continue with cursor="next"]';
  const view = projection.result(supplied(text, { totalMatched: 1, totalFiles: 2 }));
  assert.deepEqual(view.parts[0], { kind: "file-matches", groups: [{ path: "a.ts", annotation: "[staged_new in git]", rows: [
    { kind: "line", line1: 3, text: "  before", role: "context" }, { kind: "line", line1: 4, text: "  hit", role: "match" },
  ] }] });
  assert.ok(JSON.stringify(view).includes('cursor=\\"next\\"'));
  assert.deepEqual(projection.result(supplied(text)).parts, [{ kind: "original-content" }], "grammar needs its supplied evidence");
  assert.deepEqual(projection.result({ ...supplied(text, { totalMatched: 1, totalFiles: 2 }), isError: true }).parts, [{ kind: "original-content" }]);
});

test("anchored search uses common identifiers without guessing which context row matched", () => {
  const projection = compileProjection({ ...searchDeclaration, description: "Search files using ripgrep. Every matched line returns as LINE#HASH:content." });
  const text = "a.ts:\n3#JP:  return 2;\n---\n1 match in 1 file.";
  const request = projection.request({ pattern: "return" });
  const view = projection.result(supplied(text, { matches: 1, files: 1, truncated: false }), request);
  assert.deepEqual(view.parts[0], { kind: "file-matches", groups: [{ path: "a.ts", rows: [
    { kind: "line", line1: 3, identifier: "JP", text: "  return 2;", role: "match" },
  ] }] });
  const withContext = projection.result(supplied(text, { matches: 1, files: 1, truncated: false }), projection.request({ pattern: "return", context: 1 }));
  assert.ok(JSON.stringify(withContext).includes('"role":"unreported"'));
});

test("listings have paths rather than fabricated source coordinates", () => {
  const projection = compileProjection(declaration({ pattern: { ...string, description: "Glob pattern to match files" },
    path: { ...string, description: "Directory to search in" } }, ["pattern"],
    "Search for files by glob pattern. Returns matching file paths relative to the search directory."));
  const request = projection.request({ pattern: "*.ts" });
  const view = projection.result(supplied("src/a.ts\nsrc/b.ts"), request);
  assert.deepEqual(view.parts, [{ kind: "file-list", entries: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }]);
  assert.deepEqual(projection.result(supplied("No files found matching pattern"), request).parts, [{ kind: "original-content" }]);
});

test("numbered diff derives old context only within a consistent contiguous segment", () => {
  const parsed = parseNumbered(" 1#MY:head\n 2#QV:stable\n-3      old\n+3#JP:new\n+4#VK:added\n 5#SQ:tail");
  const blocks = parsed?.sections.flatMap(section => section.kind === "hunks" ? section.hunks.flatMap(hunk => hunk.blocks) : []) ?? [];
  assert.deepEqual(blocks.filter(block => block.kind === "context").map(block => [block.oldLine1, block.newLine1]), [[1, 1], [2, 2], [4, 5]]);
  assert.ok(blocks.filter(block => block.kind === "context").every(block => !("oldLabel" in block)));
  const separated = parseNumbered(" 1#MY:unknown old\n   ...\n-8      old\n+9#JP:new\n 10#SQ:tail");
  const first = separated?.sections[0];
  assert.ok(first?.kind === "hunks");
  const head = first.hunks[0]?.blocks[0];
  assert.ok(head?.kind === "context");
  assert.equal(head.oldLine1, undefined);
  const implicit = parseNumbered(" 1#MY:unknown old\n+2#QV:added\n+4#JP:added after a gap\n-8      old\n+5#VK:new\n 6#SQ:tail");
  const implicitSection = implicit?.sections[0];
  assert.ok(implicitSection?.kind === "hunks");
  const implicitBlocks = implicitSection.hunks.flatMap(hunk => hunk.blocks);
  const unknown = implicitBlocks[0];
  assert.ok(unknown?.kind === "context");
  assert.equal(unknown.oldLine1, undefined, "an implied after-side gap also interrupts before-position derivation");
  assert.ok(implicitBlocks.some(block => block.kind === "gap"));
});

test("anchor-search summaries keep meaningful counts and truncation coverage separate", () => {
  const projection = compileProjection({ ...searchDeclaration, description: "Search files. Matched rows use LINE#HASH:content." });
  const request = projection.request({ pattern: "x" });
  for (const [matches, files, ending] of [[1, 1, "1 match in 1 file."], [2, 2, "2 matches in 2 files."]] as const) {
    const view = projection.result(supplied(`a.ts:\n3#JP:x\n---\n${ending}`, { matches, files, truncated: false }), request);
    assert.ok(view.parts.some(part => part.kind === "text" && part.text === ending && part.role === undefined));
  }
  const partial = projection.result(supplied("a.ts:\n3#JP:x\n---\n1 match in 1 file. (truncated at 1)", {
    matches: 1, files: 1, truncated: true,
  }), request);
  assert.ok(partial.parts.some(part => part.kind === "text" && part.text.includes("truncated") && !part.role));
  const unknownRequest = projection.result(supplied("a.ts:\n3#JP:x\n---\n1 match in 1 file.", { matches: 1, files: 1, truncated: false }));
  assert.ok(JSON.stringify(unknownRequest).includes('"role":"unreported"'));
});

test("directory and annotated listings preserve real labels and decline partial path data", () => {
  const listing = compileProjection(declaration({ path: { ...string, description: "Directory to list" } }, [],
    "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories."));
  const request = listing.request({ path: "." });
  assert.deepEqual(listing.result(supplied("src/\na file.ts"), request).parts, [{ kind: "file-list", entries: [
    { path: "src", directory: true }, { path: "a file.ts" },
  ] }]);
  const paged = supplied('src/a.ts  [modified in git]\n\n[2 more matches available. cursor="next" to continue]', {
    totalMatched: 3, totalFiles: 3, hasMore: true,
  });
  const page = listing.result(paged, request);
  assert.deepEqual(page.parts[0], { kind: "file-list", entries: [{ path: "src/a.ts", annotation: "[modified in git]" }] });
  assert.ok(page.parts.some(part => part.kind === "coverage" && part.reason === "continuation"));
  for (const invalid of [
    supplied("src/\npartial", { truncation: { truncated: true } }),
    supplied("src/\n\nWarning: unable to read another directory"),
    { ...paged, isError: true },
  ]) assert.deepEqual(listing.result(invalid, request).parts, [{ kind: "original-content" }]);
});

test("source footer roles do not demote diagnostics or change original bytes", () => {
  const projection = compileProjection(declaration({
    path: { ...string, description: "Absolute or workspace-relative path to the source file" },
    symbol: { ...string, description: "Exact symbol name or callback handle to read" },
  }, ["path", "symbol"]));
  const request = projection.request({ path: "a.ts", symbol: "x" });
  const body = "const x = 1;";
  const footer = "\n\nresult ok\ndiag severity=warning path=a.ts message=check this\nusage tokens=1 elapsed-ms=0 bytes=12 truncated=false";
  const result = supplied("const x  a.ts:3-3\n\n" + body + footer, { found: true, name: "x", kind: "const", startLine: 3, endLine: 3 });
  const before = structuredClone(result);
  const view = projection.result(result, request);
  const source = view.parts.find(part => part.kind === "source");
  assert.ok(source?.kind === "source" && source.source.text === body);
  assert.ok(view.parts.some(part => part.kind === "notice" && part.severity === "warning" && part.text.includes("check this")));
  assert.equal(view.parts.flatMap(part => part.kind === "text" || part.kind === "notice" ? [part.text] : []).join(""), footer);
  assert.deepEqual(result, before);
});

test("exact replacement receipts are secondary but mixed warnings and partial outcomes are not", () => {
  const request = replacement.request({ path: "a.ts", ...pair });
  for (const text of ["Edited a.ts.", "Successfully replaced 1 block(s) in a.ts."]) {
    assert.deepEqual(replacement.result(supplied(text), request).parts, [{ kind: "text", text, role: "receipt" }]);
    assert.deepEqual(replacement.result(supplied(text, { status: "partial" }), request).parts, [
      { kind: "changes", changes: [], application: { scope: { kind: "call" }, outcome: "reported-partial" } },
      { kind: "original-content" },
    ]);
    assert.deepEqual(replacement.result({ ...supplied(text), isError: true }, request).parts, [{ kind: "original-content" }]);
  }
  for (const text of ["Edited a.ts.\nWarning: incomplete coverage", "Edited other.ts.", "Successfully replaced 2 block(s) in a.ts."]) {
    assert.deepEqual(replacement.result(supplied(text), request).parts, [{ kind: "original-content" }]);
  }
});
