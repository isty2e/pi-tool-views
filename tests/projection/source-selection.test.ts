import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveDeclaration, JsonObject, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Read the enclosing symbol", input: { kind: "json", schema: {
	type: "object", required: ["path", "line"], properties: {
		path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ path: "src/math.ts", line: 6, maxLines: 2 });
const error = "Could not read enclosing range in math.ts:6: Enclosing function spans 6 lines, above maxLines 2";
const details: JsonObject = { found: false, line: 6, name: "add", kind: "function", startLine: 3, endLine: 8,
	enclosingStartLine: 3, enclosingEndLine: 8, error: "Enclosing function spans 6 lines, above maxLines 2" };

function result(metadata: JsonObject): SuppliedToolResult {
	return { isError: true, content: [{ kind: "text", text: error }], details: metadata };
}

test("failed enclosing reads retain independently corroborated reported symbol and range", () => {
	const supplied = result(details);
	const view = projection.result(supplied, request);
	assert.deepEqual(view.sourceSelection, { path: "src/math.ts", symbol: { name: "add", kind: "function" },
		range: { firstLine1: 3, lastLine1: 8 } });
	assert.deepEqual(view.parts, [{ kind: "original-content" }]);
	assert.equal(supplied.isError, true);
	assert.equal(supplied.content[0]?.kind === "text" && supplied.content[0].text, error);
});

test("uncorroborated failed selections are not associated with the request", () => {
	for (const changed of [
		{ line: 7 }, { line: undefined }, { name: undefined }, { kind: "" }, { startLine: 0 },
		{ endLine: 2 }, { enclosingStartLine: 4 }, { enclosingEndLine: 9 }, { enclosingEndLine: undefined },
		{ startLine: 7, enclosingStartLine: 7 },
	]) {
		const value = Object.fromEntries(Object.entries({ ...details, ...changed }).filter(([, value]) => value !== undefined)) as JsonObject;
		assert.equal(projection.result(result(value), request).sourceSelection, undefined);
	}
});
