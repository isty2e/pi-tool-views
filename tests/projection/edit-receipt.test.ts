import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import type { SuppliedToolResult } from "../../src/presentation.ts";

const projection = compileProjection({ description: "Edit a file by replacing exact text.", input: {
  kind: "json", schema: { type: "object", properties: {
    path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
    patch: { type: "string", description: "Codex-style patch payload." },
    multi: { type: "array", items: { type: "object", required: ["oldText", "newText"], properties: {
      path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
    } } },
  } },
} });
const request = projection.request({ path: "alpha.txt", oldText: "alpha one", newText: "alpha changed", multi: [
  { path: "second.txt", oldText: "second file", newText: "second changed" },
  { path: "alpha.txt", oldText: "gamma three", newText: "gamma changed" },
] });
const headline = "Applied 3 edit(s) successfully.";
const receipt = `${headline}\n1. Edited alpha.txt.\n2. Edited second.txt.\n3. Edited alpha.txt.`;
const supplied = (text: string, isError = false): SuppliedToolResult => ({ isError, content: [{ kind: "text", text }],
  details: { diff: "-1 alpha one\n+1 alpha changed\n-1 second file\n+1 second changed" } });

test("a matching successful edit receipt retains its headline and any additional warning", () => {
  const input = supplied(`${receipt}\nWarning: follow-up needed.`);
  const output = projection.result(input, request);
  assert.ok(output.parts.some(part => part.kind === "text" && part.text === `${headline}\nWarning: follow-up needed.`));
  assert.equal(input.content[0]?.kind === "text" && input.content[0].text, `${receipt}\nWarning: follow-up needed.`);
});

test("failed, incomplete or conflicting receipts remain original", () => {
  for (const input of [supplied(receipt, true), supplied(receipt.replace("2. Edited second.txt.", "2. Failed second.txt.")),
    supplied(receipt.replace("3. Edited alpha.txt.", "3. Edited another.txt.")), supplied(receipt.replace("3. Edited alpha.txt.", "")),
    { ...supplied(receipt), details: { diff: "-1 old\n+1 new", status: "failed" } },
    { ...supplied(receipt), details: { diff: "-1 old\n+1 new", partialFailure: true } },
    { ...supplied(receipt), details: { diff: "-1 old\n+1 new", status: "running" } },
    { ...supplied(receipt), details: { diff: "-1 old\n+1 new", truncation: { truncated: true } } }]) {
    assert.ok(projection.result(input, request).parts.some(part => part.kind === "original-content"));
  }
});
