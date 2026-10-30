import type { JsonObject, ResultPart } from "../presentation.ts";
import { object } from "./schema.ts";

export function lspEnvelopeParts(root: JsonObject, replacements: ReadonlyMap<string, readonly ResultPart[]>, unit: "symbols" | "locations" | "results"): ResultPart[] {
	const parts: ResultPart[] = [];
	for (const [key, value] of Object.entries(root)) {
		const replacement = replacements.get(key);
		if (replacement !== undefined) parts.push(...replacement);
		else if (["errors", "notes", "hints"].includes(key) && Array.isArray(value)) {
			for (const entry of value) parts.push(typeof entry === "string"
				? { kind: "notice", origin: "producer", severity: key === "errors" ? "error" : "info", text: entry }
				: { kind: "structured-data", value: entry });
		} else if (key === "status" && typeof value === "string" && value !== "success") {
			parts.push({ kind: "notice", origin: "producer", severity: value === "error" ? "error" : "info", text: `Status: ${value}` });
		} else if (key === "resultCount" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			parts.push({ kind: "text", text: `${value} ${value === 1 ? unit.slice(0, -1) : unit} reported` });
		} else if (key === "metadata") {
			const metadata = object(value);
			if (!metadata) { parts.push({ kind: "structured-data", value: { metadata: value } }); continue; }
			if (metadata.supported === false) parts.push({ kind: "notice", origin: "producer", severity: "warning", text: "Operation reported as unsupported." });
			const extra = Object.fromEntries(Object.entries(metadata).filter(([field, entry]) =>
				!(field === "operation" && entry === root.operation) && !(field === "supported" && typeof entry === "boolean")
				&& !(field === "resultCount" && entry === root.resultCount)));
			if (Object.keys(extra).length) parts.push({ kind: "structured-data", value: extra });
		} else if (key === "ok" && value === false && root.status !== "error") {
			parts.push({ kind: "notice", origin: "producer", severity: "error", text: "Operation reported failure." });
		} else if (!((key === "tool" || key === "filePath" || key === "operation") && typeof value === "string")
			&& !(key === "ok" && typeof value === "boolean") && !(key === "status" && value === "success")) {
			parts.push({ kind: "structured-data", value: { [key]: value } });
		}
	}
	return parts;
}
