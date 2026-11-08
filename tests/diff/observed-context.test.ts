import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import { renderDiffPresentation } from "../../src/diff/layout.ts";
import { observeDiffContext as matchObservations } from "../../src/diff/observed-context.ts";
import type { FileObservations } from "../../src/diff/observed-context.ts";
import type { DiffHunk, DiffPresentation } from "../../src/diff/model.ts";

function observeDiffContext(plan: DiffPresentation, files: ReadonlyMap<string, FileObservations>, radius: number, current?: () => boolean) {
  const observations = new Map<DiffHunk, FileObservations>();
  const shared = new Map<string, FileObservations>();
  for (const unit of [...plan.units, ...(plan.compoundRequest?.units ?? [])]) for (const section of unit.sections) {
    const path = section.target?.path ?? (unit.scope.kind === "file" ? unit.scope.path : undefined);
    if (section.kind !== "hunks" || !path) continue;
    const destination = section.target?.moveTo ?? path;
    const key = JSON.stringify([path, destination]);
    let observation = shared.get(key);
    if (!observation) {
      const before = files.get(path)?.before, after = files.get(destination)?.after;
      observation = { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
      shared.set(key, observation);
    }
    for (const hunk of section.hunks) observations.set(hunk, observation);
  }
  return matchObservations(plan, observations, radius, current);
}

function replacement(oldText = "old", newText = "new"): DiffPresentation {
  return buildDiffPresentation({ kind: "change.replacements", requestedEdits: [{ path: "file.ts", oldText, newText }] }, undefined);
}

function firstHunk(plan: DiffPresentation): DiffHunk {
  const section = plan.units[0]!.sections[0]!;
  assert.equal(section.kind, "hunks");
  if (section.kind !== "hunks") throw new Error("Expected literal changes");
  return section.hunks[0]!;
}

test("observed locations and context enrich both layouts without changing the semantic plan", async () => {
  const plan = replacement();
  const original = structuredClone(plan);
  const observed = await observeDiffContext(plan, new Map([["file.ts", { before: "start\nold\nend\n", after: "start\nnew\nend\n" }]]), 10);
  assert.deepEqual(plan, original);
  for (const layout of ["unified", "split"] as const) {
    const rows = renderDiffPresentation(plan, 100, { layout, context: 1, observed });
    assert.match(rows.join("\n"), /2\s+- old/);
    assert.match(rows.join("\n"), /2\s+\+ new/);
    assert.match(rows.join("\n"), /1\s+.*start/);
    assert.match(rows.join("\n"), /3\s+.*end/);
    assert.ok(rows.every(row => row.length <= 100));
    assert.ok(!renderDiffPresentation(plan, 100, { layout, context: 0, observed }).join("\n").includes("start"));
  }
});

test("one-sided observations stay on their own side and are not painted as changes", async () => {
  const plan = replacement();
  const observed = await observeDiffContext(plan, new Map([["file.ts", { after: "new-context\nnew\n" }]]), 3);
  const painted: string[] = [];
  const split = renderDiffPresentation(plan, 90, { layout: "split", observed }, {
    applyChange: (cell, syntax) => { painted.push(cell.text); return syntax; },
  });
  const context = split.find(row => row.includes("new-context"))!;
  assert.equal(context.split("│")[0]!.trim(), "");
  assert.deepEqual(painted.sort(), ["new", "old"]);
  const unified = renderDiffPresentation(plan, 90, { layout: "unified", observed });
  assert.match(unified.find(row => row.includes("new-context"))!, /^\s+1\s{3}new-context$/);
});

test("different endpoint context stays distinct, with independent syntax streams", async () => {
  const plan = replacement();
  const observed = await observeDiffContext(plan, new Map([["file.ts", { before: "old-only\nold\n", after: "new-only\nnew\n" }]]), 1);
  const flows: string[][] = [];
  const rows = renderDiffPresentation(plan, 100, { layout: "unified", observed }, {
    highlightFlow: cells => { flows.push(cells.map(cell => cell.text)); return cells.map(cell => cell.text); },
  });
  assert.deepEqual(flows, [["old-only", "old"], ["new-only", "new"]]);
  assert.ok(rows.some(row => row.includes("old-only")));
  assert.ok(rows.some(row => row.includes("new-only")));
});

test("only exact unique whole-line matches supply missing coordinates", async () => {
  const plan = replacement();
  for (const before of ["old\nold\n", "prefix old\n", "OLD\n", ""]) {
    const observed = await observeDiffContext(plan, new Map([["file.ts", { before }]]), 3);
    assert.equal(observed.size, 0);
  }
});

test("supplied absolute locations disambiguate repeats but a conflict never mixes row bases", async () => {
  const plan: DiffPresentation = { units: [{ origin: "reported", scope: { kind: "file", path: "file.ts" }, sections: [{ kind: "hunks", hunks: [{ blocks: [
    { kind: "change", pairs: [{ before: { text: "old", line1: 3, emphasis: [] }, after: { text: "new", line1: 8, emphasis: [] } }] },
  ] }] }] }], applicationReports: [], context: [] };
  const observed = await observeDiffContext(plan, new Map([["file.ts", { before: "old\ncontext\nold\n", after: "context\nnew\n" }]]), 1);
  const blocks = observed.get(firstHunk(plan))!.blocks;
  assert.equal(blocks[0]!.kind, "observed-context");
  assert.deepEqual(blocks[0], { kind: "observed-context", before: { text: "context", line1: 2, lineEnding: "\n", emphasis: [] } });
  const rows = renderDiffPresentation(plan, 100, { layout: "split", observed });
  assert.ok(rows.some(row => row.includes("8 + new")));
  assert.equal(plan.units[0]!.origin, "reported");
});

test("Codex and unified patches use common hunks, including moves and changed row counts", async () => {
  for (const text of [
    "*** Begin Patch\n*** Update File: file.ts\n*** Move to: moved.ts\n@@\n-old\n+new\n+extra\n*** End Patch",
    "--- a/file.ts\n+++ b/file.ts\n@@ -2 +2,2 @@\n-old\n+new\n+extra\n",
  ]) {
    const plan = buildDiffPresentation({ kind: "change.patch", text, format: "unconfirmed" }, undefined);
    const files = new Map([
      ["file.ts", { before: "lead\nold\ntail\n", after: "lead\nnew\nextra\ntail\n" }],
      ["moved.ts", { after: "lead\nnew\nextra\ntail\n" }],
    ]);
    const observed = await observeDiffContext(plan, files, 1);
    const rendered = renderDiffPresentation(plan, 100, { layout: "unified", observed }).join("\n");
    assert.match(rendered, /2\s+- old/);
    assert.match(rendered, /3 \+ extra/);
    assert.match(rendered, /3\s+4\s+tail/);
  }
});

test("Unicode, BOM, CRLF and final terminators do not invent an EOF row", async () => {
  const plan = replacement("옛🙂\n", "새🙂\n");
  const observed = await observeDiffContext(plan, new Map([["file.ts", { before: "\uFEFFlead\r\n옛🙂\r\n", after: "\uFEFFlead\r\n새🙂\r\n" }]]), 10);
  const blocks = observed.get(firstHunk(plan))!.blocks;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { kind: "observed-context",
    before: { text: "\uFEFFlead", line1: 1, lineEnding: "\r\n", emphasis: [] }, after: { text: "\uFEFFlead", line1: 1, lineEnding: "\r\n", emphasis: [] } });
});

test("insertions and deletions only locate the endpoint with literal text", async () => {
  for (const [oldText, newText, side] of [["old", "", "before"], ["", "new", "after"]] as const) {
    const plan = replacement(oldText, newText);
    const observed = await observeDiffContext(plan, new Map([["file.ts", { before: "lead\nold\n", after: "lead\nnew\n" }]]), 1);
    const context = observed.get(firstHunk(plan))!.blocks[0]!;
    assert.equal(context.kind, "observed-context");
    if (context.kind !== "observed-context") continue;
    assert.ok(context[side]);
    assert.equal(context[side === "before" ? "after" : "before"], undefined);
  }
});

test("unsupported material, unresolved scopes and cancelled work keep the ordinary view", async () => {
  const raw = buildDiffPresentation({ kind: "change.patch", text: "not a patch", format: "unconfirmed" }, undefined);
  assert.equal((await observeDiffContext(raw, new Map([["file.ts", { before: "old" }]]), 3)).size, 0);
  const plan = replacement();
  assert.equal((await observeDiffContext(plan, new Map([["file.ts", { before: "old" }]]), 3, () => false)).size, 0);
});
