import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import type { ChangedLinePair, DiffPresentation } from "../../src/diff/model.ts";
import type { RequestView } from "../../src/presentation.ts";

function replacements(before: readonly string[], after: readonly string[], maxComparisonTokens?: number): DiffPresentation {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [{ path: "example.ts",
    oldText: before.join("\n") + "\n", newText: after.join("\n") + "\n" }] };
  return buildDiffPresentation(request, undefined, { timeoutMs: 500, ...(maxComparisonTokens === undefined ? {} : { maxComparisonTokens }) });
}

function changedPairs(presentation: DiffPresentation): ChangedLinePair[] {
  return presentation.units.flatMap(unit => unit.sections.flatMap(section => section.kind !== "hunks" ? []
    : section.hunks.flatMap(hunk => hunk.blocks.flatMap(block => block.kind === "change" ? block.pairs : []))));
}

function correspondence(presentation: DiffPresentation): (string | undefined)[][] {
  return changedPairs(presentation).map(pair => [pair.before?.text, pair.after?.text]);
}

const before = [
  "const account = loadAccount(id);",
  "const balance = loadBalance(account);",
  "return formatBalance(balance);",
];
const after = [
  "logStart();",
  "const account = loadAccount(userId);",
  "logBalance();",
  "const balance = loadBalance(account.id);",
  "return formatBalance(balance, currency);",
  "logEnd();",
];
const expected = [
  [undefined, after[0]],
  [before[0], after[1]],
  [undefined, after[2]],
  [before[1], after[3]],
  [before[2], after[4]],
  [undefined, after[5]],
];

test("replacement, Codex, unified and numbered changes share insertion-aware correspondence", () => {
  const codex: RequestView = { kind: "change.patch", format: "codex", text: [
    "*** Begin Patch", "*** Update File: example.ts", "@@",
    ...before.map(line => "-" + line), ...after.map(line => "+" + line), "*** End Patch", "",
  ].join("\n") };
  const unified: RequestView = { kind: "change.patch", format: "unified", text: [
    "--- a/example.ts", "+++ b/example.ts", "@@ -7,3 +19,6 @@",
    ...before.map(line => "-" + line), ...after.map(line => "+" + line), "",
  ].join("\n") };
  const numbered = [...before.map((line, index) => `-${7 + index}    ${line}`),
    ...after.map((line, index) => `+${19 + index}#AB:${line}`)].join("\n");

  const presentations = [replacements(before, after),
    buildDiffPresentation(codex, undefined, { timeoutMs: 500 }),
    buildDiffPresentation(unified, undefined, { timeoutMs: 500 }),
    buildDiffPresentation({ kind: "uninterpreted" }, { parts: [{ kind: "diff", origin: "reported", representations: { numbered } }] }, { timeoutMs: 500 }),
  ];
  for (const presentation of presentations) {
    assert.deepEqual(correspondence(presentation), expected);
    assert.deepEqual(changedPairs(presentation).flatMap(pair => pair.before ? [pair.before.text] : []), before);
    assert.deepEqual(changedPairs(presentation).flatMap(pair => pair.after ? [pair.after.text] : []), after);
  }

  const numberedPairs = changedPairs(presentations[3]!);
  assert.deepEqual(numberedPairs.flatMap(pair => pair.before ? [pair.before.line1] : []), [7, 8, 9]);
  assert.deepEqual(numberedPairs.flatMap(pair => pair.after ? [pair.after.line1] : []), [19, 20, 21, 22, 23, 24]);
  assert.deepEqual(numberedPairs.flatMap(pair => pair.after ? [pair.after.locationLabel] : []),
    ["19 AB", "20 AB", "21 AB", "22 AB", "23 AB", "24 AB"]);
  assert.ok(changedPairs(presentations[1]!).every(pair => pair.before?.line1 === undefined && pair.after?.line1 === undefined));
});

test("middle deletions and unrelated equal-count changes do not force positional pairs", () => {
  assert.deepEqual(correspondence(replacements(after, before)), expected.map(([old, next]) => [next, old]));
  assert.deepEqual(correspondence(replacements(
    ["const account = loadAccount(id);", "throw staleSession;"],
    ["const account = loadAccount(userId);", "initializeTelemetry();"],
  )), [["const account = loadAccount(id);", "const account = loadAccount(userId);"],
    ["throw staleSession;", undefined], [undefined, "initializeTelemetry();"]]);
});

test("single replacements and line-ending changes retain their supplied correspondence", () => {
  assert.deepEqual(correspondence(replacements(["old"], ["new"])), [["old", "new"]]);
  const request: RequestView = { kind: "change.replacements", requestedEdits: [{ path: "example.ts",
    oldText: "alpha\r\nbeta\r\n", newText: "alpha\nbeta\n" }] };
  const pairs = changedPairs(buildDiffPresentation(request, undefined, { timeoutMs: 500 }));
  assert.deepEqual(pairs.map(pair => [pair.before?.text, pair.after?.text]), [["alpha", "alpha"], ["beta", "beta"]]);
  assert.ok(pairs.every(pair => pair.before?.lineEnding === "\r\n" && pair.after?.lineEnding === "\n"));
});

test("correspondence refinement stays within context and hunk boundaries", () => {
  const request: RequestView = { kind: "change.patch", format: "unified", text: [
    "--- a/example.ts", "+++ b/example.ts", "@@ -1,3 +1,3 @@",
    "-const alpha = oldAlpha();", "+const beta = newBeta();", " stable();",
    "-const beta = oldBeta();", "+const alpha = newAlpha();",
    "@@ -20 +20 @@", "-const gamma = oldGamma();", "+const delta = newDelta();", "",
  ].join("\n") };
  assert.deepEqual(correspondence(buildDiffPresentation(request, undefined, { timeoutMs: 500 })), [
    ["const alpha = oldAlpha();", "const beta = newBeta();"],
    ["const beta = oldBeta();", "const alpha = newAlpha();"],
    ["const gamma = oldGamma();", "const delta = newDelta();"],
  ]);
});

test("alignment exhaustion retains every row and marks the comparison coarse", () => {
  const presentation = replacements(before, after, before.length + after.length);
  assert.equal(presentation.units[0]?.coarseComparison, true);
  assert.deepEqual(correspondence(presentation), [
    ...before.map(line => [line, undefined]), ...after.map(line => [undefined, line]),
  ]);
});

test("unified and split rendering use the corrected pairs without losing inserted rows", () => {
  const presentation = replacements(before, after);
  const split = renderDiffPresentation(presentation, 240, { layout: "split" });
  assert.ok(split.some(line => line.includes(before[0]!) && line.includes(after[1]!)));
  assert.ok(split.some(line => line.includes(before[1]!) && line.includes(after[3]!)));
  const unified = renderDiffPresentation(presentation, 240, { layout: "unified" });
  for (const line of [...before, ...after]) assert.equal(unified.filter(row => row.includes(line)).length, 1);
});
