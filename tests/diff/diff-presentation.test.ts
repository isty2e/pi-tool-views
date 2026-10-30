import assert from "node:assert/strict";
import test from "node:test";
import type { RequestView, ResultView } from "../../src/presentation.ts";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import type { DiffCell, DiffSection, DiffViewUnit } from "../../src/diff/index.ts";

function replacement(path: string, oldText: string, newText: string): RequestView {
  return { kind: "change.replacements", requestedEdits: [{ path, oldText, newText }] };
}

function onlyUnit(units: readonly DiffViewUnit[]): DiffViewUnit {
  assert.equal(units.length, 1);
  return units[0]!;
}

function cellLines(section: DiffSection, side: "before" | "after"): DiffCell[] {
  if (section.kind !== "hunks") return [];
  const result: DiffCell[] = [];
  for (const hunk of section.hunks) {
    for (const block of hunk.blocks) {
      if (block.kind === "context") {
        result.push({
          text: block.text,
          ...(side === "before" && block.oldLine1 === undefined ? {} : side === "before" ? { line1: block.oldLine1 } : {}),
          ...(side === "after" && block.newLine1 === undefined ? {} : side === "after" ? { line1: block.newLine1 } : {}),
          ...(block.lineEnding === undefined ? {} : { lineEnding: block.lineEnding }),
          emphasis: [],
        });
      } else if (block.kind === "change") {
        for (const pair of block.pairs) {
          const cell = side === "before" ? pair.before : pair.after;
          if (cell !== undefined) result.push(cell);
        }
      }
    }
  }
  return result;
}

function reconstruct(cells: readonly DiffCell[]): string {
  return cells.map((cell) => cell.text + (cell.lineEnding ?? "")).join("");
}

function onlySection(unit: DiffViewUnit, index = 0): DiffSection {
  return unit.sections[index]!;
}

function asResult(...parts: ResultView["parts"][number][]): ResultView {
  assert.ok(parts.length > 0);
  return { parts: parts as [ResultView["parts"][number], ...ResultView["parts"][number][]] };
}

test("unified decoding preserves file targets, supplied line numbers, anchors, and no-newline markers", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "unified",
    text: [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -4,3 +4,3 @@ function update()",
      " keep",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      " tail",
      "",
    ].join("\n"),
  };
  const unit = onlyUnit(buildDiffPresentation(request, undefined).units);
  assert.deepEqual(unit.scope, { kind: "file", path: "src/a.ts" });
  const section = onlySection(unit);
  assert.deepEqual(section.target, { path: "src/a.ts" });
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  assert.equal(section.hunks[0]?.anchor, "function update()");
  const change = section.hunks[0]?.blocks.find((block) => block.kind === "change");
  assert.equal(change?.kind, "change");
  if (change?.kind !== "change") return;
  assert.equal(change.pairs[0]?.before?.line1, 5);
  assert.equal(change.pairs[0]?.after?.line1, 5);
  assert.equal(change.pairs[0]?.before?.lineEnding, "");
  assert.equal(change.pairs[0]?.after?.lineEnding, "");
  assert.equal(change.pairs[0]?.before?.text, "old");
  assert.equal(change.pairs[0]?.after?.text, "new");
});

test("CRLF patch transport is not mislabeled as source line-ending evidence", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "unified",
    text: "--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n",
  };
  const section = onlySection(onlyUnit(buildDiffPresentation(request, undefined).units));
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  const change = section.hunks[0]?.blocks[0];
  assert.equal(change?.kind, "change");
  if (change?.kind === "change") {
    assert.equal(change.pairs[0]?.before?.lineEnding, undefined);
    assert.equal(change.pairs[0]?.after?.lineEnding, undefined);
  }
});

