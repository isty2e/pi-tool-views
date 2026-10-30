import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";
import type { EffectiveDeclaration, SuppliedToolResult } from "../../src/presentation.ts";

const declaration: EffectiveDeclaration = { description: "Read an enclosing symbol.", input: { kind: "json", schema: {
	type: "object", required: ["path", "line"], properties: {
		path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ path: "src/math.ts", line: 3 });
assert.equal(request.kind, "source.enclosing");
const warning = "Callback extraction failed: parser unavailable";

function readResult(text: string, warnings: readonly string[] = [warning]): SuppliedToolResult {
	return { isError: false, content: [{ kind: "text", text }], details: {
		found: true, name: "add", kind: "function", line: 3, startLine: 3, endLine: 3, readRecorded: true, warnings,
	} };
}

test("reported source warnings remain visible before the returned code", () => {
	const code = `const message = "Warnings: ${warning}";`;
	const result = readResult(`function add  math.ts:3-3\n\n${code}`);
	const view = projection.result(result, request);
	assert.deepEqual(view.parts, [
		{ kind: "notice", severity: "warning", origin: "producer", text: `Warning: ${warning}` },
		{ kind: "source", path: "src/math.ts", source: { text: code, firstLine1: 3 } },
	]);
	assert.equal(result.content[0]?.kind === "text" && result.content[0].text.endsWith(code), true);
});

test("warning metadata also survives when the body cannot be safely normalized", () => {
	const result = readResult("Unrecognized source output", [warning, "Other parser warning"]);
	assert.deepEqual(projection.result(result, request).parts, [
		{ kind: "notice", severity: "warning", origin: "producer", text: `Warning: ${warning}` },
		{ kind: "notice", severity: "warning", origin: "producer", text: "Warning: Other parser warning" },
		{ kind: "original-content" },
	]);
});

test("failed reads retain already displayed producer warnings without duplication", () => {
	const text = `Could not read enclosing range. Warnings: ${warning}`;
	const result: SuppliedToolResult = { isError: true, content: [{ kind: "text", text }],
		details: { found: false, line: 3, warnings: [warning] } };
	assert.deepEqual(projection.result(result, request).parts, [{ kind: "original-content" }]);
});
