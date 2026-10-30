import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ResultPart } from "../presentation.ts";
import { sliceByColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeText, sourceLines, wrap, wrapPrefixed } from "./text.ts";

function singleCodeFence(text: string): { readonly text: string; readonly language?: string } | undefined {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const first = lines.findIndex(line => line.trim() !== "");
	if (first < 0) return undefined;
	const opening = /^ {0,3}```([A-Za-z0-9_+.-]*)\s*$/.exec(lines[first]!);
	if (!opening) return undefined;
	const closing = lines.findIndex((line, index) => index > first && /^ {0,3}```\s*$/.test(line));
	if (closing < 0 || lines.slice(closing + 1).some(line => line.trim() !== "")) return undefined;
	const language = opening[1];
	return { text: lines.slice(first + 1, closing).join("\n"), ...(language ? { language } : {}) };
}

function proseLines(part: Extract<ResultPart, { kind: "markup" }>, width: number): string[] {
	const text = safeText(part.text);
	if (/^(?: {0,3}(?:`{3,}|~{3,})| {4})/m.test(stripTerminalSequences(text))) return wrap(text, width);
	// Preserve ANSI state across hard breaks before wrapping individual prefixed lines.
	const logicalWidth = text.split("\n").reduce((max, line) => Math.max(max, visibleWidth(line)), 1);
	return wrapTextWithAnsi(text, logicalWidth).flatMap(line => {
		const plain = stripTerminalSequences(line);
		const list = part.format === "markdown" ? /^ *(?:[-+*]|\d{1,9}[.)]) +/.exec(plain)?.[0] : undefined;
		const columns = visibleWidth(list ?? /^ */.exec(plain)![0]);
		if (!columns) return wrap(line, width);
		return wrapPrefixed(sliceByColumn(line, columns, Number.MAX_SAFE_INTEGER), width, sliceByColumn(line, 0, columns));
	});
}

export function markupLines(part: Extract<ResultPart, { kind: "markup" }>, width: number, theme: Theme): string[] {
	const code = part.format === "markdown" ? singleCodeFence(part.text) : undefined;
	return code ? sourceLines(code, undefined, width, false, theme) : proseLines(part, width);
}
