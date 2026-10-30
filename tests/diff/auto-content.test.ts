import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDiffPresentation } from "../../src/diff/index.ts";
import type { DiffPresentation, DiffSection } from "../../src/diff/index.ts";

function plan(...sections: [DiffSection, ...DiffSection[]]): DiffPresentation {
  return { units: [{ origin: "reported", scope: { kind: "call" }, sections }], applicationReports: [], context: [] };
}

const added: DiffSection = { kind: "hunks", target: { path: "new.ts" }, activity: "added", hunks: [{ blocks: [
  { kind: "change", pairs: [{ after: { text: "added value", line1: 1, emphasis: [] } }] },
] }] };
const deleted: DiffSection = { kind: "hunks", target: { path: "gone.ts" }, activity: "deleted", hunks: [{ blocks: [
  { kind: "change", pairs: [{ before: { text: "deleted value", line1: 7, emphasis: [] } }] },
] }] };
const paired: DiffSection = { kind: "hunks", target: { path: "paired.ts" }, hunks: [{ blocks: [
  { kind: "change", pairs: [{ before: { text: "old paired", line1: 4, emphasis: [] },
    after: { text: "new paired", line1: 4, emphasis: [] } }] },
] }] };

test("Auto uses Unified for one-sided, unpaired and unknown-before material", () => {
  const variants: readonly [DiffSection, string][] = [[added, "added value"], [deleted, "deleted value"],
    [{ kind: "hunks", hunks: [{ blocks: [
      { kind: "context", text: "shared context", oldLine1: 1, newLine1: 1 },
      { kind: "change", pairs: [{ after: { text: "inserted value", line1: 2, emphasis: [] } }] },
    ] }] }, "inserted value"],
    [{ kind: "hunks", hunks: [{ blocks: [{ kind: "change", pairs: [
      { before: { text: "unpaired old", emphasis: [] } }, { after: { text: "unpaired new", emphasis: [] } },
    ] }] }] }, "unpaired new"],
    [{ kind: "hunks", hunks: [{ blocks: [{ kind: "located-change", operation: "replace", locationLabel: "12#AB",
      after: [{ text: "known replacement", emphasis: [] }] }] }] }, "known replacement"],
    [{ kind: "raw", sources: [{ text: "unparsed supplied data" }] }, "unparsed supplied data"],
  ];
  for (const [section, supplied] of variants) {
    const value = plan(section), original = structuredClone(value);
    const rows = renderDiffPresentation(value, 120, { layout: "auto", showHeadings: false });
    assert.ok(rows.some(row => row.includes(supplied)));
    assert.ok(rows.every(row => !row.includes("│")));
    assert.deepEqual(value, original);
  }
});

test("explicit layout selections remain independent of content-aware Auto", () => {
  for (const section of [added, deleted, paired]) {
    assert.ok(renderDiffPresentation(plan(section), 120, { layout: "split" }).some(row => row.includes("│")));
    assert.ok(renderDiffPresentation(plan(section), 120, { layout: "unified" }).every(row => !row.includes("│")));
  }
});

test("Auto chooses independently for supplied sections, but stays consistent across their hunks", () => {
  const rows = renderDiffPresentation(plan(added, paired, deleted), 120, { layout: "auto" });
  const add = rows.findIndex(row => row.includes("added value"));
  const pair = rows.findIndex(row => row.includes("new paired"));
  const remove = rows.findIndex(row => row.includes("deleted value"));
  assert.ok(add >= 0 && add < pair && pair < remove);
  assert.ok(!rows[add]!.includes("│") && rows[pair]!.includes("│") && !rows[remove]!.includes("│"));
  assert.ok(paired.kind === "hunks" && added.kind === "hunks");
  const mixed = { ...paired, hunks: [...paired.hunks, ...added.hunks] };
  const mixedRows = renderDiffPresentation(plan(mixed), 120, { layout: "auto" });
  assert.ok(mixedRows.find(row => row.includes("added value"))!.includes("│"));
});

test("Auto retains supplied positions, width limits and path-only outcomes", () => {
  const wide = renderDiffPresentation(plan(added, deleted), 120, { layout: "auto", showHeadings: false });
  assert.ok(wide.some(row => /\b1\s+\+\s+added value/.test(row)));
  assert.ok(wide.some(row => /\b7\s+\s*-\s+deleted value/.test(row)));
  for (const width of [12, 30, 80, 120]) {
    const rows = renderDiffPresentation(plan(added, paired, deleted), width, { layout: "auto" });
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    if (width === 12) assert.ok(rows.every(row => !row.includes("│")));
  }
  const pathOnly = renderDiffPresentation(plan({ kind: "hunks", target: { path: "absent.ts" }, activity: "deleted", hunks: [] }), 120, { layout: "auto" });
  assert.ok(pathOnly.some(row => row.includes("absent.ts")));
  assert.ok(pathOnly.every(row => !row.includes("│") && !/^\s*[-+]\s/.test(row)));
});