test("Codex additions keep +123 as text and path-only deletion invents no old lines", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "codex",
    text: [
      "*** Begin Patch",
      "*** Add File: src/123.txt",
      "+123 foo",
      "*** End Patch",
      "*** Delete File: src/gone.txt",
      "*** End Patch",
    ].join("\n"),
  };
  // A second End Patch is intentionally malformed: all material remains raw instead of salvaging the add.
  const malformed = onlyUnit(buildDiffPresentation(request, undefined).units);
  assert.equal(malformed.scope.kind, "call");
  assert.equal(malformed.sections[0]?.kind, "raw");

  const valid: RequestView = {
    kind: "change.patch",
    format: "codex",
    text: [
      "*** Begin Patch",
      "*** Add File: src/123.txt",
      "+123 foo",
      "*** Delete File: src/gone.txt",
      "*** End Patch",
    ].join("\n"),
  };
  const units = buildDiffPresentation(valid, undefined).units;
  assert.equal(units.length, 2);
  const added = units[0]!;
  assert.equal(added.scope.kind, "file");
  assert.deepEqual(added.scope, { kind: "file", path: "src/123.txt" });
  const addition = onlySection(added);
  assert.equal(addition.kind, "hunks");
  if (addition.kind === "hunks") {
    assert.equal(addition.activity, "added");
    const pair = addition.hunks[0]?.blocks[0];
    assert.equal(pair?.kind, "change");
    if (pair?.kind === "change") {
      assert.equal(pair.pairs[0]?.after?.text, "123 foo");
      assert.equal(pair.pairs[0]?.after?.line1, undefined);
      assert.deepEqual(pair.pairs[0]?.after?.emphasis, [{ startUtf16: 0, endUtf16: 7 }]);
    }
  }
  const deleted = onlySection(units[1]!);
  assert.equal(deleted.kind, "hunks");
  if (deleted.kind === "hunks") {
    assert.equal(deleted.activity, "deleted");
    assert.equal(deleted.hunks.length, 0);
  }
  const rendered = renderDiffPresentation({ units, applicationReports: [], context: [] }, 80, { layout: "unified" });
  assert.ok(rendered.some((line) => line.includes("src/gone.txt")));
  assert.ok(rendered.some((line) => line.includes("123 foo")));
});

test("Codex rename remains an ordered operation section and write has no fabricated before-image", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "codex",
    text: [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-const n = 1;",
      "+const n = 2;",
      "*** End Patch",
    ].join("\n"),
  };
  const unit = onlyUnit(buildDiffPresentation(request, undefined).units);
  assert.deepEqual(unit.scope, { kind: "file", path: "src/old.ts" });
  const section = onlySection(unit);
  assert.equal(section.kind, "hunks");
  if (section.kind === "hunks") {
    assert.deepEqual(section.target, { path: "src/old.ts", moveTo: "src/new.ts" });
    assert.equal(section.activity, "moved");
  }

  const write = buildDiffPresentation({ kind: "change.write", path: "src/new.ts", content: "new content\n" }, undefined);
  assert.deepEqual(write.units, []);
});

test("numbered line gaps are retained without separating paired replacements", () => {
  const presentation = buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "gaps.ts", origin: "reported", representations: { numbered: " 1 head\n-10 old\n+10 new\n 11 tail" } }),
  );
  const section = onlySection(onlyUnit(presentation.units));
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  assert.deepEqual(section.hunks[0]?.blocks.map((block) => block.kind), ["context", "gap", "change", "context"]);
  const change = section.hunks[0]?.blocks[2];
  assert.equal(change?.kind, "change");
  if (change?.kind === "change") {
    assert.equal(change.pairs.length, 1);
    assert.equal(change.pairs[0]?.before?.text, "old");
    assert.equal(change.pairs[0]?.after?.text, "new");
  }
});

