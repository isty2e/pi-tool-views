import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { outlineLines } from "../../src/display/outline.ts";
import { structuredLines } from "../../src/display/structured.ts";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = { description: "Navigate source code.", input: { kind: "json", schema: {
	type: "object", required: ["operation"], properties: {
		operation: { type: "string", description: "LSP operation to perform." },
		path: { type: "string", description: "Target file path." },
	},
} } };
const projection = compileProjection(declaration);
const request = projection.request({ operation: "documentSymbol", path: "/workspace/a.ts" });
const theme = { bold: (text: string) => text } as Theme;

function reported(root: Json, suffix = ""): SuppliedToolResult {
	return { content: [{ kind: "text", text: JSON.stringify(root) + suffix }], isError: false };
}

test("document symbols reuse the outline model and keep reported LSP location and ownership", () => {
	assert.equal(request.kind, "code.document-symbols");
	const result = reported({ operation: "documentSymbol", ok: true, status: "success", filePath: "/workspace/a.ts", resultCount: 3,
		result: [
			{ name: "add", kind: 12, location: { uri: "file:///workspace/a.ts", range: {
				start: { line: 2, character: 0 }, end: { line: 7, character: 1 },
			} } },
			{ name: "result", kind: 14, containerName: "add", location: { uri: "file:///workspace/a.ts", range: {
				start: { line: 3, character: 2 }, end: { line: 4, character: 0 },
			} } },
			{ name: "external", kind: 12, location: { uri: "file:///workspace/b.ts", range: {
				start: { line: 1, character: 0 }, end: { line: 1, character: 8 },
			} } },
		], metadata: { operation: "documentSymbol", supported: true, resultCount: 3 },
	}, "\nproducer footer");
	const view = projection.result(result, request);
	const groups = view.parts.filter(part => part.kind === "code-outline");
	assert.equal(groups.length, 2);
	const [a, b] = groups;
	assert.ok(a?.kind === "code-outline" && b?.kind === "code-outline");
	assert.equal(a.path, "/workspace/a.ts");
	assert.equal(b.path, "file:///workspace/b.ts");
	assert.deepEqual(a.items[0], { kind: "symbol", name: "add", symbolKind: "function",
		range: { firstLine1: 3, lastLine1: 8 }, children: [] });
	assert.deepEqual(a.items[1], { kind: "symbol", name: "result", symbolKind: "constant", containerName: "add",
		range: { firstLine1: 4, lastLine1: 4 }, children: [] });
	assert.match(outlineLines(a, 100, theme, "/home").join("\n"), /L3–8 function add[\s\S]*L4 constant result \(in add\)/);
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nproducer footer"));
});

test("nested symbols keep hierarchy while unknown properties and malformed positions remain visible", () => {
	const result = reported({ operation: "documentSymbol", ok: true, status: "success", filePath: "/workspace/a.ts",
		result: [{ name: "Calculator", kind: 5, range: { start: { line: 9, character: 0 }, end: { line: 15, character: 1 } },
			children: [{ name: "calculate", kind: 6, range: { start: { line: -1, character: 0 }, end: { line: 12, character: 1 } },
				warning: "position unavailable" }, { opaque: "unrecognized" }] }],
		metadata: { operation: "documentSymbol", supported: false, customWarning: "index incomplete" },
	});
	const view = projection.result(result, request);
	const group = view.parts.find(part => part.kind === "code-outline");
	assert.ok(group?.kind === "code-outline");
	const parent = group.items[0];
	assert.ok(parent?.kind === "symbol");
	assert.deepEqual(parent.range, { firstLine1: 10, lastLine1: 16 });
	const child = parent.children[0];
	assert.ok(child?.kind === "symbol");
	assert.equal(child.range, undefined);
	assert.equal(child.extra?.warning, "position unavailable");
	assert.ok(child.extra?.range);
	assert.deepEqual(parent.children[1], { kind: "uninterpreted", value: { opaque: "unrecognized" } });
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text.includes("unsupported")));
	assert.ok(view.parts.some(part => part.kind === "structured-data" && structuredLines(part.value, 200).join("\n").includes("index incomplete")));
});

test("empty and failed document-symbol responses retain their explanation and original result", () => {
	const output = reported({ operation: "documentSymbol", ok: false, status: "error", filePath: "/workspace/a.ts",
		resultCount: 0, errors: ["File is unavailable"], notes: ["Try another path"], metadata: {} }, "\nraw footer");
	const view = projection.result({ ...output, isError: true }, request);
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "File is unavailable" && part.severity === "error"));
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "Try another path"));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nraw footer"));
	assert.equal(output.content[0]?.kind === "text" && output.content[0].text.includes("File is unavailable"), true);
	const unrelated = reported({ operation: "hover", result: [{ name: "not a symbol result" }] });
	assert.deepEqual(projection.result(unrelated, request).parts, [{ kind: "original-content" }]);
});

test("unattributable symbols stay in order without inheriting a fabricated file and conflicting failure is visible", () => {
	const output = reported({ operation: "documentSymbol", ok: false, status: "success", filePath: "/workspace/a.ts",
		result: [{ name: "before", kind: 12 }, { name: "unknown target", location: { uri: 42 } }, { name: "after", kind: 12 }] });
	const view = projection.result(output, request);
	assert.equal(view.reportedFailure, true);
	const groups = view.parts.filter(part => part.kind === "code-outline" || (part.kind === "structured-data" && structuredLines(part.value, 200).join("\n").includes("unknown target")));
	assert.equal(groups.length, 3);
	assert.equal(groups[0]?.kind, "code-outline");
	assert.equal(groups[1]?.kind, "structured-data");
	assert.equal(groups[2]?.kind, "code-outline");
	assert.ok(view.parts.some(part => part.kind === "notice" && part.severity === "error" && part.text.includes("failure")));
});
