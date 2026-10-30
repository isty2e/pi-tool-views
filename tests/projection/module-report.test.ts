import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { outlineLines } from "../../src/display/outline.ts";
import { structuredLines } from "../../src/display/structured.ts";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Return a source module report.", input: { kind: "json", schema: {
	type: "object", required: ["path"], properties: {
		path: { type: "string", description: "Source file, e.g. src/app.ts." },
		maxRefsPerSymbol: { type: "number", description: "Cap on who-uses-this entries per symbol." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ path: "src/math.ts" });
const theme = { bold: (text: string) => text } as Theme;

function reported(value: Json, suffix = "", isError = false): SuppliedToolResult {
	return { content: [{ kind: "text", text: JSON.stringify(value) + suffix }], isError };
}

test("module reports reuse outline symbols and retain graph freshness, references and unknown data", () => {
	assert.equal(request.kind, "code.module-report");
	const original = reported({ available: true, staleness: "fresh", path: "src/math.ts", language: "jsts",
		summary: { symbols: 2, exports: 2 }, api: [
			{ name: "add", kind: "function", startLine: 3, endLine: 8, exported: true, signature: "(a: number)",
				usedBy: [{ file: "src/app.ts", line: 2 }], custom: "keep this" },
			{ name: "Calculator", kind: "class", startLine: 10, endLine: 17,
				members: [{ name: "calculate", kind: "method", startLine: 11, endLine: 16, signature: "(values: number[])" }] },
		], internal: [], callGraph: { available: false, reason: "stale", coverage: { complete: false } },
		provenance: { symbols: "syntax", callGraph: "none" } }, "\n\nproducer footer");
	const view = projection.result(original, request);
	const group = view.parts.find(part => part.kind === "code-outline");
	assert.ok(group?.kind === "code-outline");
	assert.equal(group.path, "src/math.ts");
	assert.equal(group.section, "API");
	const first = group.items[0];
	assert.ok(first?.kind === "symbol");
	assert.deepEqual(first.range, { firstLine1: 3, lastLine1: 8 });
	assert.equal(first.detail, "(a: number)");
	assert.equal(first.extra?.custom, "keep this");
	assert.deepEqual(first.extra?.usedBy, [{ file: "src/app.ts", line: 2 }]);
	const klass = group.items[1];
	assert.ok(klass?.kind === "symbol" && klass.children[0]?.kind === "symbol");
	assert.deepEqual(klass.children[0].range, { firstLine1: 11, lastLine1: 16 });
	const rendered = outlineLines(group, 120, theme, "/home").join("\n");
	assert.match(rendered, /L3–8 function add\(a: number\)[\s\S]*usedBy[\s\S]*src\/app\.ts[\s\S]*L10–17 class Calculator[\s\S]*L11–16 method calculate/);
	const metadata = view.parts.find(part => part.kind === "structured-data");
	assert.ok(metadata?.kind === "structured-data");
	assert.match(structuredLines(metadata.value, 120).join("\n"), /callGraph:[\s\S]*available: false[\s\S]*reason: "stale"[\s\S]*complete: false/);
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\n\nproducer footer"));
});

test("incomplete, unavailable and unrecognized reports preserve their actual evidence", () => {
	const output = reported({ available: false, staleness: "unavailable", path: "src/missing.ts", api: [], internal: [],
		semantic: { source: "none", references: false }, error: "source missing" }, "\nproducer failure", true);
	const view = projection.result(output, request);
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text.includes("unavailable")));
	assert.ok(!view.parts.some(part => part.kind === "code-outline"));
	const metadata = view.parts.find(part => part.kind === "structured-data");
	assert.ok(metadata?.kind === "structured-data");
	assert.match(structuredLines(metadata.value, 120).join("\n"), /references: false[\s\S]*source missing/);
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nproducer failure"));
	const unrelated = reported({ path: "src/math.ts", api: "not a symbol list", warning: "unknown format" });
	assert.deepEqual(projection.result(unrelated, request).parts, [{ kind: "original-content" }]);
});

test("partial symbols retain unknown records and inconsistent line bounds without fabricating a range", () => {
	const view = projection.result(reported({ available: true, path: "src/math.ts", api: [
		{ name: "wrong", kind: "variable", startLine: 7, endLine: 2, warning: "line information incomplete" },
		{ unfamiliar: "raw record" }, { name: "another", members: "unknown children" },
	] }), request);
	const group = view.parts.find(part => part.kind === "code-outline");
	assert.ok(group?.kind === "code-outline");
	const first = group.items[0];
	assert.ok(first?.kind === "symbol");
	assert.deepEqual(first.range, { firstLine1: 7 });
	assert.equal(first.extra?.endLine, 2);
	assert.equal(first.extra?.warning, "line information incomplete");
	assert.deepEqual(group.items[1], { kind: "uninterpreted", value: { unfamiliar: "raw record" } });
	const last = group.items[2];
	assert.ok(last?.kind === "symbol");
	assert.equal(last.extra?.members, "unknown children");
});