test("numbered producer diffs retain an explicit omitted-region marker", () => {
  const presentation = buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "a.ts", origin: "reported", representations: { numbered: "-1 old\n+1 new\n 2 context\n   ..." } }),
  );
  const section = onlySection(onlyUnit(presentation.units));
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  assert.deepEqual(section.hunks[0]?.blocks.map((block) => block.kind), ["change", "context", "gap"]);
  assert.deepEqual(cellLines(section, "before").map(cell => cell.line1), [1, 2]);
  assert.deepEqual(cellLines(section, "after").map(cell => cell.line1), [1, 2]);

  for (const layout of ["unified", "split"] as const) {
    const lines = renderDiffPresentation(presentation, 100, { layout });
    assert.ok(lines.some(line => line.includes("old")));
    assert.ok(lines.some(line => line.includes("new")));
    assert.ok(lines.includes("…"));
  }

  const middle = onlySection(onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "a.ts", origin: "reported", representations: { numbered: "-1 old\n+1 new\n   ...\n 10 context" } }),
  ).units));
  assert.equal(middle.kind, "hunks");
  if (middle.kind === "hunks") assert.deepEqual(middle.hunks[0]?.blocks.map(block => block.kind), ["change", "gap", "context"]);

  const malformed = "-1 old\n+1 new\n   unknown";
  const raw = onlySection(onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "a.ts", origin: "reported", representations: { numbered: malformed } }),
  ).units));
  assert.equal(raw.kind, "raw");
  if (raw.kind === "raw") assert.equal(raw.sources[0].text, malformed);
});

test("malformed material is preserved all-or-raw, while equivalent encodings fall through in priority order", () => {
  const malformed = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\ntrailing unsupported data";
  const raw = onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "src/a", origin: "reported", representations: { unified: malformed, codex: "*** Begin Patch\nunfinished" } }),
  ).units);
  assert.deepEqual(raw.scope, { kind: "file", path: "src/a" });
  assert.equal(raw.sections[0]?.kind, "raw");
  if (raw.sections[0]?.kind === "raw") {
    assert.deepEqual(raw.sections[0].sources.map((source) => source.text), [malformed, "*** Begin Patch\nunfinished"]);
  }

  const numbered = "-3 older\n+5 newer";
  const fallback = onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({ kind: "diff", path: "src/a", origin: "reported", representations: { unified: malformed, numbered } }),
  ).units);
  const fallbackSection = onlySection(fallback);
  assert.equal(fallbackSection.kind, "hunks");
  if (fallbackSection.kind === "hunks") {
    const change = fallbackSection.hunks[0]?.blocks[0];
    assert.equal(change?.kind, "change");
    if (change?.kind === "change") {
      assert.equal(change.pairs[0]?.before?.line1, 3);
      assert.equal(change.pairs[0]?.after?.line1, 5);
    }
  }

  const preferred = onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({
      kind: "diff",
      path: "src/a",
      origin: "reported",
      representations: {
        unified: "--- a/src/a\n+++ b/src/a\n@@ -8 +8 @@\n-old\n+new",
        numbered: "-3 older\n+5 newer",
      },
    }),
  ).units);
  const preferredSection = onlySection(preferred);
  assert.equal(preferredSection.kind, "hunks");
  if (preferredSection.kind === "hunks") {
    const change = preferredSection.hunks[0]?.blocks[0];
    assert.equal(change?.kind, "change");
    if (change?.kind === "change") assert.equal(change.pairs[0]?.before?.line1, 8);
  }

  const codex = "*** Begin Patch\n*** Update File: src/a\n@@\n-old codex\n+new codex\n*** End Patch";
  const allAlternatives = onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({
      kind: "diff",
      path: "src/a",
      origin: "reported",
      representations: {
        unified: "--- a/src/a\n+++ b/src/a\n@@ -7 +7 @@\n-old unified\n+new unified",
        numbered: "-3 numbered\n+3 numbered",
        codex,
      },
    }),
  ).units);
  const allAlternativesSection = onlySection(allAlternatives);
  assert.equal(allAlternativesSection.kind, "hunks");
  if (allAlternativesSection.kind === "hunks") {
    const change = allAlternativesSection.hunks[0]?.blocks[0];
    assert.equal(change?.kind, "change");
    if (change?.kind === "change") {
      assert.equal(change.pairs[0]?.before?.text, "old unified");
      assert.equal(change.pairs[0]?.before?.line1, 7);
    }
  }
});

