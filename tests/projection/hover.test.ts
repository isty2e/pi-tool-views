import assert from "node:assert/strict";
import test from "node:test";
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
const request = projection.request({ operation: "hover", path: "/workspace/a.ts", line: 3 });

function reported(value: Json, suffix = "", isError = false): SuppliedToolResult {
	return { content: [{ kind: "text", text: JSON.stringify(value) + suffix }], isError };
}

test("hover retains supplied markup and its actual UTF-16 range without inventing file content", () => {
	assert.equal(request.kind, "code.navigation");
	const markdown = "\n```typescript\n(alias) add(a: number): number\n```\n";
	const root = { operation: "hover", ok: true, status: "success", filePath: "/workspace/a.ts", resultCount: 1,
		result: { contents: { kind: "markdown", value: markdown }, range: {
			start: { line: 2, character: 21 }, end: { line: 2, character: 24 },
		} }, metadata: { operation: "hover", supported: true, resultCount: 1 } };
	const output = reported(root, "\nproducer footer");
	const view = projection.result(output, request);
	assert.ok(view.parts.some(part => part.kind === "markup" && part.format === "markdown" && part.text === markdown));
	const position = view.parts.find(part => part.kind === "locations");
	assert.ok(position?.kind === "locations");
	assert.deepEqual(position.items[0], { target: { kind: "file", path: "/workspace/a.ts" }, line: 2, indexBase: 0,
		character: 21, characterUnit: "utf16", endExclusive: { line: 2, character: 24 } });
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nproducer footer"));
	assert.equal(output.content[0]?.kind === "text" && output.content[0].text, JSON.stringify(root) + "\nproducer footer");
});

test("mixed hover contents retain order, markup kind, source language and unknown values", () => {
	const view = projection.result(reported({ operation: "hover", ok: true, status: "success", filePath: "/workspace/a.ts",
		result: { contents: ["**description**", { language: "typescript", value: "const x = 1;" },
			{ kind: "plaintext", value: "actual text", warning: "partial detail" }, { future: "unknown item" }, ["unexpected nesting"]] } }), request);
	const items = view.parts.filter(part => ["markup", "source", "structured-data"].includes(part.kind));
	assert.equal(items.length, 6);
	assert.deepEqual(items[0], { kind: "markup", format: "markdown", text: "**description**" });
	assert.deepEqual(items[1], { kind: "source", source: { text: "const x = 1;", language: "typescript" } });
	assert.deepEqual(items[2], { kind: "markup", format: "plaintext", text: "actual text" });
	assert.ok(items[3]?.kind === "structured-data" && structuredLines(items[3].value, 100).join("\n").includes("partial detail"));
	assert.ok(items[4]?.kind === "structured-data" && structuredLines(items[4].value, 100).join("\n").includes("unknown item"));
	assert.deepEqual(items[5], { kind: "structured-data", value: ["unexpected nesting"] });
});

test("missing or inconsistent hover positions remain unassigned and reported failures remain visible", () => {
	const reversed = { start: { line: 4, character: 5 }, end: { line: 4, character: 1 } };
	const view = projection.result(reported({ operation: "hover", ok: false, status: "error", filePath: "/workspace/a.ts",
		result: { contents: { kind: "plaintext", value: "partial answer" }, range: reversed }, errors: ["lookup incomplete"] }), request);
	assert.equal(view.reportedFailure, true);
	assert.ok(!view.parts.some(part => part.kind === "locations"));
	assert.ok(view.parts.some(part => part.kind === "structured-data" && structuredLines(part.value, 100).join("\n").includes("range")));
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "lookup incomplete"));
	const noPath = projection.result(reported({ operation: "hover", status: "success", result: {
		contents: "detail", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	} }), request);
	assert.ok(!noPath.parts.some(part => part.kind === "locations"));
	const unknown = reported({ operation: "hover", status: "success", result: { unexpected: "opaque" } });
	assert.deepEqual(projection.result(unknown, request).parts, [{ kind: "original-content" }]);
});
