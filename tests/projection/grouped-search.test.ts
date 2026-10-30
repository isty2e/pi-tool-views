import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Search source syntax.", input: { kind: "json", schema: {
	type: "object", properties: {
		lang: { type: "string", enum: ["typescript"] }, pattern: { type: "string", description: "AST pattern to find." },
		validateOnly: { type: "boolean" }, paths: { type: "array", items: { type: "string" } },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ lang: "typescript", pattern: "console.log($MSG)", paths: ["src"] });

function supplied(text: string, details: Json): SuppliedToolResult {
	return { content: [{ kind: "text", text }], details, isError: false };
}

test("grouped structural search locations are corroborated while pagination and raw text remain intact", () => {
	assert.equal(request.kind, "search.ast");
	const prefix = "2 files, 3 matches:\n";
	const suffix = "\n(Showing 3 of 8 remaining matches. Use skip=3 for the next page.)\n\nproducer footer";
	const text = prefix + "src/a (test):file.ts (2): L4:1, L4:9\nsrc/b.ts (1): L5:3\n" + suffix;
	const result = supplied(text, { groupByFile: true, matchCount: 3, totalMatches: 8, hasMore: true, truncated: true,
		matchLocations: [{ file: "src/a (test):file.ts", line: 4 }, { file: "src/a (test):file.ts", line: 4 },
			{ file: "src/b.ts", line: 5 }] });
	const view = projection.result(result, request);
	assert.deepEqual(view.parts[0], { kind: "text", text: prefix });
	const positions = view.parts.flatMap(part => part.kind === "locations" ? part.items : []);
	assert.deepEqual(positions.map(item => [item.target.kind === "file" ? item.target.path : item.target.uri, item.line, item.character]), [
		["src/a (test):file.ts", 4, 1], ["src/a (test):file.ts", 4, 9], ["src/b.ts", 5, 3],
	]);
	assert.ok(positions.every(item => item.indexBase === 1 && item.characterUnit === "unreported"));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === suffix));
	assert.equal(result.content[0]?.kind === "text" && result.content[0].text, text);
});

test("only uniquely corroborated groups normalize; conflicting, missing and ungrouped results stay original", () => {
	const details = { groupByFile: true, matchCount: 2, matchLocations: [{ file: "a.ts", line: 4 }, { file: "b.ts", line: 5 }] };
	for (const text of ["a.ts (1): L4:1\nb.ts (1): L6:3", "a.ts (1): L4:1\na.ts (1): L4:1\nb.ts (1): L5:3",
		"a.ts (1): L4:1", "a.ts:4:1: source text\nb.ts:5:3: other source"]) {
		assert.deepEqual(projection.result(supplied(text, details), request).parts, [{ kind: "original-content" }]);
	}
	const ungrouped = { ...details, groupByFile: false };
	assert.deepEqual(projection.result(supplied("a.ts:4:1: source text", ungrouped), request).parts, [{ kind: "original-content" }]);
	assert.deepEqual(projection.result(supplied("a.ts (1): L4:1\nb.ts (1): L5:3", { ...details, matchCount: 3 }), request).parts,
		[{ kind: "original-content" }]);
});

test("grouped results preserve other content blocks and expose pagination even without a text footer", () => {
	const result = { content: [{ kind: "text", text: "warning before\na.ts (1): L2:3\n" },
		{ kind: "other", value: { description: "external block" } }, { kind: "text", text: "b.ts (1): L6:4\nwarning after" }],
		details: { groupByFile: true, matchCount: 2, hasMore: true,
			matchLocations: [{ file: "a.ts", line: 2 }, { file: "b.ts", line: 6 }] }, isError: false } satisfies SuppliedToolResult;
	const parts = projection.result(result, request).parts;
	assert.ok(parts.some(part => part.kind === "original-content" && part.indexes?.[0] === 1));
	assert.ok(parts.some(part => part.kind === "text" && part.text.includes("warning before")));
	assert.ok(parts.some(part => part.kind === "text" && part.text.includes("warning after")));
	assert.equal(parts.filter(part => part.kind === "locations").length, 2);
	assert.ok(parts.some(part => part.kind === "coverage" && part.reason === "continuation"));
});
