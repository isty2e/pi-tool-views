import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json, JsonObject, OutlineEntry, ResultPart } from "../presentation.ts";
import { object, stringAt } from "./schema.ts";
import { lspEnvelopeParts } from "./lsp-envelope.ts";

const kinds = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
	"enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null",
	"enum member", "struct", "event", "operator", "type parameter"];

function line(value: Json | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : undefined;
}

function lspRange(value: Json | undefined): { readonly firstLine1: number; readonly lastLine1?: number } | undefined {
	const range = object(value), start = range && object(range.start), end = range && object(range.end);
	const first = start && line(start.line), last = end && line(end.line), character = end && line(end.character);
	if (first === undefined) return undefined;
	if (last === undefined || character === undefined || last < first) return { firstLine1: first + 1 };
	const lastLine1 = last + (character > 0 || last === first ? 1 : 0);
	return Number.isSafeInteger(lastLine1) && lastLine1 >= first + 1
		? { firstLine1: first + 1, lastLine1 } : { firstLine1: first + 1 };
}

function symbolTarget(item: JsonObject, documentPath: string | undefined): string | undefined {
	if (item.location === undefined) return documentPath;
	const location = object(item.location), uri = location && stringAt(location, "uri");
	if (!uri) return undefined;
	if (documentPath && isAbsolute(documentPath)) {
		try { if (pathToFileURL(documentPath).href === new URL(uri).href) return documentPath; } catch { /* retain the URI */ }
	}
	return uri;
}

function symbol(value: Json, target: string): OutlineEntry {
	const item = object(value), name = item && stringAt(item, "name");
	if (!item || name === undefined || symbolTarget(item, target) !== target) return { kind: "uninterpreted", value };
	const location = object(item.location);
	const rangeValue = location?.range ?? item.range;
	const range = lspRange(rangeValue);
	const symbolKind = typeof item.kind === "number" && Number.isInteger(item.kind) ? kinds[item.kind] || undefined : undefined;
	const containerName = stringAt(item, "containerName");
	const detail = stringAt(item, "detail");
	const children = Array.isArray(item.children) ? item.children.map(child => symbol(child, target)) : [];
	const extra: Record<string, Json> = Object.create(null);
	for (const [key, entry] of Object.entries(item)) {
		if (!["name", "kind", "detail", "containerName", "range", "location", "children"].includes(key)
			|| (key === "kind" && symbolKind === undefined)
			|| (key === "detail" && typeof entry !== "string")
			|| (key === "containerName" && typeof entry !== "string")
			|| (key === "children" && !Array.isArray(entry))
			|| ((key === "range" || key === "location") && (!range || range.lastLine1 === undefined))) extra[key] = entry;
	}
	return { kind: "symbol", name, ...(symbolKind ? { symbolKind } : {}), ...(containerName === undefined ? {} : { containerName }),
		...(detail === undefined ? {} : { detail }), ...(range === undefined ? {} : { range }), children, ...(Object.keys(extra).length ? { extra } : {}) };
}

export function documentSymbolsObject(root: JsonObject): ResultPart[] | undefined {
	if (root.operation !== "documentSymbol" || (!Array.isArray(root.result) && root.status !== "empty" && root.status !== "error")) return undefined;
	const documentPath = stringAt(root, "filePath");
	const groups: ({ path: string; items: OutlineEntry[] } | { raw: Json })[] = [];
	if (Array.isArray(root.result)) {
		for (const entry of root.result) {
			const item = object(entry), target = item && symbolTarget(item, documentPath);
			if (!item || !target) {
				groups.push({ raw: entry });
				continue;
			}
			let group = groups.at(-1);
			if (!group || "raw" in group || group.path !== target) { group = { path: target, items: [] }; groups.push(group); }
			group.items.push(symbol(entry, target));
		}
	}

	const entries: ResultPart[] = groups.map(group => "raw" in group ? { kind: "structured-data", value: group.raw }
		: { kind: "code-outline", path: group.path, items: group.items });
	return lspEnvelopeParts(root, Array.isArray(root.result) ? new Map([["result", entries]]) : new Map(), "symbols");
}
