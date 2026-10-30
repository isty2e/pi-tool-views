import type { Json, ReportedLocation, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { object, stringAt } from "./schema.ts";

function positive(value: Json | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function groupedSearchParts(result: SuppliedToolResult): readonly ResultPart[] | undefined {
	const details = object(result.details);
	if (details?.groupByFile !== true || !Array.isArray(details.matchLocations)
		|| details.matchLocations.length === 0 || details.matchCount !== details.matchLocations.length) return undefined;
	const expected = new Map<string, number[]>();
	for (const value of details.matchLocations) {
		const entry = object(value), path = entry && stringAt(entry, "file"), line = entry && positive(entry.line);
		if (!path || line === undefined) return undefined;
		const lines = expected.get(path) ?? [];
		lines.push(line);
		expected.set(path, lines);
	}

	const decoded = new Map<string, readonly ReportedLocation[]>();
	for (const content of result.content) {
		if (content.kind !== "text") continue;
		for (const supplied of content.text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
			const text = supplied[0].replace(/\r\n$|[\r\n]$/, "");
			const match = /^(.+) \((\d+)\): (L\d+:\d+(?:, L\d+:\d+)*)$/.exec(text);
			if (!match || !expected.has(match[1]!)) continue;
			const path = match[1]!, expectedLines = expected.get(path)!;
			const positions = match[3]!.split(", ").map(position => /^L(\d+):(\d+)$/.exec(position)!);
			if (decoded.has(path) || Number(match[2]) !== expectedLines.length || positions.length !== expectedLines.length) return undefined;
			const locations: ReportedLocation[] = [];
			for (const [index, position] of positions.entries()) {
				const line = positive(Number(position[1])), character = positive(Number(position[2]));
				if (line === undefined || character === undefined || line !== expectedLines[index]) return undefined;
				locations.push({ target: { kind: "file", path }, line, indexBase: 1, character, characterUnit: "unreported" });
			}
			decoded.set(path, locations);
		}
	}
	if (decoded.size !== expected.size) return undefined;

	const parts: ResultPart[] = [];
	const skip = typeof details.skip === "number" && Number.isSafeInteger(details.skip) && details.skip >= 0 ? details.skip : undefined;
	const total = typeof details.totalMatches === "number" && Number.isSafeInteger(details.totalMatches) ? details.totalMatches : undefined;
	const count = positive(details.matchCount);
	const advice = details.hasMore === true && skip !== undefined && total !== undefined && count !== undefined && total - skip >= count
		? `(Showing ${count} of ${total - skip} remaining matches. Use skip=${skip + count} for the next page.)` : undefined;

	const pushRaw = (text: string) => {
		let ordinary = "";
		for (const supplied of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
			const line = supplied[0], body = line.replace(/\r\n$|[\r\n]$/, "");
			if (advice && body === advice) {
				if (ordinary.trim()) parts.push({ kind: "text", text: ordinary });
				parts.push({ kind: "coverage", reason: "continuation", producerText: body });
				ordinary = line.slice(body.length);
			} else ordinary += line;
		}
		if (ordinary) parts.push({ kind: "text", text: ordinary });
	};

	for (const [index, content] of result.content.entries()) {
		if (content.kind !== "text") { parts.push({ kind: "original-content", indexes: [index] }); continue; }
		let raw = "";
		for (const supplied of content.text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
			const line = supplied[0];
			if (!line) continue;
			const text = line.replace(/\r\n$|[\r\n]$/, "");
			const match = /^(.+) \((\d+)\): (L\d+:\d+(?:, L\d+:\d+)*)$/.exec(text);
			const locations = match && decoded.get(match[1]!);
			if (!locations) { raw += line; continue; }
			if (raw) { pushRaw(raw); raw = ""; }
			parts.push({ kind: "locations", items: locations });
		}
		if (raw) pushRaw(raw);
	}
	if (details.hasMore === true) {
		parts.push({ kind: "coverage", reason: "continuation" });
	} else if (details.truncated === true) {
		parts.push({ kind: "coverage", reason: "truncated" });
	}
	return parts;
}
