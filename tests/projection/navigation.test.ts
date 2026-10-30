import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { locationLines } from "../../src/display/locations.ts";
import { locationText } from "../../src/display/text.ts";
import { structuredLines } from "../../src/display/structured.ts";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Navigate source code.", input: { kind: "json", schema: {
	type: "object", required: ["operation"], properties: {
		operation: { type: "string", description: "LSP operation to perform." },
		path: { type: "string", description: "Target file path." },
		line: { type: "number", description: "1-based line number." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ operation: "references", path: "/workspace/a.ts", line: 3 });

function reported(value: Json, suffix = "", isError = false): SuppliedToolResult {
	return { content: [{ kind: "text", text: JSON.stringify(value) + suffix }], isError };
}

const rawA = { uri: "file:///workspace/a.ts", range: { start: { line: 2, character: 16 }, end: { line: 2, character: 19 } } };
const a = { uri: "file:///workspace/a.ts", filePath: "/workspace/a.ts", range: { start: { line: 3, character: 17 }, end: { line: 3, character: 20 } } };
const rawB = { uri: "file:///workspace/b.ts", range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } };
const b = { uri: "file:///workspace/b.ts", filePath: "/workspace/b.ts", range: { start: { line: 1, character: 10 }, end: { line: 1, character: 13 } } };

test("navigation results normalize corroborated one-based UTF-16 ranges without losing order or duplicates", () => {
	assert.equal(request.kind, "code.navigation");
	const root = { operation: "references", ok: true, status: "success", filePath: "/workspace/a.ts", resultCount: 3,
		result: [rawA, rawB, rawA], locations: [a, b, a], metadata: { operation: "references", supported: true, resultCount: 3,
			searchReads: [{ file: "/workspace/a.ts", startLine: 3, endLine: 3 }] } };
	const output = reported(root, "\nproducer footer");
	const view = projection.result(output, request);
	const positions = view.parts.flatMap(part => part.kind === "locations" ? part.items : []);
	assert.equal(positions.length, 3);
	assert.deepEqual(positions[0], { target: { kind: "file", path: "/workspace/a.ts" }, line: 3, character: 17,
		indexBase: 1, characterUnit: "utf16", endExclusive: { line: 3, character: 20 } });
	assert.deepEqual(positions[2], positions[0]);
	assert.equal(positions[1]?.target.kind === "file" && positions[1].target.path, "/workspace/b.ts");
	assert.equal(locationText(positions[0]!), "/workspace/a.ts:3:17–3:20 (UTF-16 columns; end exclusive)");
	const displayed = locationLines(positions, 100, { bold: (text: string) => text } as Theme, "/home").join("\n");
	assert.match(displayed, /\/workspace\/a\.ts \(UTF-16 columns; end exclusive\)[\s\S]*L3:17–3:20[\s\S]*\/workspace\/b\.ts[\s\S]*L1:10–1:13[\s\S]*\/workspace\/a\.ts/);
	assert.ok(view.parts.some(part => part.kind === "structured-data" && structuredLines(part.value, 200).join("\n").includes("searchReads")));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nproducer footer"));
	assert.equal(output.content[0]?.kind === "text" && output.content[0].text, JSON.stringify(root) + "\nproducer footer");
});

test("mismatched or unsupported records remain unassigned while corroborated siblings stay usable", () => {
	const wrong = { ...b, range: { ...b.range, start: { line: 4, character: 10 } } };
	const view = projection.result(reported({ operation: "references", ok: true, status: "success", resultCount: 2,
		result: [rawA, rawB], locations: [a, wrong], notes: ["index may be incomplete"] }), request);
	const positions = view.parts.flatMap(part => part.kind === "locations" ? part.items : []);
	assert.equal(positions.length, 1);
	assert.equal(positions[0]?.line, 3);
	const unknown = view.parts.find(part => part.kind === "structured-data");
	assert.ok(unknown?.kind === "structured-data");
	const text = structuredLines(unknown.value, 200).join("\n");
	assert.match(text, /original:[\s\S]*workspace\/b\.ts[\s\S]*reported:[\s\S]*line: 4/);
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "index may be incomplete"));
});

test("different counts do not invent pairings and explicit failure remains visible", () => {
	const view = projection.result(reported({ operation: "references", ok: false, status: "error", resultCount: 2,
		result: [rawA, rawB], locations: [a], errors: ["reference lookup incomplete"], metadata: { supported: false } }), request);
	assert.equal(view.reportedFailure, true);
	assert.ok(!view.parts.some(part => part.kind === "locations"));
	const combined = view.parts.filter(part => part.kind === "structured-data").map(part => structuredLines(part.value, 200).join("\n")).join("\n");
	assert.match(combined, /result:[\s\S]*workspace\/a\.ts[\s\S]*workspace\/b\.ts[\s\S]*locations:[\s\S]*workspace\/a\.ts/);
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "reference lookup incomplete" && part.severity === "error"));
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text.includes("unsupported")));
});

test("empty and unrelated or malformed navigation envelopes do not turn into invented matches", () => {
	const empty = projection.result(reported({ operation: "references", ok: true, status: "empty", resultCount: 0,
		notes: ["No references reported"], hints: ["The index can be incomplete"] }), request);
	assert.ok(!empty.parts.some(part => part.kind === "locations"));
	assert.ok(empty.parts.some(part => part.kind === "notice" && part.text === "The index can be incomplete"));
	const unrelated = reported({ operation: "hover", result: { contents: "source detail" } });
	assert.deepEqual(projection.result(unrelated, request).parts, [{ kind: "original-content" }]);
	const reversed = { ...a, range: { start: { line: 3, character: 17 }, end: { line: 3, character: 10 } } };
	const invalid = projection.result(reported({ operation: "references", status: "success", result: [rawA], locations: [reversed] }), request);
	assert.ok(!invalid.parts.some(part => part.kind === "locations"));
});
