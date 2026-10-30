import type { Json, JsonObject, ResultPart, SearchRequest, SuppliedToolResult } from "../presentation.ts";
import { object } from "./schema.ts";

type RankedPart = Extract<ResultPart, { kind: "ranked-files" }>;

function extras(value: JsonObject, known: readonly string[]): JsonObject | undefined {
	const entries = Object.entries(value).filter(([key]) => !known.includes(key));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function nonnegative(value: Json | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function rankedSearchParts(result: SuppliedToolResult, request: SearchRequest): readonly ResultPart[] | undefined {
	if (request.kind !== "search.symbols" || result.isError || result.structuredContent !== undefined || result.content.length !== 1) return undefined;
	const content = result.content[0], details = object(result.details);
	if (content?.kind !== "text" || !details || Object.keys(details).some(key => !["available", "query", "count", "coverage"].includes(key))) return undefined;
	const marker = content.text.lastIndexOf("\n\n{");
	if (marker < 0) return undefined;
	const jsonStart = marker + 2, jsonEnd = content.text.indexOf("\n", jsonStart);
	let payload: JsonObject | undefined;
	try {
		payload = object(JSON.parse(content.text.slice(jsonStart, jsonEnd < 0 ? undefined : jsonEnd)));
	} catch {
		return undefined;
	}
	if (!payload || payload.available !== true || payload.query !== request.query || details.available !== true
		|| details.query !== payload.query || !Array.isArray(payload.results) || !payload.results.length
		|| details.count !== payload.results.length) return undefined;
	const coverage = object(payload.coverage), detailCoverage = object(details.coverage);
	if (!coverage || !detailCoverage || !nonnegative(coverage.files) || typeof coverage.truncated !== "boolean"
		|| detailCoverage.files !== coverage.files || detailCoverage.truncated !== coverage.truncated
		|| Object.keys(detailCoverage).some(key => !["files", "truncated"].includes(key))) return undefined;

	const items: RankedPart["items"][number][] = [];
	for (const value of payload.results) {
		const hit = object(value);
		if (!hit || typeof hit.file !== "string" || !hit.file || typeof hit.score !== "number" || !Number.isFinite(hit.score)
			|| !nonnegative(hit.hits) || !nonnegative(hit.startLine) || hit.startLine < 1
			|| !nonnegative(hit.endLine) || hit.endLine < hit.startLine) return undefined;
		const extra = extras(hit, ["file", "score", "hits", "startLine", "endLine"]);
		items.push({ path: hit.file, score: hit.score, hits: hit.hits, firstLine1: hit.startLine, lastLine1: hit.endLine,
			...(extra ? { extra } : {}) });
	}

	const header = `Top ${items.length} file(s) for "${payload.query}":`;
	const lines = items.map((hit, index) => `  ${index + 1}. ${hit.path} (score ${hit.score.toFixed(2)}, ${hit.hits} hit(s), line ${hit.firstLine1})`);
	const coverageText = `Index covers ${coverage.files} files${coverage.truncated ? " (capped — results may be incomplete)" : ""}.`;
	if (content.text.slice(0, marker) !== [header, ...lines, coverageText].join("\n")) return undefined;
	const extra = extras(payload, ["available", "query", "coverage", "results"]);
	const coverageExtra = extras(coverage, ["files", "truncated"]);
	const part: RankedPart = { kind: "ranked-files", query: request.query, items,
		coverage: { files: coverage.files, truncated: coverage.truncated, ...(coverageExtra ? { extra: coverageExtra } : {}) },
		...(extra ? { extra } : {}) };
	const suffix = jsonEnd < 0 ? "" : content.text.slice(jsonEnd);
	return [part, ...(suffix ? [{ kind: "text" as const, text: suffix }] : [])];
}
