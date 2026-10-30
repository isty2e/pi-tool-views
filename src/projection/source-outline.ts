import type { RequestView, ResultPart, SourceSelection, SuppliedToolResult } from "../presentation.ts";
import { reportedSymbol } from "./reported-symbol.ts";
import { object } from "./schema.ts";

export function sourceOutlineParts(result: SuppliedToolResult, request: RequestView | undefined,
	selection: SourceSelection | undefined): readonly ResultPart[] | undefined {
	if (request?.kind !== "source.enclosing" || !selection || !result.isError || result.structuredContent !== undefined
		|| result.content.length !== 1) return undefined;
	const details = object(result.details), content = result.content[0];
	if (details?.found !== false || !Array.isArray(details.outline) || details.outline.length === 0
		|| typeof details.error !== "string" || !details.error || content?.kind !== "text") return undefined;
	const marker = "\n\nNested outline:\n";
	const start = content.text.indexOf(marker);
	if (start < 0 || content.text.indexOf(marker, start + marker.length) !== -1
		|| !content.text.slice(0, start).includes(details.error)) return undefined;
	const array = JSON.stringify(details.outline), arrayStart = start + marker.length, end = arrayStart + array.length;
	if (content.text.slice(arrayStart, end) !== array || (end < content.text.length && content.text[end] !== "\n")) return undefined;

	return [
		{ kind: "text", text: content.text.slice(0, arrayStart - 1) },
		{ kind: "code-outline", path: selection.path, items: details.outline.map(reportedSymbol) },
		...(end < content.text.length ? [{ kind: "text" as const, text: content.text.slice(end) }] : []),
	];
}
