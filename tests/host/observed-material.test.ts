import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import { renderDiffPresentation } from "../../src/diff/layout.ts";
import { observeDiffContext } from "../../src/diff/observed-context.ts";
import { CallPreparations } from "../../src/host/prepared.ts";
import { prepareFiles } from "../../src/host/file-targets.ts";
import { observedMaterial } from "../../src/host/observed-material.ts";
import type { DiffSection } from "../../src/diff/model.ts";

test("unresolved target slots do not shift observations onto another request occurrence", async () => {
  for (const missing of [0, 1, 2, 3]) {
    const edits = ["a.ts", "b.ts", "c.ts"].map(path => ({ path, oldText: "old", newText: "new" }));
    edits.splice(missing, 0, { path: "", oldText: "unknown-old", newText: "unknown-new" });
    const request = { kind: "change.replacements" as const, requestedEdits: edits };
    const prepared = new CallPreparations({ compile: () => ({ request: () => request, result: () => ({ parts: [{ kind: "original-content" }] }) }), compare: buildDiffPresentation }).prepare(undefined, {});
    const files = prepareFiles(prepared, resolve("/fixture"));
    const plan = buildDiffPresentation(request, undefined, { prepared: prepared.changes! });
    const before = new Map(["a.ts", "b.ts", "c.ts"].map((path, index) => {
      const text = [...Array<string>(index * 2).fill("padding"), `${path}-context`, "old", ""].join("\n");
      return [resolve("/fixture", path), { text, bytes: text.length }] as const;
    }));
    const after = new Map([...before].map(([path, value]) => [path, { text: value.text.replace("\nold\n", "\nnew\n"), bytes: value.bytes }]));
    const matching = observedMaterial({ request, result: { content: [], isError: false }, plan, inline: [] }, files, { before, after, release() {} });
    const observed = await observeDiffContext(matching.plan, matching.observations, 1);
    for (const [index, path] of ["a.ts", "b.ts", "c.ts"].entries()) {
      const unit = plan.compoundRequest!.units.find(unit => unit.scope.kind === "file" && unit.scope.path === path)!;
      const rows = renderDiffPresentation({ ...plan, units: [unit] }, 100, { layout: "unified", observed }).join("\n");
      assert.ok(rows.includes(`${path}-context`), `${path} must display its own observed context`);
      assert.match(rows, new RegExp(`${index * 2 + 2}\\s+- old`));
      assert.match(rows, new RegExp(`${index * 2 + 2}\\s+\\+ new`));
    }
  }
});

test("identical path labels in different directories retain occurrence-local observations", async () => {
  const request = { kind: "change.replacements" as const, requestedEdits: [
    { path: "a.ts", oldText: "old-one", newText: "new-one", fileContext: { kind: "directory" as const, path: "one" } },
    { path: "a.ts", oldText: "old-two", newText: "new-two", fileContext: { kind: "directory" as const, path: "two" } },
  ] };
  const prepared = new CallPreparations({ compile: () => ({ request: () => request, result: () => ({ parts: [{ kind: "original-content" }] }) }), compare: buildDiffPresentation }).prepare(undefined, {});
  const files = prepareFiles(prepared, resolve("/fixture"));
  const plan = buildDiffPresentation(request, undefined, { prepared: prepared.changes! });
  const snapshot = (text: string) => ({ text, bytes: text.length });
  const captured = { before: new Map([[resolve("/fixture/one/a.ts"), snapshot("one-head\nold-one\n")], [resolve("/fixture/two/a.ts"), snapshot("two-head\nextra\ncontext\nold-two\n")]]),
    after: new Map([[resolve("/fixture/one/a.ts"), snapshot("one-head\nnew-one\n")], [resolve("/fixture/two/a.ts"), snapshot("two-head\nextra\ncontext\nnew-two\n")]]), release() {} };
  const material = { request, result: { content: [], isError: false }, plan, inline: [] };
  const matching = observedMaterial(material, files, captured);
  const observed = await observeDiffContext(matching.plan, matching.observations, 1);
  const rows = renderDiffPresentation(plan, 100, { layout: "unified", context: 1, observed }).join("\n");
  assert.match(rows, /2\s+- old-one/);
  assert.match(rows, /4\s+- old-two/);
  assert.match(rows, /2\s+\+ new-one/);
  assert.match(rows, /4\s+\+ new-two/);

  const cloneSection = (section: DiffSection): DiffSection => section.kind === "hunks" ? { ...section, hunks: section.hunks.map(hunk => ({ ...hunk })) } : section;
  const ambiguous = { ...plan, units: plan.units.map(unit => ({ ...unit, origin: "reported" as const,
    sections: [cloneSection(unit.sections[0]), ...unit.sections.slice(1).map(cloneSection)] as [DiffSection, ...DiffSection[]] })) };
  const unchanged = observedMaterial({ ...material, plan: ambiguous }, files, captured);
  for (const unit of ambiguous.units) for (const section of unit.sections) if (section.kind === "hunks") {
    for (const hunk of section.hunks) assert.equal(unchanged.observations.has(hunk), false);
  }
});
