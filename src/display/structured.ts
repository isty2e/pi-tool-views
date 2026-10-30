import type { Json } from "../presentation.ts";
import { wrapPrefixed } from "./text.ts";

export function structuredLines(value: Json, width: number, depth = 0): string[] {
	const lines: string[] = [];
	const pending: { readonly value: Json; readonly label: string; readonly depth: number }[] = [{ value, label: "", depth }];
	while (pending.length) {
		const item = pending.pop()!;
		const indent = "  ".repeat(item.depth);
		const prefix = indent + item.label;
		if (item.value === null || typeof item.value !== "object") {
			lines.push(...wrapPrefixed(JSON.stringify(item.value), width, prefix));
		} else if (Array.isArray(item.value)) {
			if (!item.value.length) lines.push(...wrapPrefixed("[]", width, prefix));
			else {
				if (item.label) lines.push(...wrapPrefixed(item.label.trimEnd(), width, indent));
				for (let index = item.value.length - 1; index >= 0; index--) pending.push({ value: item.value[index]!, label: "- ", depth: item.depth + (item.label ? 1 : 0) });
			}
		} else {
			const entries = Object.entries(item.value);
			if (!entries.length) lines.push(...wrapPrefixed("{}", width, prefix));
			else if (entries.every(([, child]) => child === null || typeof child !== "object")) {
				const fields = entries.map(([key, child]) => `${key}: ${JSON.stringify(child)}`).join(" · ");
				lines.push(...wrapPrefixed(fields, width, prefix));
			}
			else {
				if (item.label) lines.push(...wrapPrefixed(item.label.trimEnd(), width, indent));
				for (let index = entries.length - 1; index >= 0; index--) {
					const [key, child] = entries[index]!;
					pending.push({ value: child, label: `${key}: `, depth: item.depth + (item.label ? 1 : 0) });
				}
			}
		}
	}
	return lines;
}