test("source selection is per reliable file and reports remain scoped evidence", () => {
  const result = asResult(
    { kind: "diff", path: "a.ts", origin: "reported", representations: { unified: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old a\n+new a" } },
    { kind: "diff", path: "c.ts", origin: "preview", representations: { numbered: "-4 preview\n+4 next" } },
    { kind: "changes", changes: [{ path: "a.ts", activity: "updated" }], application: { scope: { kind: "file", path: "a.ts" }, outcome: "reported-partial" } },
    { kind: "notice", severity: "warning", origin: "producer", text: "kept warning" },
  );
  const presentation = buildDiffPresentation({
    kind: "change.replacements",
    requestedEdits: [
      { path: "a.ts", oldText: "old request", newText: "new request" },
      { path: "b.ts", oldText: "old b", newText: "new b" },
      { path: "c.ts", oldText: "old c", newText: "new c" },
    ],
  }, result);

  assert.deepEqual(presentation.units.map(({ scope, origin }) => [scope.kind === "file" ? scope.path : "call", origin]), [
    ["a.ts", "reported"],
    ["b.ts", "request"],
    ["c.ts", "producer-preview"],
  ]);
  assert.deepEqual(presentation.applicationReports, [{ scope: { kind: "file", path: "a.ts" }, outcome: "reported-partial" }]);
  assert.deepEqual(presentation.context, [
    { kind: "changes", changes: [{ path: "a.ts", activity: "updated" }] },
    { kind: "notice", severity: "warning", origin: "producer", text: "kept warning" },
  ]);
});

test("an unattributed aggregate selects one whole-call source without file fallbacks", () => {
  const request: RequestView = {
    kind: "change.replacements",
    requestedEdits: [
      { path: "a.ts", oldText: "old a", newText: "new a" },
      { path: "b.ts", oldText: "old b", newText: "new b" },
    ],
  };
  const result = asResult({ kind: "diff", origin: "reported", representations: { numbered: "-1 reported\n+1 current" } });
  const presentation = buildDiffPresentation(request, result);
  const unit = onlyUnit(presentation.units);
  assert.deepEqual(unit.scope, { kind: "call" });
  assert.equal(unit.origin, "reported");
  assert.equal(unit.sections.length, 1);
  assert.equal(onlySection(unit).kind, "hunks");
  assert.equal(presentation.units.some((item) => item.origin === "request"), false);
});

test("conflicting target evidence remains call-scoped raw instead of assigning a guessed file", () => {
  const conflictingGitHeaders: RequestView = {
    kind: "change.patch",
    format: "unified",
    text: [
      "diff --git a/other.ts b/other.ts",
      "--- a/actual.ts",
      "+++ b/actual.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  };
  const requestUnit = onlyUnit(buildDiffPresentation(conflictingGitHeaders, undefined).units);
  assert.deepEqual(requestUnit.scope, { kind: "call" });
  assert.equal(requestUnit.sections[0]?.kind, "raw");

  const conflictingResultPath = onlyUnit(buildDiffPresentation(
    { kind: "uninterpreted" },
    asResult({
      kind: "diff",
      path: "trusted.ts",
      origin: "reported",
      representations: { unified: "--- a/actual.ts\n+++ b/actual.ts\n@@ -1 +1 @@\n-old\n+new" },
    }),
  ).units);
  assert.deepEqual(conflictingResultPath.scope, { kind: "call" });
  assert.equal(onlySection(conflictingResultPath).kind, "hunks");
});

test("same-path operations stay separate ordered sections", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "codex",
    text: [
      "*** Begin Patch",
      "*** Update File: same.ts",
      "@@ first",
      "-one",
      "+two",
      "*** Update File: same.ts",
      "@@ second",
      "-three",
      "+four",
      "*** End Patch",
    ].join("\n"),
  };
  const unit = onlyUnit(buildDiffPresentation(request, undefined).units);
  assert.equal(unit.sections.length, 2);
  const anchors = unit.sections.flatMap((section) => section.kind === "hunks" ? section.hunks.map((hunk) => hunk.anchor) : []);
  assert.deepEqual(anchors, ["first", "second"]);
});

test("old/new comparison reconstructs mixed EOL and final-newline states exactly", () => {
  const before = "alpha\r\nbeta\rgamma\nlast";
  const after = "alpha\nbeta\rgamma\nlast\n";
  const unit = onlyUnit(buildDiffPresentation(replacement("eol.txt", before, after), undefined).units);
  const section = onlySection(unit);
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  assert.equal(reconstruct(cellLines(section, "before")), before);
  assert.equal(reconstruct(cellLines(section, "after")), after);
  const changed = section.hunks.flatMap((hunk) => hunk.blocks.filter((block) => block.kind === "change"));
  assert.ok(changed.length >= 2);
  assert.ok(changed.some((block) => block.kind === "change" && block.pairs.some((pair) => pair.before?.text === "alpha" && pair.after?.text === "alpha")));
  assert.ok(changed.some((block) => block.kind === "change" && block.pairs.some((pair) => pair.before?.lineEnding === "" && pair.after?.lineEnding === "\n")));
});

test("identical supplied pairs remain empty even when refinement is disabled", () => {
  const presentation = buildDiffPresentation(replacement("same.txt", "same\r\n", "same\r\n"), undefined, { maxComparisonTokens: 0 });
  assert.deepEqual(presentation.units, []);
});

test("combining accents, modifiers, and ZWJ sequences receive grapheme-safe UTF-16 spans", () => {
  const cases = [
    { before: "ex", after: "e\u0300x", old: [0, 1], next: [0, 2] },
    { before: "👍", after: "👍🏽", old: [0, 2], next: [0, 4] },
    { before: "👨‍👩", after: "👨‍👦", old: [0, 5], next: [0, 5] },
  ] as const;

  for (const item of cases) {
    const unit = onlyUnit(buildDiffPresentation(replacement("unicode.txt", item.before, item.after), undefined).units);
    const section = onlySection(unit);
    assert.equal(section.kind, "hunks");
    if (section.kind !== "hunks") continue;
    const change = section.hunks[0]?.blocks[0];
    assert.equal(change?.kind, "change");
    if (change?.kind !== "change") continue;
    const pair = change.pairs[0]!;
    assert.deepEqual(pair.before?.emphasis.map(({ startUtf16, endUtf16 }) => [startUtf16, endUtf16]), [item.old]);
    assert.deepEqual(pair.after?.emphasis.map(({ startUtf16, endUtf16 }) => [startUtf16, endUtf16]), [item.next]);

    const oldBoundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(item.before), (part) => [part.index, part.index + part.segment.length]).flat());
    const newBoundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(item.after), (part) => [part.index, part.index + part.segment.length]).flat());
    for (const span of pair.before?.emphasis ?? []) assert.ok(oldBoundaries.has(span.startUtf16) && oldBoundaries.has(span.endUtf16));
    for (const span of pair.after?.emphasis ?? []) assert.ok(newBoundaries.has(span.startUtf16) && newBoundaries.has(span.endUtf16));
  }
});

