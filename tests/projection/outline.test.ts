import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { outlineLines } from "../../src/display/outline.ts";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

const declaration: EffectiveDeclaration = {
	description: "Return a syntax-only outline.",
	input: { kind: "json", schema: { type: "object", required: ["paths"], properties: {
		paths: { type: "array", items: { type: "string" }, description: "Files or directories to outline." },
		lang: { type: "string", enum: ["typescript", "javascript"] },
	} } },
};
const projection = compileProjection(declaration);
const request = projection.request({ paths: ["src"] });
const theme = { bold: (text: string) => text } as Theme;

function supplied(value: Json, suffix = "", details: Json = {}): SuppliedToolResult {
	return { content: [{ kind: "text", text: JSON.stringify(value) + suffix }], details, isError: false };
}

test("outline results show ordered files and nested symbols with corroborated returned ranges", () => {
	assert.equal(request.kind, "code.outline");
	const first = { role: "item", symbolType: "class", name: "Counter", signature: "export class Counter {",
		range: { start: { line: 2, column: 0 }, end: { line: 7, column: 1 } },
		read: { path: "src/a.ts", offset: 3, limit: 6 }, isExported: true,
		members: [{ role: "member", symbolType: "method", name: "add", signature: "add(value: number) {",
			range: { start: { line: 3, column: 2 }, end: { line: 5, column: 3 } },
			read: { path: "src/a.ts", offset: 4, limit: 3 } }] };
	const suffix = "\n\nproducer warning: limited coverage";
	const original = supplied({ outline: [{ path: "src/a.ts", language: "TypeScript", items: [first] },
		{ path: "src/b.ts", items: [{ symbolType: "function", name: "add" }] }] }, suffix, { syntaxOnly: true });
	const view = projection.result(original, request);
	const groups = view.parts.filter(part => part.kind === "code-outline");
	assert.equal(groups.length, 2);
	const [a, b] = groups;
	assert.ok(a && b && a.kind === "code-outline" && b.kind === "code-outline");
	assert.equal(a.path, "src/a.ts");
	assert.equal(b.path, "src/b.ts");
	const klass = a.items[0];
	assert.ok(klass?.kind === "symbol");
	assert.deepEqual(klass.range, { firstLine1: 3, lastLine1: 8 });
	assert.equal(klass.exported, true);
	assert.ok(klass.children[0]?.kind === "symbol");
	assert.deepEqual(klass.children[0].range, { firstLine1: 4, lastLine1: 6 });
	const rendered = outlineLines(a, 100, theme, "/home").join("\n");
	assert.match(rendered, /src\/a\.ts[\s\S]*L3–8 export class Counter[\s\S]*L4–6 add\(value/);
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "Syntax-only outline"));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === suffix));
	assert.equal(original.content[0]?.kind === "text" && original.content[0].text, JSON.stringify({ outline: [
		{ path: "src/a.ts", language: "TypeScript", items: [first] }, { path: "src/b.ts", items: [{ symbolType: "function", name: "add" }] },
	] }) + suffix);
});

test("partial, conflicting and unrecognized records remain visible without inventing positions", () => {
	const range = { start: { line: 8, column: 0 }, end: { line: 10, column: 1 } };
	const original = supplied({ outline: [
		{ path: "src/a.ts", items: [{ name: "first", symbolType: "function", range,
			read: { path: "src/other.ts", offset: 9, limit: 3 }, warning: "symbol incomplete" },
			{ unexpected: "unknown member" }, { name: "last", members: "unparsed children" }] },
		{ problem: "unknown group" },
	], warning: "index incomplete" }, "\nproducer footer", { warnings: ["some files were unavailable"], truncated: true });
	const view = projection.result(original, request);
	const group = view.parts.find(part => part.kind === "code-outline");
	assert.ok(group?.kind === "code-outline");
	assert.equal(group.items.length, 3);
	const first = group.items[0];
	assert.ok(first?.kind === "symbol");
	assert.equal(first.range, undefined);
	assert.deepEqual(first.extra?.range, range);
	assert.equal(first.extra?.warning, "symbol incomplete");
	assert.deepEqual(group.items[1], { kind: "uninterpreted", value: { unexpected: "unknown member" } });
	const rendered = outlineLines(group, 150, theme, "/home").join("\n");
	assert.match(rendered, /first[\s\S]*symbol\s+incomplete[\s\S]*unknown member[\s\S]*last[\s\S]*unparsed children/);
	assert.ok(view.parts.some(part => part.kind === "text" && part.text.includes("unknown group")));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text.includes("index incomplete")));
	assert.ok(view.parts.some(part => part.kind === "notice" && part.text === "some files were unavailable"));
	assert.ok(view.parts.some(part => part.kind === "coverage" && part.reason === "truncated"));
	assert.ok(view.parts.some(part => part.kind === "text" && part.text === "\nproducer footer"));
});

test("unrecognized output and non-text content remain original, including failed results", () => {
	const raw = { content: [{ kind: "text", text: '{"unexpected":true}\nmore text' },
		{ kind: "text", text: "producer failure" }], isError: true } satisfies SuppliedToolResult;
	assert.deepEqual(projection.result(raw, request).parts, [{ kind: "original-content" }]);
	const mixed = { content: [{ kind: "text", text: "earlier warning" },
		{ kind: "text", text: JSON.stringify({ outline: [{ path: "a.ts", items: [{ name: "f" }] }] }) },
		{ kind: "other", value: { arbitrary: true } }], isError: true } satisfies SuppliedToolResult;
	const view = projection.result(mixed, request);
	assert.deepEqual(view.parts[0], { kind: "original-content", indexes: [0] });
	assert.equal(view.parts[1]?.kind, "code-outline");
	assert.deepEqual(view.parts[2], { kind: "original-content", indexes: [2] });
	assert.equal(mixed.isError, true);
});
