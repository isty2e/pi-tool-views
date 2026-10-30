import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import type { ChangedLinePair, DiffPresentation } from "../../src/diff/index.ts";

test("wrapped diff rows mark each logical addition or deletion only once", () => {
  const before = { text: "before漢👩‍💻".repeat(3), emphasis: [] };
  const after = { text: "after漢👩‍💻".repeat(9), emphasis: [] };
  const pairs: ChangedLinePair[] = [{ before }, { after }, { before, after }];
  for (const pair of pairs) {
    const plan: DiffPresentation = { units: [{ scope: { kind: "call" }, origin: "reported", sections: [
      { kind: "hunks", hunks: [{ blocks: [{ kind: "change", pairs: [pair] }] }] },
    ] }], context: [], applicationReports: [] };
    for (const layout of ["unified", "split"] as const) {
      const rows = renderDiffPresentation(plan, 35, { layout, lineNumbers: false, showHeadings: false });
      assert.ok(rows.every(row => visibleWidth(row) <= 35));
      assert.equal((rows.join("\n").match(/-/g) ?? []).length, pair.before ? 1 : 0);
      assert.equal((rows.join("\n").match(/\+/g) ?? []).length, pair.after ? 1 : 0);
      const content = (value: string) => value.replace(/^[-+ ]*/, "").trimEnd();
      if (layout === "split") {
        assert.equal(rows.map(row => content(row.split("│")[0]!)).join(""), pair.before?.text ?? "");
        assert.equal(rows.map(row => content(row.split("│")[1]!)).join(""), pair.after?.text ?? "");
      } else {
        assert.equal(rows.map(content).join(""), (pair.before?.text ?? "") + (pair.after?.text ?? ""));
      }
    }
  }
});

test("numbered omission grammar uses the common gap glyph without changing literal dots", () => {
  const numbered = "-1 before\n+1 after\n   ...\n-8 literal...\n+8 changed...";
  const result = { parts: [{ kind: "diff", origin: "reported", representations: { numbered } }] } as const;
  const plan = buildDiffPresentation({ kind: "uninterpreted" }, result);
  for (const layout of ["unified", "split"] as const) {
    const rows = renderDiffPresentation(plan, 80, { layout, showHeadings: false });
    assert.ok(rows.includes("…"));
    assert.ok(!rows.includes("..."));
    assert.ok(rows.some(row => row.includes("literal...")));
    assert.ok(rows.some(row => row.includes("changed...")));
  }
  assert.equal(result.parts[0].representations.numbered, numbered);
});

test("descriptive gap labels and unparsed output keep their supplied meaning", () => {
  const plan: DiffPresentation = { units: [{ scope: { kind: "call" }, origin: "reported", sections: [
    { kind: "hunks", hunks: [{ blocks: [{ kind: "gap", label: "7 lines omitted" }] }] },
    { kind: "raw", sources: [{ text: "literal ... output" }] },
  ] }], context: [], applicationReports: [] };
  for (const layout of ["unified", "split"] as const) {
    const rows = renderDiffPresentation(plan, 80, { layout, showHeadings: false });
    assert.ok(rows.includes("7 lines omitted"));
    assert.ok(rows.includes("literal ... output"));
  }
});