test("aggregate token budget falls back losslessly to coarse delete/add rows", () => {
  const before = "before one\nbefore two\n";
  const after = "after one\nafter two\n";
  const unit = onlyUnit(buildDiffPresentation(replacement("large.txt", before, after), undefined, { maxComparisonTokens: 0 }).units);
  assert.equal(unit.coarseComparison, true);
  const section = onlySection(unit);
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  const block = section.hunks[0]?.blocks[0];
  assert.equal(block?.kind, "change");
  if (block?.kind !== "change") return;
  assert.equal(block.pairs.length, 4);
  assert.deepEqual(block.pairs.map((pair) => [pair.before?.text, pair.after?.text]), [
    ["before one", undefined],
    ["before two", undefined],
    [undefined, "after one"],
    [undefined, "after two"],
  ]);
  for (const pair of block.pairs) {
    const cell = pair.before ?? pair.after!;
    assert.deepEqual(cell.emphasis, [{ startUtf16: 0, endUtf16: cell.text.length }]);
  }
  assert.equal(reconstruct(cellLines(section, "before")), before);
  assert.equal(reconstruct(cellLines(section, "after")), after);
});

test("grapheme refinement exhaustion emphasizes only actual line text", () => {
  const before = "x".repeat(100);
  const after = "y".repeat(100);
  const unit = onlyUnit(buildDiffPresentation(replacement("one-line.txt", before, after), undefined, { maxComparisonTokens: 2 }).units);
  assert.equal(unit.coarseComparison, true);
  const section = onlySection(unit);
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  const change = section.hunks[0]?.blocks[0];
  assert.equal(change?.kind, "change");
  if (change?.kind !== "change") return;
  assert.deepEqual(change.pairs[0]?.before?.emphasis, [{ startUtf16: 0, endUtf16: before.length }]);
  assert.deepEqual(change.pairs[0]?.after?.emphasis, [{ startUtf16: 0, endUtf16: after.length }]);
  assert.equal(change.pairs[0]?.before?.text, before);
  assert.equal(change.pairs[0]?.after?.text, after);
});

