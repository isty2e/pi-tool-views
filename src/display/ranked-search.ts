import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ResultPart } from "../presentation.ts";
import { structuredLines } from "./structured.ts";
import { compactTarget, wrap, wrapPrefixed } from "./text.ts";

export function rankedSearchLines(part: Extract<ResultPart, { kind: "ranked-files" }>, width: number, theme: Theme, home: string): string[] {
	const lines = wrap(`Top ${part.items.length} file(s) for "${part.query}":`, width);
	for (const [index, item] of part.items.entries()) {
		const range = item.firstLine1 === item.lastLine1 ? `L${item.firstLine1}` : `L${item.firstLine1}–${item.lastLine1}`;
		const suffix = ` (${range}, ${item.hits} hit(s), score ${item.score.toPrecision(3)})`;
		const prefix = `  ${index + 1}. `;
		const target = compactTarget(item.path, Math.max(1, width - visibleWidth(prefix + suffix)), home);
		lines.push(...wrapPrefixed(theme.bold(target) + suffix, width, prefix));
		if (item.extra) lines.push(...structuredLines(item.extra, width, 2));
	}
	lines.push(...wrap(`Index covers ${part.coverage.files} files${part.coverage.truncated ? " (capped — results may be incomplete)" : ""}.`, width));
	if (part.coverage.extra) lines.push(...structuredLines(part.coverage.extra, width, 1));
	if (part.extra) lines.push(...structuredLines(part.extra, width, 0));
	return lines;
}
