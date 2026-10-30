import type { JsonObject, ResultPart } from "../presentation.ts";
import { reportedSymbol } from "./reported-symbol.ts";
import { stringAt } from "./schema.ts";

export function moduleReportObject(root: JsonObject): ResultPart[] | undefined {
	const path = stringAt(root, "path");
	if (path === undefined || typeof root.available !== "boolean" || (!Array.isArray(root.api) && !Array.isArray(root.internal))) return undefined;
	const parts: ResultPart[] = [];
	if (!root.available) parts.push({ kind: "notice", origin: "producer", severity: "warning", text: "Module report unavailable." });
	const staleness = stringAt(root, "staleness");
	if (staleness !== undefined) parts.push({ kind: "notice", origin: "producer", severity: staleness === "fresh" ? "info" : "warning", text: `Report freshness: ${staleness}` });
	const language = stringAt(root, "language");
	for (const [key, value] of Object.entries(root)) {
		if ((key === "api" || key === "internal") && Array.isArray(value) && value.length) {
			parts.push({ kind: "code-outline", path, ...(language === undefined ? {} : { language }), section: key === "api" ? "API" : "Internal",
				items: value.map(reportedSymbol) });
		}
	}
	const metadata = Object.fromEntries(Object.entries(root).filter(([key, value]) =>
		!((key === "api" || key === "internal") && Array.isArray(value) && value.length > 0)
		&& !(key === "available" && typeof value === "boolean") && !(key === "staleness" && typeof value === "string")));
	if (Object.keys(metadata).length) parts.push({ kind: "structured-data", value: metadata });
	return parts;
}
