import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ReportedLocation } from "../presentation.ts";
import { compactTarget, locationQualifier, wrap, wrapPrefixed } from "./text.ts";

export function locationLines(items: readonly ReportedLocation[], width: number, theme: Theme, home: string): string[] {
	const lines: string[] = [];
	let previous: string | undefined;
	for (const item of items) {
		const target = item.target.kind === "file" ? item.target.path : item.target.uri;
		const note = locationQualifier(item, true);
		const group = JSON.stringify([item.target.kind, target, note]);
		if (group !== previous) {
			const suffix = note ? ` (${note})` : "";
			const label = compactTarget(target, Math.max(1, width - visibleWidth(suffix)), home);
			lines.push(...wrap(theme.bold(label) + suffix, width));
			previous = group;
		}
		const adjustment = item.indexBase === 0 ? 1 : 0;
		const character = item.character === undefined ? "" : `:${item.character + adjustment}`;
		const end = item.endExclusive ? `–${item.endExclusive.line + adjustment}${item.endExclusive.character === undefined ? "" : `:${item.endExclusive.character + adjustment}`}` : "";
		lines.push(...wrapPrefixed(`L${item.line + adjustment}${character}${end}`, width, "  "));
	}
	return lines;
}
