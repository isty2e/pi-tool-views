import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import type { ResultView } from "../../src/presentation.ts";

function reported(numbered: string): ResultView {
  return { parts: [{ kind: "diff", origin: "reported", representations: { numbered } }] };
}

test("reported numbered regions with restarting positions render without invented file identities", () => {
  const input = "-1 alpha one\n+1 alpha changed\n 2 beta two\n-3 gamma three\n+3 gamma changed\n-1 second file\n+1 second changed";
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, reported(input));
  assert.equal(plan.units.length, 1);
  const unit = plan.units[0]!;
  assert.equal(unit.scope.kind, "call");
  assert.equal(unit.origin, "reported");
  assert.equal(unit.sections.length, 2);
  assert.ok(unit.sections.every(section => section.kind === "hunks" && section.target === undefined));

  for (const layout of ["split", "unified"] as const) {
    const rows = renderDiffPresentation(plan, 100, { layout });
    const text = rows.join("\n");
    for (const fragment of ["alpha one", "alpha changed", "gamma three", "gamma changed", "second file", "second changed"]) {
      assert.ok(text.includes(fragment), fragment);
    }
    assert.match(text, /\b1\s+-\s+second file/);
    assert.match(text, /\b1\s+\+\s+second changed/);
    const second = rows.findIndex(row => /\b1\s+-\s+second file/.test(row));

    assert.equal(rows[second - 1], "");
  }
});

test("invalid numbered data remains available as supplied raw text", () => {
  const input = "-1 old\n+1 new\n-1 another\nunknown row";
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, reported(input));
  const section = plan.units[0]?.sections[0];
  assert.equal(section?.kind, "raw");
  if (section?.kind === "raw") assert.equal(section.sources[0].text, input);
});

test("either side restarting separates rows instead of pairing across regions", () => {
  for (const input of ["-4 old a\n+4 new a\n-2 old b\n+8 new b", "-4 old a\n+4 new a\n+2 new b\n-8 old b"]) {
    const plan = buildDiffPresentation({ kind: "uninterpreted" }, reported(input));
    const sections = plan.units[0]?.sections ?? [];
    assert.equal(sections.length, 2);
    for (const section of sections) assert.equal(section.kind, "hunks");
    const text = renderDiffPresentation(plan, 100, { layout: "split" }).join("\n");
    assert.ok(text.includes("old a") && text.includes("new a"));
    assert.ok(text.includes("old b") && text.includes("new b"));
  }
});