test("old/new syntax highlighting receives independent full flows", () => {
  const before = '"""before\nshared text\n"""\n';
  const after = '"""after\nshared text\n"""\n';
  const presentation = buildDiffPresentation(replacement("doc.py", before, after), undefined);
  const flows: { side: string; text: string[] }[] = [];
  const changedCalls: { text: string; spans: readonly { startUtf16: number; endUtf16: number }[] }[] = [];

  renderDiffPresentation(presentation, 200, { layout: "unified" }, {
    highlightFlow(cells, side) {
      flows.push({ side, text: cells.map((cell) => cell.text) });
      return cells.map((cell) => `${side}:${cell.text}`);
    },
    applyChange(cell, syntaxText, spans) {
      changedCalls.push({ text: cell.text, spans });
      return `${syntaxText}[${spans.map(({ startUtf16, endUtf16 }) => `${startUtf16}-${endUtf16}`).join(",")}]`;
    },
  });

  const old = flows.find((flow) => flow.side === "before");
  const next = flows.find((flow) => flow.side === "after");
  assert.ok(old?.text.includes('"""before'));
  assert.ok(next?.text.includes('"""after'));
  assert.equal(old?.text.includes('"""after'), false);
  assert.equal(next?.text.includes('"""before'), false);
  assert.ok(old?.text.includes("shared text"));
  assert.ok(next?.text.includes("shared text"));
  assert.deepEqual(changedCalls.map(({ text }) => text), ['"""before', '"""after']);
});

test("context zero, unknown gutters, and Unified/Split share the same values", () => {
  const presentation = buildDiffPresentation(replacement("pair.ts", "first\nold a\nold b\nlast\n", "first\nnew a\nnew b\nlast\n"), undefined);
  const section = onlySection(onlyUnit(presentation.units));
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") return;
  const allCells = cellLines(section, "before").concat(cellLines(section, "after"));
  assert.ok(allCells.every((cell) => cell.line1 === undefined));

  const zeroContext = renderDiffPresentation(presentation, 100, { layout: "unified", context: 0 });
  assert.equal(zeroContext.some((line) => line.includes("first") || line.includes("last")), false);
  assert.ok(zeroContext.some((line) => line.includes("old a")));
  assert.ok(zeroContext.some((line) => line.includes("new b")));

  const unified = renderDiffPresentation(presentation, 100, { layout: "unified", context: 0 });
  const split = renderDiffPresentation(presentation, 70, { layout: "split", context: 0 });
  assert.ok(split.some((line) => line.includes("│")));
  assert.ok(unified.some((line) => line.includes("old a")) && unified.some((line) => line.includes("new a")));
  assert.ok(split.some((line) => line.includes("old a") && line.includes("new a")));
  assert.ok(split.some((line) => line.includes("old b") && line.includes("new b")));
  assert.deepEqual(unified.filter((line) => /^\s*-\s/.test(line)).map((line) => line.replace(/^\s*-\s+/, "")), ["old a", "old b"]);
  assert.deepEqual(unified.filter((line) => /^\s*\+\s/.test(line)).map((line) => line.replace(/^\s*\+\s+/, "")), ["new a", "new b"]);
  const splitValues = split.filter((line) => line.includes("│")).map((line) => {
    const [before, after] = line.split("│");
    return [before!.trim().replace(/^-\s+/, ""), after!.trim().replace(/^\+\s+/, "")];
  });
  assert.deepEqual(splitValues, [["old a", "new a"], ["old b", "new b"]]);
  const narrowSplit = renderDiffPresentation(presentation, 20, { layout: "split", context: 0 });
  assert.ok(narrowSplit.some((line) => line.includes("│")));
  assert.ok(unified.filter((line) => /^\s*-\s/.test(line)).every((line) => /^\s*-\s+old/.test(line)));

  assert.equal(renderDiffPresentation(presentation, 80, { layout: "auto", autoSplitMinContentWidth: 20 }).some((line) => line.includes("│")), true);
  assert.equal(renderDiffPresentation(presentation, 30, { layout: "auto", autoSplitMinContentWidth: 20 }).some((line) => line.includes("│")), false);
});

