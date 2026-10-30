import type { Json, JsonObject, RequestedEdit, RequestedLocatedEdit } from "../presentation.ts";
import type { RequestMatch } from "./request.ts";
import { arrayItem, description, hasPhrase, hasType, object, required, schemaProperty, stringAt, type Schema } from "./schema.ts";

function anchor(value: Json | undefined): RequestedLocatedEdit["anchor"] | undefined {
	if (typeof value === "string" && /^[a-z0-9]+(?:[#:]\w+)?$/i.test(value)) {
		const line = value.match(/^(\d+)[#:]/);
		const line1 = line ? Number(line[1]) : undefined;
		if (line && (line1 === undefined || !Number.isSafeInteger(line1) || line1 < 1)) return undefined;
		return { token: value, ...(line1 !== undefined && Number.isSafeInteger(line1) && line1 > 0 ? { line1 } : {}) };
	}
	const ref = object(value);
	if (!ref || typeof ref.line !== "number" || !Number.isSafeInteger(ref.line) || ref.line < 1
		|| typeof ref.hash !== "string" || !/^[a-z0-9]+$/i.test(ref.hash)) return undefined;
	return { token: `${ref.line}#${ref.hash}`, line1: ref.line };
}

function literalValues(schema: Schema | undefined): string[] {
	if (!schema) return [];
	const values = [schema.const, ...(Array.isArray(schema.enum) ? schema.enum : [])].filter((value): value is string => typeof value === "string");
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : [];
	return [...values, ...branches.flatMap(value => literalValues(object(value)))];
}

function nestedVariantSchema(schema: Schema, variant: string): Schema | undefined {
	const item = arrayItem(schemaProperty(schema, "edits"));
	const branches = Array.isArray(item?.anyOf) ? item.anyOf.map(object).filter((value): value is Schema => value !== undefined) : item ? [item] : [];
	const matches = branches.map(branch => schemaProperty(branch, variant)).filter((value): value is Schema => value !== undefined);
	return matches.length === 1 ? matches[0] : undefined;
}

function supportedNestedVariant(variant: string, value: Schema | undefined): boolean {
	if (["set_line", "replace_lines", "insert_after"].includes(variant)) return true;
	if (!hasType(value, "object")) return false;
	if (variant === "replace") return hasType(schemaProperty(value, "old_text"), "string")
		&& hasPhrase(description(schemaProperty(value, "old_text")), "exact target text") && hasType(schemaProperty(value, "new_text"), "string");
	if (variant === "replace_symbol") return hasType(schemaProperty(value, "symbol"), "string")
		&& hasType(schemaProperty(value, "new_body"), "string") && hasPhrase(description(schemaProperty(value, "new_body")), "symbol body");
	if (variant !== "copy_lines" && variant !== "move_lines") return false;
	const start = schemaProperty(value, "start_anchor"), end = schemaProperty(value, "end_anchor"), after = schemaProperty(value, "after_anchor");
	return hasType(start, "string") && hasType(end, "string") && hasType(after, "string")
		&& hasPhrase(description(start), "first source line", "first line to move")
		&& hasPhrase(description(end), "last source line", "last line to move") && hasPhrase(description(after), "after this line");
}

function editArraySchema(schema: Schema): { readonly shape: "pos" | "anchor" | "nested"; readonly allowed: readonly string[] } | undefined {
	if (!required(schema, "path") || !hasType(schemaProperty(schema, "path"), "string")) return undefined;
	const edits = schemaProperty(schema, "edits"), item = arrayItem(edits);
	if (!item) return undefined;
	const branches = Array.isArray(item.anyOf) ? item.anyOf.map(object).filter((value): value is Schema => value !== undefined) : [item];
	const located = branches.find(branch => hasType(schemaProperty(branch, "op"), "string") && hasType(schemaProperty(branch, "pos"), "string")
		&& hasType(schemaProperty(branch, "lines"), "array") && hasPhrase(description(schemaProperty(branch, "pos")), "anchor"));
	if (located) {
		const allowed = branches.flatMap(branch => literalValues(schemaProperty(branch, "op")));
		return allowed.length ? { shape: "pos", allowed } : undefined;
	}
	if (hasType(schemaProperty(item, "op"), "string") && hasType(schemaProperty(item, "anchor"), "object")
		&& hasType(schemaProperty(item, "body"), "array") && hasPhrase(description(edits), "hashline", "anchor")) {
		const allowed = literalValues(schemaProperty(item, "op"));
		return allowed.length ? { shape: "anchor", allowed } : undefined;
	}
	const lineEdit = branches.find(branch => hasType(schemaProperty(branch, "set_line"), "object"));
	const setLine = schemaProperty(lineEdit, "set_line"), lineAnchor = schemaProperty(setLine, "anchor");
	if (lineEdit && hasType(lineAnchor, "string") && hasPhrase(description(lineAnchor), "anchor")
		&& hasType(schemaProperty(setLine, "new_text"), "string")) {
		return { shape: "nested", allowed: branches.flatMap(branch => Object.keys(object(branch.properties) ?? {})
			.filter(variant => supportedNestedVariant(variant, schemaProperty(branch, variant)))) };

	}
	return undefined;
}

function nestedAdditionalEdit(variant: string, input: JsonObject, path: string, schema: Schema | undefined): RequestedEdit | undefined {
	if (variant === "replace") {
		if (Object.keys(input).some(key => !["old_text", "new_text", "all", "fuzzy"].includes(key))
			|| typeof input.old_text !== "string" || !input.old_text || typeof input.new_text !== "string"
			|| (input.all !== undefined && (typeof input.all !== "boolean" || !hasType(schemaProperty(schema, "all"), "boolean")))
			|| (input.fuzzy !== undefined && (typeof input.fuzzy !== "boolean" || !hasType(schemaProperty(schema, "fuzzy"), "boolean")))) return undefined;
		return { kind: "match", path, oldText: input.old_text, newText: input.new_text, all: input.all === true, fuzzy: input.fuzzy === true };
	}
	if (variant === "replace_symbol") {
		if (Object.keys(input).some(key => !["symbol", "new_body"].includes(key)) || typeof input.symbol !== "string" || !input.symbol.trim()
			|| /[\r\n]/.test(input.symbol) || typeof input.new_body !== "string" || !input.new_body.trim()) return undefined;
		return { kind: "symbol", path, symbol: input.symbol, newText: input.new_body };
	}
	if (variant !== "copy_lines" && variant !== "move_lines") return undefined;
	const fromPathSchema = schemaProperty(schema, "from_path");
	if (Object.keys(input).some(key => !["start_anchor", "end_anchor", "after_anchor", "from_path"].includes(key))
		|| (input.from_path !== undefined && (typeof input.from_path !== "string" || !hasType(fromPathSchema, "string")
			|| !hasPhrase(description(fromPathSchema), variant === "copy_lines" ? "source file to copy from" : "move from this file")))) return undefined;

	const start = anchor(input.start_anchor), end = anchor(input.end_anchor), destination = anchor(input.after_anchor);
	if (!start || !end || !destination) return undefined;
	const sourcePath = typeof input.from_path === "string" && input.from_path.trim() ? input.from_path.trim() : path;
	const operation = variant === "copy_lines" ? "copy" : "move";
	return { kind: "transfer", path: operation === "move" && sourcePath !== path ? "" : path, operation,
		source: { path: sourcePath, start: start.token, end: end.token }, destination: { path, anchor: destination.token, direction: "after" } };
}

function arrayEdit(value: Json, path: string, shape: "pos" | "anchor" | "nested", schema?: Schema): RequestedEdit | undefined {
	const item = object(value);
	if (item && shape === "nested") {
		const keys = Object.keys(item);
		if (keys.length !== 1) return undefined;
		const variant = keys[0]!, input = object(item[variant]);
		if (!input) return undefined;
		if (!["set_line", "replace_lines", "insert_after"].includes(variant)) {
			if (!schema || !supportedNestedVariant(variant, schema)) return undefined;
			return nestedAdditionalEdit(variant, input, path, schema);
		}

		if (Object.keys(input).some(key => !(variant === "replace_lines"
			? ["start_anchor", "end_anchor", "new_text", "literal"]
			: variant === "insert_after" ? ["anchor", "new_text", "text", "literal"] : ["anchor", "new_text", "literal"]).includes(key))
			|| (input.literal !== undefined && typeof input.literal !== "boolean")
			|| (input.text !== undefined && typeof input.text !== "string")) return undefined;
		const position = anchor(input[variant === "replace_lines" ? "start_anchor" : "anchor"]);
		const end = variant === "replace_lines" ? anchor(input.end_anchor) : undefined;
		if (!position || (variant === "replace_lines" && !end) || typeof input.new_text !== "string") return undefined;
		const newText = variant === "insert_after" ? input.new_text || (typeof input.text === "string" ? input.text : "") : input.new_text;
		return { kind: "located", operation: variant === "insert_after" ? "insert-after" : "replace", path, anchor: position,
			...(end ? { end } : {}), newText };
	}
	if (!item || typeof item.op !== "string") return undefined;
	if (shape === "pos" && item.op === "replace_text" && typeof item.oldText === "string" && typeof item.newText === "string"
		&& Object.keys(item).every(key => ["op", "oldText", "newText"].includes(key)))
		return { path, oldText: item.oldText, newText: item.newText };
	const actions: Record<string, RequestedLocatedEdit["operation"]> = { replace: "replace", delete: "delete", append: "insert-after",
		prepend: "insert-before", insert_before: "insert-before", insert_after: "insert-after" };
	if (!Object.hasOwn(actions, item.op)) return undefined;
	const operation = actions[item.op];
	if (!operation || (shape === "pos" && !["replace", "append", "prepend"].includes(item.op))) return undefined;
	if (Object.keys(item).some(key => !["op", shape, "end", shape === "pos" ? "lines" : "body"].includes(key))) return undefined;
	if (item.end !== undefined && operation !== "replace" && operation !== "delete") return undefined;
	if (shape === "anchor" && (item.op === "append" || item.op === "prepend") && item.anchor !== undefined) return undefined;
	const rawAnchor = item[shape], position = rawAnchor === undefined && (item.op === "append" || item.op === "prepend")
		? { token: item.op === "append" ? "EOF" : "BOF" } : anchor(rawAnchor);
	const end = item.end === undefined ? undefined : anchor(item.end);
	if (!position || (item.end !== undefined && !end)) return undefined;
	const lines = item[shape === "pos" ? "lines" : "body"];
	if (operation !== "delete" && (!Array.isArray(lines) || !lines.every(line => typeof line === "string" && !/[\r\n]/.test(line)))) return undefined;
	if (operation === "delete" && lines !== undefined) return undefined;
	const target = { kind: "located" as const, path, anchor: position, ...(end ? { end } : {}) };
	return operation === "delete" ? { ...target, operation } : { ...target, operation, newLines: lines as string[] };
}

function matchDirectEdit(schema: Schema, toolDescription: string): RequestMatch | undefined {
	const first = schemaProperty(schema, "replace_from"), last = schemaProperty(schema, "replace_to");
	const match = schemaProperty(schema, "match"), replacement = schemaProperty(schema, "replacement");
	if (["replace_from", "replace_to", "match", "replacement"].every(key => required(schema, key))
		&& hasType(first, "string") && hasType(last, "string") && hasType(match, "string") && hasType(replacement, "string")
		&& hasPhrase(description(first), "first line of the range searched") && hasPhrase(description(last), "last line of the range searched")
		&& hasPhrase(description(match), "exact text to find") && hasPhrase(description(replacement), "replacement for every matched occurrence")) {
		return { family: "replacement", construct: args => {
			const value = object(args), start = value && anchor(value.replace_from), end = value && anchor(value.replace_to);
			if (!value || !start || !end || typeof value.match !== "string" || typeof value.replacement !== "string"
				|| ((required(schema, "path") || value.path !== undefined) && typeof value.path !== "string")
				|| Object.keys(value).some(key => !["path", "replace_from", "replace_to", "match", "replacement"].includes(key))) return undefined;
			const fragment = (text: string) => {
				const normalized = text.replace(/\r\n?/g, "\n");
				return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
			};

			const oldText = fragment(value.match), newText = fragment(value.replacement);
			if (!oldText || oldText.includes("\n") || oldText.includes("\0") || newText.includes("\0")) return undefined;
			return { kind: "change.replacements", requestedEdits: [{ kind: "match", path: stringAt(value, "path") ?? "", oldText, newText,
				all: true, fuzzy: false, range: { start: start.token, end: end.token } }] };
		} };
	}

	const sourceFrom = schemaProperty(schema, "source_from"), sourceTo = schemaProperty(schema, "source_to");
	const target = schemaProperty(schema, "anchor"), direction = schemaProperty(schema, "direction");
	const copy = hasPhrase(toolDescription, "duplicate a range of lines at another anchor");
	const move = hasPhrase(toolDescription, "relocate a range of lines to another anchor");
	if (copy === move || !["source_from", "source_to", "anchor", "direction"].every(key => required(schema, key))
		|| !hasType(sourceFrom, "string") || !hasType(sourceTo, "string") || !hasType(target, "string") || !hasType(direction, "string")
		|| !hasPhrase(description(sourceFrom), "first source line") || !hasPhrase(description(sourceTo), "last source line")
		|| !hasPhrase(description(target), "destination line") || !/\bafter\b[^,.;\n]*\bbelow\b/i.test(description(direction))
		|| !/\bbefore\b[^,.;\n]*\babove\b/i.test(description(direction))) return undefined;

	return { family: "replacement", construct: args => {
		const value = object(args), start = value && anchor(value.source_from), end = value && anchor(value.source_to), dest = value && anchor(value.anchor);
		if (!value || !start || !end || !dest || (value.direction !== "before" && value.direction !== "after")
			|| ((required(schema, "path") || value.path !== undefined) && typeof value.path !== "string")
			|| Object.keys(value).some(key => !["path", "source_from", "source_to", "anchor", "direction"].includes(key))) return undefined;
		const contextPath = stringAt(value, "path");
		return { kind: "change.replacements", requestedEdits: [{ kind: "transfer", path: "", operation: copy ? "copy" : "move",
			source: { start: start.token, end: end.token }, destination: { anchor: dest.token, direction: value.direction },
			...(contextPath ? { contextPath } : {}) }] };
	} };
}

export function matchLocatedEdit(schema: Schema, toolDescription: string): RequestMatch | undefined {
	const direct = matchDirectEdit(schema, toolDescription);
	if (direct) return direct;
	const match = editArraySchema(schema);

	if (match) return { family: "replacement", construct: args => {
		const value = object(args), path = value && stringAt(value, "path");
		let rawEdits: unknown = value?.edits;
		if (typeof rawEdits === "string") {
			try { rawEdits = JSON.parse(rawEdits); } catch { return undefined; }
		}
		if (!value || path === undefined || !Array.isArray(rawEdits) || rawEdits.length === 0
			|| Object.keys(value).some(key => !["path", "edits", ...(match.shape === "nested" ? ["postEditVerify"] : [])].includes(key))
			|| (value.postEditVerify !== undefined && (!hasType(schemaProperty(schema, "postEditVerify"), "boolean")
				|| typeof value.postEditVerify !== "boolean"))) return undefined;
		const edits = rawEdits.map(item => {
			const record = object(item);
			const operation = match.shape === "nested" ? record && Object.keys(record)[0] : record && stringAt(record, "op");
			return operation !== undefined && match.allowed.includes(operation) ? arrayEdit(item, path, match.shape, nestedVariantSchema(schema, operation)) : undefined;
		});
		if (edits.some(edit => edit === undefined)) return undefined;
		return { kind: "change.replacements", requestedEdits: edits as RequestedEdit[] };
	} };
	const insertion = schemaProperty(schema, "anchor"), direction = schemaProperty(schema, "direction"), insertionText = schemaProperty(schema, "text");
	if (required(schema, "anchor") && required(schema, "direction") && required(schema, "text")
		&& hasType(insertion, "string") && hasPhrase(description(insertion), "anchor") && hasType(direction, "string")
		&& hasType(insertionText, "string") && hasPhrase(description(insertionText), "empty string inserts one blank line")) {
		return { family: "replacement", construct: args => {
			const value = object(args), position = value && anchor(value.anchor);
			if (!value || !position || (value.direction !== "before" && value.direction !== "after") || typeof value.text !== "string"
				|| (value.path !== undefined && typeof value.path !== "string")
				|| Object.keys(value).some(key => !["path", "anchor", "direction", "text"].includes(key))) return undefined;
			return { kind: "change.replacements", requestedEdits: [{ kind: "located",
				operation: value.direction === "before" ? "insert-before" : "insert-after", path: stringAt(value, "path") ?? "",
				anchor: position, ...(value.text === "" ? { newLines: [""] } : { newText: value.text }) }] };
		} };
	}
	const from = schemaProperty(schema, "remove_from"), to = schemaProperty(schema, "remove_to"), text = schemaProperty(schema, "text");
	if (!required(schema, "remove_from") || !required(schema, "remove_to") || !required(schema, "text")
		|| !hasType(from, "string") || !hasType(to, "string") || !hasType(text, "string")
		|| !hasPhrase(description(from), "anchor") || !hasPhrase(description(to), "anchor")
		|| !hasPhrase(description(text), "write in place of the removed range")) return undefined;
	return { family: "replacement", construct: args => {
		const value = object(args), first = value && anchor(value.remove_from), last = value && anchor(value.remove_to);
		if (!value || !first || !last || typeof value.text !== "string" || (value.path !== undefined && typeof value.path !== "string")
			|| Object.keys(value).some(key => !["path", "remove_from", "remove_to", "text"].includes(key))) return undefined;
		return { kind: "change.replacements", requestedEdits: [{ kind: "located", operation: "replace", path: stringAt(value, "path") ?? "",
			anchor: first, end: last, newText: value.text }] };
	} };
}
