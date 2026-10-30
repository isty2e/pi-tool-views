import type { Json, JsonObject, ResultPart } from "../presentation.ts";
import { lspEnvelopeParts } from "./lsp-envelope.ts";
import { lspRange } from "./lsp-range.ts";
import { object, stringAt } from "./schema.ts";

function contentParts(value: Json): ResultPart[] {
	if (typeof value === "string") return [{ kind: "markup", format: "markdown", text: value }];
	if (Array.isArray(value)) return value.flatMap(entry => Array.isArray(entry)
		? [{ kind: "structured-data", value: entry } as const] : contentParts(entry));
	const content = object(value);
	if (!content) return [{ kind: "structured-data", value }];
	const text = stringAt(content, "value"), language = stringAt(content, "language");
	const format = content.kind === "markdown" || content.kind === "plaintext" ? content.kind : undefined;
	if (text === undefined || (!format && language === undefined)) return [{ kind: "structured-data", value }];
	const parts: ResultPart[] = format ? [{ kind: "markup", format, text }]
		: [{ kind: "source", source: { text, ...(language === undefined ? {} : { language }) } }];
	const extra = Object.fromEntries(Object.entries(content).filter(([key]) => !["kind", "language", "value"].includes(key)));
	if (format && content.language !== undefined) extra.language = content.language;
	if (!format && content.kind !== undefined) extra.kind = content.kind;
	if (Object.keys(extra).length) parts.push({ kind: "structured-data", value: extra });
	return parts;
}

export function hoverObject(root: JsonObject): ResultPart[] | undefined {
	const result = object(root.result);
	if (root.operation !== "hover" || !result || result.contents === undefined) return undefined;
	const parts: ResultPart[] = [];
	const path = stringAt(root, "filePath");
	for (const [key, value] of Object.entries(result)) {
		if (key === "contents") parts.push(...contentParts(value));
		else if (key === "range") {
			const range = lspRange(value);
			if (range && path) parts.push({ kind: "locations", items: [{ target: { kind: "file", path },
				line: range.start.line, indexBase: 0, character: range.start.character, characterUnit: "utf16", endExclusive: range.end }] });
			else parts.push({ kind: "structured-data", value: { range: value } });
		} else parts.push({ kind: "structured-data", value: { [key]: value } });
	}
	return lspEnvelopeParts(root, new Map([["result", parts]]), "results");
}