test("separate hunk and file sections reset syntax state", () => {
  const request: RequestView = {
    kind: "change.patch",
    format: "codex",
    text: [
      "*** Begin Patch",
      "*** Update File: one.py",
      "@@",
      "-first old",
      "+first new",
      "*** Update File: two.py",
      "@@",
      "-second old",
      "+second new",
      "*** End Patch",
    ].join("\n"),
  };
  const presentation = buildDiffPresentation(request, undefined);
  const captured: { side: string; cells: string[] }[] = [];
  renderDiffPresentation(presentation, 120, { layout: "split" }, {
    highlightFlow(cells, side) {
      captured.push({ side, cells: cells.map((cell) => cell.text) });
      return cells.map((cell) => cell.text);
    },
  });
  assert.deepEqual(captured.map((flow) => [flow.side, flow.cells]), [
    ["before", ["first old"]],
    ["after", ["first new"]],
    ["before", ["second old"]],
    ["after", ["second new"]],
  ]);
});

test("application-report collisions remain context instead of inventing reductions", () => {
  const ambiguous = asResult(
    { kind: "changes", changes: [{ path: "same.ts", activity: "updated" }], application: { scope: { kind: "file", path: "same.ts" }, outcome: "reported-complete" } },
    { kind: "changes", changes: [{ path: "same.ts", activity: "updated" }], application: { scope: { kind: "file", path: "same.ts" }, outcome: "reported-failure" } },
  );
  const presentation = buildDiffPresentation({ kind: "uninterpreted" }, ambiguous);
  assert.deepEqual(presentation.applicationReports, []);
  assert.deepEqual(presentation.context, ambiguous.parts);
});

