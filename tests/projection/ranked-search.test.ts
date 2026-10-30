import assert from "node:assert/strict";
import test from "node:test";
import type { Json, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";
import { rankedSearchLines } from "../../src/display/ranked-search.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const projection = compileProjection({ description: "Find files by identifier.", input: { kind: "json", schema: {
	type: "object", required: ["query"], properties: {
		query: { type: "string", description: "Identifier-ish query" },
		lang: { type: "string", description: "Restrict hits to one language" },
		paths: { type: "array", items: { type: "string" } },
		limit: { type: "number" },
	},
} } });
const request = projection.request({ query: "add", limit: 2 });

function sample() {
	const payload = { available: true, query: "add", coverage: { files: 4, truncated: true }, results: [
		{ file: "src/app.ts", score: 1.089231283737057, hits: 2, startLine: 1, endLine: 3,
			annotations: { fanIn: 0 }, suggestedNext: { tool: "module_report", path: "src/app.ts" } },
		{ file: "src/app.ts", score: 0.5, hits: 1, startLine: 6, endLine: 6, future: { kind: "extra" } },
	], futureCoverage: "retained" };
	const summary = ["Top 2 file(s) for \"add\":", "  1. src/app.ts (score 1.09, 2 hit(s), line 1)",
		"  2. src/app.ts (score 0.50, 1 hit(s), line 6)", "Index covers 4 files (capped — results may be incomplete)."].join("\n");
	const footer = "\n\nproducer footer";
	const result: SuppliedToolResult = { content: [{ kind: "text", text: `${summary}\n\n${JSON.stringify(payload)}${footer}` }],
		isError: false, details: { available: true, query: "add", count: 2, coverage: payload.coverage } };
	return { payload, result, footer };
}

test("ranked identifier search retains reported facts, order, extra fields and trailing output", () => {
	const { payload, result, footer } = sample();
	const view = projection.result(result, request);
	const part = view.parts[0];
	assert.equal(part?.kind, "ranked-files");
	if (part?.kind !== "ranked-files") return;
	assert.deepEqual(part.items.map(item => [item.path, item.score, item.hits, item.firstLine1, item.lastLine1]),
		payload.results.map(item => [item.file, item.score, item.hits, item.startLine, item.endLine]));
	assert.deepEqual(part.items[0]?.extra, { annotations: { fanIn: 0 }, suggestedNext: { tool: "module_report", path: "src/app.ts" } });
	assert.deepEqual(part.items[1]?.extra, { future: { kind: "extra" } });
	assert.deepEqual(part.extra, { futureCoverage: "retained" });
	assert.deepEqual(part.coverage, { files: 4, truncated: true });
	assert.deepEqual(view.parts[1], { kind: "text", text: footer });
	assert.equal(result.content[0]?.kind === "text" && result.content[0].text.includes(JSON.stringify(payload)), true);

	const lines = rankedSearchLines(part, 120, { bold: (value: string) => value } as Theme, "/home/user").join("\n");
	assert.match(lines, /src\/app\.ts.*L1–3.*score 1\.09/);
	assert.match(lines, /src\/app\.ts.*L6/);
	assert.match(lines, /results may be incomplete/);
	assert.match(lines, /suggestedNext/);
	assert.ok(rankedSearchLines(part, 24, { bold: (value: string) => value } as Theme, "/home/user")
		.every(line => visibleWidth(line) <= 24));
});

test("unavailable, empty, partial, conflicting and unrecognized results stay original", () => {
	const { result } = sample();
	const original = result.content[0];
	assert.equal(original?.kind, "text");
	if (original?.kind !== "text") return;
	const cases: SuppliedToolResult[] = [
		{ ...result, isError: true },
		{ ...result, structuredContent: { warning: "additional information" } },
		{ ...result, details: { available: false, query: "add", hint: "still building" } },
		{ ...result, details: { available: true, query: "add", count: 0 } },
		{ ...result, details: { ...(result.details as Record<string, Json>), warning: "partial" } },
		{ ...result, details: { ...(result.details as Record<string, Json>), coverage: { files: 5, truncated: true } } },
		{ ...result, content: [{ kind: "text", text: original.text.replace("score 1.09", "score 1.10") }] },
		{ ...result, content: [{ kind: "text", text: original.text.slice(0, original.text.indexOf("\n\n{" ) + 5) }] },
		{ ...result, content: [...result.content, { kind: "text", text: "warning" }] },
	];
	for (const candidate of cases) assert.deepEqual(projection.result(candidate, request).parts, [{ kind: "original-content" }]);
	assert.deepEqual(projection.result(result, projection.request({ query: "other" })).parts, [{ kind: "original-content" }]);
});
