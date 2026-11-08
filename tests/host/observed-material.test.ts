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
