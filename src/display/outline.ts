import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OutlineEntry, ResultPart } from "../presentation.ts";
import { compactTarget, wrapPrefixed } from "./text.ts";
import { structuredLines } from "./structured.ts";

export function outlineLines(part: Extract<ResultPart, { kind: "code-outline" }>, width: number, theme: Theme, home: string): string[] {
	const lines = [theme.bold(compactTarget(part.section ? `${part.path} · ${part.section}` : part.path, width, home))];
	const pending: { readonly item: OutlineEntry; readonly depth: number }[] = [];
	for (let index = part.items.length - 1; index >= 0; index--) pending.push({ item: part.items[index]!, depth: 0 });
	while (pending.length) {
		const { item, depth } = pending.pop()!;
		const indent = "  ".repeat(depth + 1);
		if (item.kind === "uninterpreted") {
			lines.push(...structuredLines(item.value, width, depth + 1));
			continue;
		}
		const location = item.range ? `L${item.range.firstLine1}${item.range.lastLine1 !== undefined && item.range.lastLine1 !== item.range.firstLine1
			? `–${item.range.lastLine1}` : ""} ` : "";
		const base = [item.symbolKind, item.name].filter(value => value !== undefined).join(" ");
		const label = item.signature ?? base + (item.detail === undefined ? "" : (item.detail.startsWith("(") ? "" : " ") + item.detail);
		lines.push(...wrapPrefixed(`${label}${item.containerName === undefined ? "" : ` (in ${item.containerName})`}`, width, indent + location));
		if (item.extra) lines.push(...structuredLines(item.extra, width, depth + 2));
		for (let index = item.children.length - 1; index >= 0; index--) pending.push({ item: item.children[index]!, depth: depth + 1 });
	}
	if (part.extra) lines.push(...structuredLines(part.extra, width, 1));
	return lines;
}
