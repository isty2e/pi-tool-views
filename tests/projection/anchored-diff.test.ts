import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { buildDiffPresentation } from "../../src/diff/index.ts";
import { renderToolDiff } from "../../src/display/diff.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { defaults } from "../../src/settings/model.ts";
import type { ResultPart, SuppliedToolResult } from "../../src/presentation.ts";
import { anchoredDiffIdentifiers } from "../../src/projection/anchored-diff.ts";

const numbered = "--- src/math.ts ---\n ...\n ajivo│function add() {\n-outwa│  return 1;\n fdott│}\n ...\n\n--- src/app.ts ---\n mjres│import { add } from './math';\n+ookey│  return 1;\n cppgf│\n sille│run();\n ...";
const unified = "--- src/math.ts\n+++ src/math.ts\n@@ -3,3 +3,2 @@\n function add() {\n-  return 1;\n }\n--- src/app.ts\n+++ src/app.ts\n@@ -1,3 +1,4 @@\n import { add } from './math';\n+  return 1;\n \n run();\n";
const part: Extract<ResultPart, { kind: "diff" }> = { kind: "diff", origin: "reported", representations: { numbered, unified } };
const result: SuppliedToolResult = { isError: false, content: [{ kind: "text", text: numbered }],
  details: { diff: numbered, patch: unified, metrics: { classification: "applied" } } };

test("reported diff associates supplied identifiers with the correct file and snapshot side", () => {
  const labels = anchoredDiffIdentifiers(result, part);
  assert.ok(labels.some(label => label.path === "src/math.ts" && label.side === "before" && label.line1 === 4 && label.identifier === "outwa"));
  assert.ok(labels.some(label => label.path === "src/app.ts" && label.side === "after" && label.line1 === 2 && label.identifier === "ookey"));
  assert.ok(!labels.some(label => label.path === "src/math.ts" && label.side === "before" && label.identifier === "ajivo"));
  assert.deepEqual(anchoredDiffIdentifiers({ ...result, isError: true }, part), []);
});

test("conflicting and repeated rows are not assigned invented identifiers", () => {
  const conflict = numbered.replace("-outwa│  return 1;", "-outwa│  return 1;\n-abcde│  return 1;");
  const conflictingPart = { ...part, representations: { numbered: conflict, unified } };
  const conflicting = { ...result, details: { diff: conflict, patch: unified, metrics: { classification: "applied" } } };
  assert.ok(!anchoredDiffIdentifiers(conflicting, conflictingPart).some(label => label.identifier === "outwa" || label.identifier === "abcde"));

  const oneFile = " ajivo│function add() {\n-outwa│  return 1;\n fdott│}";
  const onePatch = "--- src/math.ts\n+++ src/math.ts\n@@ -3,3 +3,2 @@\n function add() {\n-  return 1;\n }\n";
  const single = { ...result, details: { diff: oneFile, patch: onePatch, metrics: { classification: "applied" } } };
  const singlePart = { ...part, representations: { numbered: oneFile, unified: onePatch } };
  assert.ok(anchoredDiffIdentifiers(single, singlePart).some(label => label.path === "src/math.ts" && label.line1 === 4 && label.identifier === "outwa"));
});

test("a reported edit displays mapped identifiers in both diff layouts", () => {
  const projection = compileProjection({ description: "Relocate a range of lines to another anchor.", input: { kind: "json", schema: {
    type: "object", required: ["source_from", "source_to", "anchor", "direction"], properties: { path: { type: "string" },
      source_from: { type: "string", description: "5-char anchor of the FIRST source line." },
      source_to: { type: "string", description: "5-char anchor of the LAST source line." },
      anchor: { type: "string", description: "5-char anchor of the destination line" },
      direction: { type: "string", description: "after places the block below the anchor line, before above it" } },
  } } });
  const request = projection.request({ path: "src/math.ts", source_from: "outwa", source_to: "outwa", anchor: "mjres", direction: "after" });
  const view = projection.result(result, request);
  const plan = buildDiffPresentation(request, view);
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
  for (const diffMode of ["unified", "split"] as const) {
    const rendered = renderToolDiff(plan, 140, { ...defaults, diffMode }, theme).map(stripTerminalSequences).join("\n");
    assert.ok(rendered.includes("4 outwa") && rendered.includes("2 ookey"));
  }
});
