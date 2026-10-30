import type { Json, JsonObject, NavigationOperation, OutlineEntry, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { object, stringAt } from "./schema.ts";
import { documentSymbolsObject } from "./document-symbols.ts";
import { moduleReportObject } from "./module-report.ts";
import { navigationObject } from "./navigation.ts";

function leadingObject(text: string): { readonly value: JsonObject; readonly start: number; readonly end: number } | undefined {
	const start = text.search(/\S/);
	if (start < 0 || text[start] !== "{") return undefined;
	const stack: string[] = [];
	let quoted = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{" || char === "[") stack.push(char);
		else if (char === "}" || char === "]") {
			if (stack.pop() !== (char === "}" ? "{" : "[")) return undefined;
			if (!stack.length) {
				try {
					const value = object(JSON.parse(text.slice(start, index + 1)));
					return value ? { value, start, end: index + 1 } : undefined;
				} catch { return undefined; }
			}
		}
	}
	return undefined;
}

function integer(value: Json | undefined, minimum: number): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function symbolRange(item: JsonObject, path: string): { readonly firstLine1: number; readonly lastLine1?: number } | undefined {
	const range = object(item.range), read = object(item.read);
	const start = range && object(range.start), end = range && object(range.end);
	const startLine = start && integer(start.line, 0), readLine = read && integer(read.offset, 1);
	if (!read || read.path !== path || startLine === undefined || readLine !== startLine + 1) return undefined;

	const endLine = end && integer(end.line, 0), endColumn = end && integer(end.column, 0), limit = integer(read.limit, 1);
	if (endLine === undefined || endColumn === undefined || limit === undefined) return { firstLine1: readLine };
	const lastLine1 = endLine + (endColumn > 0 || endLine === startLine ? 1 : 0);
	return lastLine1 >= readLine && lastLine1 === readLine + limit - 1
		? { firstLine1: readLine, lastLine1 } : { firstLine1: readLine };
}

const symbolFields = new Set(["role", "symbolType", "name", "signature", "range", "read", "astKind", "isImport", "isExported", "isPublic", "members"]);

function symbolEntry(value: Json, path: string): OutlineEntry {
	const item = object(value);
	if (!item) return { kind: "uninterpreted", value };
	const name = stringAt(item, "name"), symbolKind = stringAt(item, "symbolType"), signature = stringAt(item, "signature");
	if (name === undefined && symbolKind === undefined && signature === undefined) return { kind: "uninterpreted", value };
	const range = symbolRange(item, path);
	const children = Array.isArray(item.members) ? item.members.map(child => symbolEntry(child, path)) : [];
	const extra: Record<string, Json> = Object.create(null);
	for (const [key, entry] of Object.entries(item)) {
		if (!symbolFields.has(key) || (key === "members" && !Array.isArray(entry))
			|| (["name", "symbolType", "signature", "role", "astKind"].includes(key) && typeof entry !== "string")
			|| (["isImport", "isExported", "isPublic"].includes(key) && typeof entry !== "boolean")
			|| ((key === "range" || key === "read") && (range === undefined || range.lastLine1 === undefined))) extra[key] = entry;
	}
	return { kind: "symbol", ...(name === undefined ? {} : { name }), ...(symbolKind === undefined ? {} : { symbolKind }),
		...(signature === undefined ? {} : { signature }), ...(range === undefined ? {} : { range }), children,
		...(typeof item.isExported === "boolean" ? { exported: item.isExported } : {}),
		...(typeof item.isImport === "boolean" ? { imported: item.isImport } : {}),
		...(typeof item.isPublic === "boolean" ? { public: item.isPublic } : {}),
		...(Object.keys(extra).length ? { extra } : {}) };
}

function outlineObject(root: JsonObject): ResultPart[] | undefined {
	if (!Array.isArray(root.outline)) return undefined;
	const parts: ResultPart[] = [];
	for (const [key, value] of Object.entries(root)) {
		if (key !== "outline") {
			parts.push({ kind: "text", text: JSON.stringify({ [key]: value }) });
			continue;
		}
		for (const entry of root.outline) {
			const group = object(entry), path = group && stringAt(group, "path");
			if (!group || path === undefined || !Array.isArray(group.items)) {
				parts.push({ kind: "text", text: JSON.stringify(entry) });
				continue;
			}
			const language = stringAt(group, "language");
			const extra = Object.fromEntries(Object.entries(group).filter(([field, entry]) => !["path", "language", "items"].includes(field)
				|| (field === "language" && typeof entry !== "string")));
			parts.push({ kind: "code-outline", path, ...(language === undefined ? {} : { language }),
				items: group.items.map(item => symbolEntry(item, path)), ...(Object.keys(extra).length ? { extra } : {}) });
		}
	}
	return parts;
}

export function structuredCodeParts(result: SuppliedToolResult, kind: "code.outline" | "code.document-symbols" | "code.module-report" | "code.navigation", operation?: NavigationOperation): { readonly parts: readonly ResultPart[]; readonly reportedFailure?: true } | undefined {
	const parts: ResultPart[] = [];
	let found = false;
	let reportedFailure: true | undefined;
	for (const [index, content] of result.content.entries()) {
		const document = content.kind === "text" ? leadingObject(content.text) : undefined;
		const outline = document && (kind === "code.outline" ? outlineObject(document.value) : kind === "code.module-report" ? moduleReportObject(document.value) : kind === "code.document-symbols" ? documentSymbolsObject(document.value) : operation ? navigationObject(document.value, operation) : undefined);
		if (!document || !outline || content.kind !== "text") {
			parts.push({ kind: "original-content", indexes: [index] });
			continue;
		}
		if (!found && kind === "code.outline" && object(result.details)?.syntaxOnly === true) parts.push({ kind: "notice", severity: "info", origin: "producer", text: "Syntax-only outline" });
		found = true;
		if ((kind === "code.document-symbols" || kind === "code.navigation") && (document.value.ok === false || document.value.status === "error")) reportedFailure = true;
		if (document.start) parts.push({ kind: "text", text: content.text.slice(0, document.start) });
		parts.push(...outline);
		if (document.end < content.text.length) parts.push({ kind: "text", text: content.text.slice(document.end) });
	}
	if (!found) return undefined;
	const details = object(result.details);
	const contentText = result.content.flatMap(content => content.kind === "text" ? [content.text] : []).join("\n");
	for (const key of ["error", "errors", "warning", "warnings"] as const) {
		const value = details?.[key];
		const messages = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
		for (const text of messages) if (text && !contentText.includes(text)) parts.push({ kind: "notice",
			severity: key === "error" || key === "errors" ? "error" : "warning", origin: "producer", text });
	}
	if (details?.truncated === true) parts.push({ kind: "coverage", reason: "truncated" });
	return { parts, ...(reportedFailure ? { reportedFailure } : {}) };
}