test("unified diff displays distinct before and after positions without a header", () => {
  const plan = { units: [{ scope: { kind: "call" as const }, origin: "reported" as const, sections: [{ kind: "hunks" as const, hunks: [{ blocks: [
    { kind: "context" as const, text: "context", oldLine1: 31, newLine1: 24 },
    { kind: "change" as const, pairs: [{ before: { text: "old", line1: 33, emphasis: [] }, after: { text: "new", line1: 25, locationLabel: "25#MP", emphasis: [] } }] as const },
    { kind: "context" as const, text: "tail", newLine1: 26 },
  ] as const }] }] as const }], applicationReports: [], context: [] };
  const lines = renderDiffPresentation(plan, 80, { layout: "unified", showHeadings: false });
  assert.match(lines[0]!, /^\s*31\s+24\s+\s+context$/);
  assert.match(lines[1]!, /^\s*33\s+\s+-\s+old$/);
  assert.match(lines[2]!, /^\s+25#MP\s+\+\s+new$/);
  assert.match(lines[3]!, /^\s+26\s+\s+tail$/);
  const noNumbers = renderDiffPresentation(plan, 80, { layout: "unified", showHeadings: false, lineNumbers: false });
  assert.ok(noNumbers.every(line => !/31|24|33|25#MP|26/.test(line)));
  assert.ok(noNumbers.some(line => line.includes("- old")) && noNumbers.some(line => line.includes("+ new")));
});

test("split diff places each side's line number before the change marker", () => {
  const request: RequestView = { kind: "change.patch", format: "unified", text: "--- a/a.ts\n+++ b/a.ts\n@@ -31,2 +24,2 @@\n context\n-old\n+new\n" };
  const lines = renderDiffPresentation(buildDiffPresentation(request, undefined), 80, { layout: "split", showHeadings: false });
  assert.ok(lines.some(line => /^\s*31\s+\s+context.*│\s*24\s+\s+context/.test(line)));
  assert.ok(lines.some(line => /^\s*32\s+-\s+old.*│\s*25\s+\+\s+new/.test(line)));
});

test("unified columns keep unknown sides blank and preserve wrapped text at narrow widths", () => {
  const plan = { units: [{ scope: { kind: "call" as const }, origin: "reported" as const, sections: [{ kind: "hunks" as const, hunks: [{ blocks: [
    { kind: "context" as const, text: "context", oldLine1: 12345 },
    { kind: "change" as const, pairs: [{ after: { text: "ABCDEFGH", line1: 3, emphasis: [] } }] as const },
  ] as const }] }] as const }], applicationReports: [], context: [] };
  const wide = renderDiffPresentation(plan, 80, { layout: "unified", showHeadings: false });
  assert.match(wide[0]!, /^\s*12345\s+\s+\s+context$/);
  assert.match(wide[1]!, /^\s+3\s+\+\s+ABCDEFGH$/);
  for (const width of [2, 6, 8, 12, 18]) {
    const lines = renderDiffPresentation(plan, width, { layout: "unified", showHeadings: false });
    assert.ok(lines.every(line => line.length <= width));
    const source = lines.map(line => line.trim().replace(/^\+\s*/, "").replace(/^\d+\s*/, "")).join("");
    assert.ok(source.includes("context"));
    assert.ok(source.includes("ABCDEFGH"));
  }
});

test("unified number columns are sized independently for their displayed sides", () => {
  for (const [oldLine1, newLine1, newLabel, expected] of [
    [3, 3, "3#MP", "3 3#MP"],
    [12345, 4, "4", "12345 4"],
  ] as const) {
    const plan = { units: [{ scope: { kind: "call" as const }, origin: "reported" as const, sections: [{ kind: "hunks" as const, hunks: [{ blocks: [
      { kind: "context" as const, text: "shared", oldLine1, newLine1, newLabel },
      { kind: "change" as const, pairs: [{ before: { text: "old", line1: oldLine1, emphasis: [] }, after: { text: "new", line1: newLine1, locationLabel: newLabel, emphasis: [] } }] as const },
    ] as const }] }] as const }], applicationReports: [], context: [] };
    const lines = renderDiffPresentation(plan, 80, { layout: "unified", showHeadings: false });
    assert.ok(lines[0]!.startsWith(`${expected} `), JSON.stringify(lines));
    assert.match(lines[1]!, /- old$/);
    assert.match(lines[2]!, /\+ new$/);
  }
});

test("unified widths ignore omitted context and keep a short side visible on narrow terminals", () => {
  const plan = { units: [{ scope: { kind: "call" as const }, origin: "reported" as const, sections: [{ kind: "hunks" as const, hunks: [{ blocks: [
    { kind: "context" as const, text: "hidden", oldLine1: 123456789, newLine1: 42 },
    { kind: "change" as const, pairs: [{ before: { text: "old", line1: 3, emphasis: [] }, after: { text: "new", line1: 3, locationLabel: "3#MP", emphasis: [] } }] as const },
  ] as const }] }] as const }], applicationReports: [], context: [] };
  const rows = renderDiffPresentation(plan, 80, { layout: "unified", context: 0, showHeadings: false });
  assert.ok(rows[0]!.startsWith("3      - old"));
  assert.ok(rows[1]!.startsWith("  3#MP + new"));

  const narrow = renderDiffPresentation(plan, 11, { layout: "unified", context: 0, showHeadings: false });
  assert.ok(narrow.some(line => line.includes("3#MP")));
  assert.equal(narrow.map(line => line.slice(9)).join(""), "oldnew");
});
