import type { Json, JsonObject } from "../presentation.ts";
import { object } from "./schema.ts";

export function exactKeys(record: JsonObject, keys: readonly string[]): boolean {
	return Object.keys(record).every(key => keys.includes(key));
}

export function lspPoint(value: Json | undefined, minimum: number): { readonly line: number; readonly character: number } | undefined {
	const valueObject = object(value);
	if (!valueObject || !exactKeys(valueObject, ["line", "character"])) return undefined;
	const { line, character } = valueObject;
	if (typeof line !== "number" || !Number.isSafeInteger(line) || line < minimum || line >= Number.MAX_SAFE_INTEGER
		|| typeof character !== "number" || !Number.isSafeInteger(character) || character < minimum || character >= Number.MAX_SAFE_INTEGER) return undefined;
	return { line, character };
}

export function lspRange(value: Json | undefined): { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } } | undefined {
	const range = object(value);
	if (!range || !exactKeys(range, ["start", "end"])) return undefined;
	const start = lspPoint(range.start, 0), end = lspPoint(range.end, 0);
	if (!start || !end || end.line < start.line || (end.line === start.line && end.character < start.character)) return undefined;
	return { start, end };
}
