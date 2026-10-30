import type { Json, OutlineEntry } from "../presentation.ts";
import { object, stringAt } from "./schema.ts";

function positiveLine(value: Json | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function reportedSymbol(value: Json): OutlineEntry {
	const item = object(value);
	if (!item) return { kind: "uninterpreted", value };
	const name = stringAt(item, "name"), symbolKind = stringAt(item, "kind"), detail = stringAt(item, "signature");
	if (name === undefined && symbolKind === undefined && detail === undefined) return { kind: "uninterpreted", value };
	const firstLine1 = positiveLine(item.startLine), last = positiveLine(item.endLine);
	const lastLine1 = firstLine1 !== undefined && last !== undefined && last >= firstLine1 ? last : undefined;
	const children = Array.isArray(item.members) ? item.members.map(reportedSymbol) : [];
	const extra: Record<string, Json> = Object.create(null);
	for (const [key, entry] of Object.entries(item)) {
		if (!["name", "kind", "signature", "startLine", "endLine", "exported", "members"].includes(key)
			|| (["name", "kind", "signature"].includes(key) && typeof entry !== "string")
			|| (key === "startLine" && firstLine1 === undefined) || (key === "endLine" && lastLine1 === undefined)
			|| (key === "exported" && typeof entry !== "boolean") || (key === "members" && !Array.isArray(entry))) extra[key] = entry;
	}
	return { kind: "symbol", ...(name === undefined ? {} : { name }), ...(symbolKind === undefined ? {} : { symbolKind }),
		...(detail === undefined ? {} : { detail }), ...(firstLine1 === undefined ? {} : { range: { firstLine1,
			...(lastLine1 === undefined ? {} : { lastLine1 }) } }), children,
		...(typeof item.exported === "boolean" ? { exported: item.exported } : {}),
		...(Object.keys(extra).length ? { extra } : {}) };
}
