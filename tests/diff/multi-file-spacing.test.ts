import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import type { ResultView } from "../../src/presentation.ts";

const patch = "--- src/one.ts\n+++ src/one.ts\n@@ -1 +1 @@\n-old one\n+new one\n\n--- src/two.ts\n+++ src/two.ts\n@@ -1 +1 @@\n-old two\n+new two\n";
const result = (unified: string): ResultView => ({ parts: [{ kind: "diff", origin: "reported", representations: { unified } }] });

test("blank separators between complete file patches retain both reported changes", () => {
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, result(patch));
  assert.deepEqual(plan.units.map(unit => unit.scope.kind === "file" ? unit.scope.path : ""), ["src/one.ts", "src/two.ts"]);
  for (const layout of ["unified", "split"] as const) {
    const output = renderDiffPresentation(plan, 90, { layout }).join("\n");
    assert.ok(output.includes("src/one.ts") && output.includes("src/two.ts"));
    assert.ok(output.includes("old one") && output.includes("new one") && output.includes("old two") && output.includes("new two"));
  }
});

test("unrecognized text between file patches remains intact as raw output", () => {
  const invalid = patch.replace("\n\n--- src/two.ts", "\n\nproducer notice\n--- src/two.ts");
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, result(invalid));
  const section = plan.units[0]?.sections[0];
  assert.equal(section?.kind, "raw");
  if (section?.kind === "raw") assert.equal(section.sources[0].text, invalid);
});

test("several empty separators are accepted only after a complete hunk", () => {
  const separated = patch.replace("\n\n--- src/two.ts", "\n\n\n\n--- src/two.ts");
  const valid = buildDiffPresentation({ kind: "uninterpreted" }, result(separated));
  assert.equal(valid.units.length, 2);
  const incomplete = separated.replace("@@ -1 +1 @@\n-old one", "@@ -2,2 +2,2 @@\n-old one");
  const invalid = buildDiffPresentation({ kind: "uninterpreted" }, result(incomplete));
  const section = invalid.units[0]?.sections[0];
  assert.equal(section?.kind, "raw");
  if (section?.kind === "raw") assert.equal(section.sources[0].text, incomplete);
});

test("indexed unified file patches produce attributed changes only when their headers agree", () => {
  const indexed = `Index: src/one.ts\n====================================\n${patch.split("\n\n--- src/two.ts")[0]}\n`;
  const valid = buildDiffPresentation({ kind: "uninterpreted" }, result(indexed));
  assert.equal(valid.units[0]?.scope.kind, "file");
  assert.ok(renderDiffPresentation(valid, 80, { layout: "split" }).some(row => row.includes("old one") && row.includes("new one")));

  const inconsistent = indexed.replace("Index: src/one.ts", "Index: src/other.ts");
  const rejected = buildDiffPresentation({ kind: "uninterpreted" }, result(inconsistent));
  assert.equal(rejected.units[0]?.sections[0]?.kind, "raw");
  const raw = rejected.units[0]?.sections[0];
  if (raw?.kind === "raw") assert.equal(raw.sources[0].text, inconsistent);
});

test("indexed patches can contain several complete file sections", () => {
  const multi = "Index: src/one.ts\n==========\n--- src/one.ts\n+++ src/one.ts\n@@ -1 +1 @@\n-old one\n+new one\n\n"
    + "Index: src/two.ts\n==========\n--- src/two.ts\n+++ src/two.ts\n@@ -1 +1 @@\n-old two\n+new two\n";
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, result(multi));
  assert.deepEqual(plan.units.map(unit => unit.scope.kind === "file" ? unit.scope.path : ""), ["src/one.ts", "src/two.ts"]);
  const incomplete = multi.replace("Index: src/two.ts\n==========", "Index: src/two.ts\nnotice");
  const rejected = buildDiffPresentation({ kind: "uninterpreted" }, result(incomplete));
  const section = rejected.units[0]?.sections[0];
  assert.equal(section?.kind, "raw");
  if (section?.kind === "raw") assert.equal(section.sources[0].text, incomplete);
});
