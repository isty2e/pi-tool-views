import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Json, JsonObject, NavigationOperation, ReportedLocation, ResultPart } from "../presentation.ts";
import { lspEnvelopeParts } from "./lsp-envelope.ts";
import { object, stringAt } from "./schema.ts";
import { exactKeys, lspPoint } from "./lsp-range.ts";
import { hoverObject } from "./hover.ts";

function location(original: Json, reported: Json): ReportedLocation | undefined {
	const raw = object(original), normalized = object(reported);
	if (!raw || !normalized || !exactKeys(raw, ["uri", "range"]) || !exactKeys(normalized, ["uri", "filePath", "range"])) return undefined;
	const uri = stringAt(raw, "uri");
	if (!uri || normalized.uri !== uri) return undefined;
	const rawRange = object(raw.range), range = object(normalized.range);
	if (!rawRange || !range || !exactKeys(rawRange, ["start", "end"]) || !exactKeys(range, ["start", "end"])) return undefined;
	const start0 = lspPoint(rawRange.start, 0), end0 = lspPoint(rawRange.end, 0);
	const start1 = lspPoint(range.start, 1), end1 = lspPoint(range.end, 1);
	if (!start0 || !end0 || !start1 || !end1 || start1.line !== start0.line + 1 || start1.character !== start0.character + 1
		|| end1.line !== end0.line + 1 || end1.character !== end0.character + 1
		|| end1.line < start1.line || (end1.line === start1.line && end1.character < start1.character)) return undefined;
	let target: ReportedLocation["target"] = { kind: "uri", uri };
	if (normalized.filePath !== undefined) {
		const path = stringAt(normalized, "filePath");
		if (!path || !isAbsolute(path)) return undefined;
		try { if (pathToFileURL(path).href !== new URL(uri).href) return undefined; } catch { return undefined; }
		target = { kind: "file", path };
	}
	return { target, line: start1.line, indexBase: 1, character: start1.character, characterUnit: "utf16", endExclusive: end1 };
}

export function navigationObject(root: JsonObject, operation: NavigationOperation): ResultPart[] | undefined {
	if (root.operation !== operation) return undefined;
	if (operation === "hover") {
		const hover = hoverObject(root);
		if (hover) return hover;
	}
	const originals = root.result, reported = root.locations;
	if (!Array.isArray(originals) || !Array.isArray(reported)) {
		return root.status === "empty" || root.status === "error" ? lspEnvelopeParts(root, new Map(), "locations") : undefined;
	}
	if (originals.length !== reported.length) return lspEnvelopeParts(root, new Map(), "locations");
	const items: ResultPart[] = [];
	let positions: ReportedLocation[] = [];
	const flush = () => { if (positions.length) items.push({ kind: "locations", items: positions }); positions = []; };
	for (let index = 0; index < originals.length; index++) {
		const original = originals[index]!, normalized = reported[index]!;
		const found = location(original, normalized);
		if (found) positions.push(found);
		else { flush(); items.push({ kind: "structured-data", value: { original, reported: normalized } }); }
	}
	flush();
	return lspEnvelopeParts(root, new Map([["result", items], ["locations", []]]), "locations");
}
