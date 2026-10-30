import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveDeclaration, Json, JsonObject, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Read the enclosing symbol", input: { kind: "json", schema: {
	type: "object", required: ["path", "line"], properties: {
		path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ path: "src/math.ts", line: 10, maxLines: 2 });
assert.equal(request.kind, "source.enclosing");
const error = "Could not read enclosing range in math.ts:10: Enclosing class spans 8 lines, above maxLines 2";
const method = { name: "calculate", kind: "method", startLine: 11, endLine: 16, signature: "(values: number[])",
	parentChain: ["Calculator"], read: { path: "/fixture/src/math.ts", offset: 11, limit: 6 } };
const metadata: JsonObject = { found: false, line: 10, name: "Calculator", kind: "class", startLine: 10, endLine: 17,
	enclosingStartLine: 10, enclosingEndLine: 17, selection: { strategy: "oversize-outline" }, outline: [method],
	error: "Enclosing class spans 8 lines, above maxLines 2" };
const footer = "\n\nresult error\nusage tokens=101 elapsed-ms=0 bytes=401 truncated=false";

function failure(outline: readonly Json[] = [method], overrides: Partial<SuppliedToolResult> = {}): SuppliedToolResult {
	return { isError: true, details: { ...metadata, outline }, content: [{ kind: "text", text: `${error}\n\nNested outline:\n${JSON.stringify(outline)}${footer}` }], ...overrides };
}

test("failed enclosing reads normalize a corroborated nested outline without hiding the error", () => {
	const supplied = failure();
	const view = projection.result(supplied, request);
	assert.deepEqual(view.sourceSelection, { path: "src/math.ts", symbol: { name: "Calculator", kind: "class" },
		range: { firstLine1: 10, lastLine1: 17 } });
	assert.deepEqual(JSON.parse(JSON.stringify(view.parts)), [
		{ kind: "text", text: `${error}\n\nNested outline:` },
		{ kind: "code-outline", path: "src/math.ts", items: [{ kind: "symbol", name: "calculate", symbolKind: "method",
			detail: "(values: number[])", range: { firstLine1: 11, lastLine1: 16 }, children: [],
			extra: { parentChain: ["Calculator"], read: { path: "/fixture/src/math.ts", offset: 11, limit: 6 } } }] },
		{ kind: "text", text: footer },
	]);
	assert.equal(supplied.isError, true);
});

test("unknown outline items and invalid range data remain available in order", () => {
	const view = projection.result(failure([method, { name: "other", startLine: 0, endLine: 1 }, "unknown"]), request);
	const part = view.parts.find(item => item.kind === "code-outline");
	assert.equal(part?.kind, "code-outline");
	if (part?.kind !== "code-outline") return;
	assert.deepEqual(JSON.parse(JSON.stringify(part.items[1])), { kind: "symbol", name: "other", children: [], extra: { startLine: 0, endLine: 1 } });
	assert.deepEqual(part.items[2], { kind: "uninterpreted", value: "unknown" });
});

test("source content capture metadata remains attached to a normalized outline", () => {
	const view = projection.result(failure([method], { details: { ...metadata,
		truncation: { truncated: true, totalBytes: 1500, outputBytes: 1000 } } }), request);
	assert.deepEqual(view.contentCapture, { producerTruncated: true, omittedBytes: 500 });
	assert.ok(view.parts.some(part => part.kind === "code-outline"));
});

test("conflicting, missing, malformed or mixed outlines retain original output", () => {
	const original = failure();
	const text = original.content[0];
	assert.ok(text?.kind === "text");
	if (text?.kind !== "text") return;
	const variants = [
		failure([], { content: [{ kind: "text", text: `${error}${footer}` }] }),
		failure([method], { details: { ...metadata, line: 12 } }),
		failure([method], { content: [{ kind: "text", text: text.text.replace("calculate", "other") }] }),
		failure([method], { content: [{ kind: "text", text: text.text.slice(0, text.text.indexOf("Nested outline:") + 18) }] }),
		failure([method], { content: [...original.content, { kind: "text", text: "extra" }] }),
		failure([method], { isError: false }),
		failure([method], { structuredContent: { extra: true } }),
	];
	for (const candidate of variants) assert.deepEqual(projection.result(candidate, request).parts, [{ kind: "original-content" }]);
});
