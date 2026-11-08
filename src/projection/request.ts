import type {
	AstConstraints,
	AstSelector,
	ApplyIntent,
	CodeRequest,
	EffectiveDeclaration,
	FileChangeRequest,
	ImageRequest,
	Json,
	PositionRequest,
	ProgramRequest,
	RequestView,
	RequestedReplacement,
	SearchRequest,
	SearchScope,
	ShellRequest,
	SourceRequest,
	WebAction,
	WebRequest,
} from "../presentation.ts";
import { matchLocatedEdit } from "./located-edit.ts";
import { normalizeFileContext } from "./file-context.ts";
import {
	arrayItem,
	booleanAt,
	description,
	enumValues,
	hasPhrase,
	hasType,
	isJson,
	numberAt,
	object,
	onlyType,
	propertyEntries,
	required,
	schemaProperty,
	stringAt,
	type Schema,
	uniqueProperty,
} from "./schema.ts";

export type ResultFamily =
	| "original"
	| "source"
	| "replacement"
	| "patch"
	| "shell"
	| "program"
	| "search"
	| "search-text"
	| "code"
	| "web"
	| "web-fetch"
	| "image";

export interface RequestMatch {
	readonly family: ResultFamily;
	readonly construct: (args: Json) => RequestView | undefined;
}

type Fields = Readonly<Record<string, string | undefined>>;
type Args = import("../presentation.ts").JsonObject;

function argsObject(args: Json): Args | undefined {
	return object(args);
}

function propertyByKey(schema: Schema, key: string, type: string): boolean {
	const property = schemaProperty(schema, key);
	return property !== undefined && hasType(property, type);
}

function stringValue(args: Args, fields: Fields, role: string): string | undefined {
	const key = fields[role];
	return key ? stringAt(args, key) : undefined;
}

function copyString(
	result: Record<string, unknown>,
	args: Args,
	fields: Fields,
	role: string,
	output: string = role,
): boolean {
	const value = stringValue(args, fields, role);
	if (value === undefined) return false;
	result[output] = value;
	return true;
}

function copyNumber(
	result: Record<string, unknown>,
	args: Args,
	fields: Fields,
	role: string,
	output: string = role,
): void {
	const key = fields[role];
	if (!key) return;
	const value = numberAt(args, key);
	if (value !== undefined) result[output] = value;
}

function copyBoolean(
	result: Record<string, unknown>,
	args: Args,
	fields: Fields,
	role: string,
	output: string = role,
): void {
	const key = fields[role];
	if (!key) return;
	const value = booleanAt(args, key);
	if (value !== undefined) result[output] = value;
}

function reconstructArray<T extends Json>(
	raw: Json | undefined,
	itemSchema: Schema,
	accepts: (value: Json, schema: Schema) => value is T,
): readonly T[] | undefined {
	if (raw === undefined) return undefined;
	const candidates: (readonly T[])[] = [];
	const fromCandidate = (candidate: Json): readonly T[] | undefined => {
		if (Array.isArray(candidate)) {
			return candidate.every((item) => accepts(item, itemSchema))
				? candidate as readonly T[]
				: undefined;
		}
		return accepts(candidate, itemSchema) ? [candidate] : undefined;
	};

	const direct = fromCandidate(raw);
	if (direct) candidates.push(direct);
	if (typeof raw !== "string") return direct;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isJson(parsed)) {
			const decoded = fromCandidate(parsed);
			if (decoded) candidates.push(decoded);
		}
	} catch {
		// A valid raw singleton can still be used when the string is not JSON.
	}
	if (candidates.length === 0) return undefined;
	const first = JSON.stringify(candidates[0]);
	return candidates.every((candidate) => JSON.stringify(candidate) === first) ? candidates[0] : undefined;
}

function declaredArray<T extends Json>(
	args: Args,
	fields: Fields,
	role: string,
	arraySchema: Schema | undefined,
	accepts: (value: Json, schema: Schema) => value is T,
): readonly T[] | undefined {
	const key = fields[role];
	if (!key || !arraySchema || !onlyType(arraySchema, "array")) return undefined;
	const itemSchema = arrayItem(arraySchema);
	if (!itemSchema || !(key in args)) return undefined;
	const raw = args[key];
	return reconstructArray(raw, itemSchema, accepts);
}

function numberRole(property: Schema, marker: string): boolean {
	return hasType(property, "number") && description(property).toLowerCase().includes(marker);
}

function selectRole(
	schema: Schema,
	role: string,
	predicate: (key: string, property: Schema) => boolean,
	preferredKeys: readonly string[] = [],
): string | undefined {
	const explicit = preferredKeys.filter((key) => {
		const property = schemaProperty(schema, key);
		return property !== undefined && predicate(key, property);
	});
	if (explicit.length === 1) return explicit[0];
	if (explicit.length > 1) return undefined;

	const matches = propertyEntries(schema).filter(([key, property]) => predicate(key, property));
	const selected = matches[0];
	return matches.length === 1 && selected !== undefined ? selected[0] : undefined;
}

function byKeyAndType(schema: Schema, keys: readonly string[], type: string): string | undefined {
	const matches = keys.filter((key) => propertyByKey(schema, key, type));
	return matches.length === 1 ? matches[0] : undefined;
}

function hasObjectSchema(schema: Schema | undefined): boolean {
	return schema?.type === "object" || schema?.properties !== undefined;
}

function isObjectElement(value: Json, itemSchema: Schema): value is import("../presentation.ts").JsonObject {
	const candidate = object(value);
	if (!candidate || !hasObjectSchema(itemSchema)) return false;
	const props = itemSchema.properties;
	const requiredProps = itemSchema.required;
	if (Array.isArray(requiredProps)) {
		for (const key of requiredProps) {
			if (typeof key !== "string" || !(key in candidate)) return false;
			const property = object(props)?.[key];
			const itemValue = candidate[key];
			if (!property || itemValue === undefined || !valueConforms(itemValue, object(property))) return false;
		}
	}
	return true;
}

function valueConforms(value: Json, schema: Schema | undefined): boolean {
	if (!schema) return true;
	if (schema.type === "string") return typeof value === "string";
	if (schema.type === "number" || schema.type === "integer") {
		return typeof value === "number" && Number.isFinite(value)
			&& (schema.type !== "integer" || Number.isInteger(value));
	}
	if (schema.type === "boolean") return typeof value === "boolean";
	if (schema.type === "array") {
		const item = object(schema.items);
		return Array.isArray(value) && (item === undefined || value.every((entry) => valueConforms(entry, item)));
	}
	if (schema.type === "object") return object(value) !== undefined;
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (Array.isArray(branches)) {
			return branches.some((branch) => valueConforms(value, object(branch)));
		}
	}
	return true;
}

function isRfc3339Utc(value: string): boolean {
	const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z$/.exec(value);
	if (!match) return false;
	const [, year, month, day, hour, minute, second] = match;
	if (!year || !month || !day || !hour || !minute || !second) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		&& date.getUTCFullYear() === Number(year)
		&& date.getUTCMonth() + 1 === Number(month)
		&& date.getUTCDate() === Number(day)
		&& date.getUTCHours() === Number(hour)
		&& date.getUTCMinutes() === Number(minute)
		&& date.getUTCSeconds() === Number(second);
}

function scalarOrArray<T extends Json>(
	args: Args,
	key: string,
	property: Schema,
	acceptsElement: (value: Json, schema: Schema) => value is T,
): { readonly kind: "none" } | { readonly kind: "invalid" } | { readonly kind: "value"; readonly values: readonly T[] } {
	if (!(key in args)) return { kind: "none" };
	if (args[key] === null && hasType(property, "null")) return { kind: "none" };
	const raw = args[key];
	if (typeof raw === "string" && hasType(property, "string")) return { kind: "value", values: [raw as T] };
	const arraySchema = arraySchemaAlternative(property);
	const item = arraySchema ? arrayItem(arraySchema) : undefined;
	if (!Array.isArray(raw) || !item || !raw.every((entry) => acceptsElement(entry, item))) return { kind: "invalid" };
	return { kind: "value", values: raw as readonly T[] };
}

function arraySchemaAlternative(schema: Schema): Schema | undefined {
	if (schema.type === "array") return schema;
	if (Array.isArray(schema.type) && schema.type.includes("array")
		&& schema.type.every((type) => type === "array" || type === "null")) {
		return { ...schema, type: "array" };
	}
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		const arrays = branches.map(object).filter((branch): branch is Schema => branch?.type === "array");
		if (arrays.length === 1) return arrays[0];
	}
	return undefined;
}

function arraySchemaBranch(schema: Schema): Schema | undefined {
	const array = arraySchemaAlternative(schema);
	if (!array) return undefined;
	if (schema.type === "array") return array;
	if (Array.isArray(schema.type)) {
		return schema.type.every((type) => type === "array" || type === "null") ? array : undefined;
	}
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		const otherAllowed = branches.some((branch) => {
			const shape = object(branch);
			return shape?.type !== "array" && shape?.type !== "null";
		});
		if (!otherAllowed) return array;
	}
	return undefined;
}

function matchRead(declaration: EffectiveDeclaration, schema: Schema): RequestMatch | undefined {
	const path = selectRole(schema, "path", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "path to the file to read"), ["path"]);
	const offset = selectRole(schema, "offset", (_key, property) => numberRole(property, "line number to start"), ["offset"]);
	const limit = selectRole(schema, "limit", (_key, property) => numberRole(property, "number of lines"), ["limit"]);
	if (!path || !required(schema, path)) return undefined;
	const raw = uniqueProperty(schema, (_key, field) => hasType(field, "boolean")
		&& hasPhrase(description(field), "plain text without line#hash"))?.[0];
	const lineEncoding = hasPhrase(declaration.description, "line#hash") ? "number-hash"
		: hasPhrase(declaration.description, "anchor│content") && hasPhrase(declaration.description, "5-character lowercase anchor") ? "anchor" : undefined;

	return {
		family: "source",
		construct: (args) => {
			const values = argsObject(args);
			const target = values && stringAt(values, path);
			if (!values || target === undefined) return undefined;
			if (raw && values[raw] !== undefined && typeof values[raw] !== "boolean") return undefined;
			const request: Extract<SourceRequest, { kind: "source.lines" }> = { kind: "source.lines", path: target,
				...(lineEncoding ? { lineEncoding: raw && values[raw] === true ? "plain" : lineEncoding } : {}) };
			const firstLine1 = offset ? numberAt(values, offset) : undefined;
			const lineLimit = limit ? numberAt(values, limit) : undefined;
			return {
				...request,
				...(firstLine1 === undefined ? {} : { firstLine1 }),
				...(lineLimit === undefined ? {} : { lineLimit }),
			};
		},
	};
}

function matchWrite(schema: Schema): RequestMatch | undefined {
	const path = selectRole(schema, "path", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "path to the file to write"), ["path"]);
	const content = selectRole(schema, "content", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "content to write to the file"), ["content"]);
	if (!path || !content || !required(schema, path) || !required(schema, content)) return undefined;

	return {
		family: "original",
		construct: (args) => {
			const values = argsObject(args);
			const target = values && stringAt(values, path);
			const body = values && stringAt(values, content);
			return target === undefined || body === undefined ? undefined : { kind: "change.write", path: target, content: body };
		},
	};
}

function replacementArraySchema(schema: Schema, key: string): Schema | undefined {
	const field = schemaProperty(schema, key);
	const item = arrayItem(field);
	if (!field || !item || !hasObjectSchema(item)) return undefined;
	const oldText = schemaProperty(item, "oldText");
	const newText = schemaProperty(item, "newText");
	if (!oldText || !newText || !hasType(oldText, "string") || !hasType(newText, "string")) return undefined;
	if (!required(item, "oldText") || !required(item, "newText")) return undefined;
	return field;
}

function replacementElement(value: Json, itemSchema: Schema): value is import("../presentation.ts").JsonObject {
	if (!isObjectElement(value, itemSchema)) return false;
	return typeof value.oldText === "string" && typeof value.newText === "string";
}

function replacementEdit(
	item: import("../presentation.ts").JsonObject,
	itemSchema: Schema,
	rootPath: string | undefined,

): RequestedReplacement {
	const itemPath = propertyByKey(itemSchema, "path", "string") ? stringAt(item, "path") : undefined;
	const fileContext = normalizeFileContext(itemSchema, item);
	return {
		path: itemPath !== undefined ? itemPath : rootPath ?? "",
		oldText: stringAt(item, "oldText") ?? "",
		newText: stringAt(item, "newText") ?? "",
		...(fileContext ? { fileContext } : {}),
	};
}

function matchReplacements(schema: Schema): RequestMatch | undefined {
	const candidates = propertyEntries(schema).filter(([key]) => replacementArraySchema(schema, key) !== undefined);
	if (candidates.length !== 1) return undefined;
	const selected = candidates[0];
	if (!selected) return undefined;
	const [editsKey, editsSchema] = selected;
	if (!hasPhrase(description(editsSchema), "replacement", "edit") && editsKey !== "edits") return undefined;
	const pathSchema = schemaProperty(schema, "path");
	if (!pathSchema || !hasType(pathSchema, "string")) return undefined;
	if (!required(schema, "path") || !required(schema, editsKey)) return undefined;
	const itemSchema = arrayItem(editsSchema);
	if (!itemSchema) return undefined;

	return {
		family: "replacement",
		construct: (args) => {
			const values = argsObject(args);
			const path = values && stringAt(values, "path");
			if (!values || path === undefined) return undefined;
			const edits = declaredArray(values, { edits: editsKey }, "edits", editsSchema, replacementElement);
			const requestedEdits = edits?.map((edit) => replacementEdit(edit, itemSchema, path)) ?? [];
			if (typeof values.oldText === "string" && typeof values.newText === "string") {
				requestedEdits.push(replacementEdit(values, itemSchema, path));
			}
			return edits || requestedEdits.length ? { kind: "change.replacements", requestedEdits } : undefined;
		},
	};
}

function patchField(schema: Schema): readonly [string, Schema] | undefined {
	if (schemaProperty(schema, "oldText") || schemaProperty(schema, "newText") || schemaProperty(schema, "multi")) return undefined;
	const candidates = propertyEntries(schema).filter(([key, property]) => {
		if (!hasType(property, "string")) return false;
		const descriptionText = description(property);
		return hasPhrase(descriptionText, "patch text", "patch payload", "codex-style patch", "codex apply_patch text", "apply_patch text", "*** begin patch", "*** end patch")
			|| (key.toLowerCase() === "patch" && propertyEntries(schema).length === 1);
	});
	return candidates.length === 1 ? candidates[0] : undefined;
}

function matchPatch(schema: Schema): RequestMatch | undefined {
	const selected = patchField(schema);
	if (!selected) return undefined;
	const [key, field] = selected;
	if (!required(schema, key)) return undefined;
	const format: "codex" | "unconfirmed" = hasPhrase(description(field), "codex", "*** begin patch", "apply_patch text")
		? "codex"
		: "unconfirmed";

	return {
		family: "patch",
		construct: (args) => {
			const values = argsObject(args);
			const text = values && stringAt(values, key);
			return text === undefined ? undefined : { kind: "change.patch", text, format };
		},
	};
}

function matchMitsupiEdit(schema: Schema): RequestMatch | undefined {
	const patch = schemaProperty(schema, "patch");
	const topPath = schemaProperty(schema, "path");
	const oldText = schemaProperty(schema, "oldText");
	const newText = schemaProperty(schema, "newText");
	const multi = replacementArraySchema(schema, "multi");
	if (!patch || !topPath || !oldText || !newText || !multi) return undefined;
	if (!hasType(patch, "string") || !hasType(topPath, "string") || !hasType(oldText, "string") || !hasType(newText, "string")) return undefined;
	if (!hasPhrase(description(patch), "codex-style", "codex-style apply_patch", "codex-style patch")) return undefined;
	const item = arrayItem(multi);
	if (!item || !schemaProperty(item, "path") || !required(item, "oldText") || !required(item, "newText")) return undefined;

	return {
		family: "replacement",
		construct: (args) => {
			const values = argsObject(args);
			if (!values) return undefined;
			const hasPatch = "patch" in values;
			const hasClassicFacts = "oldText" in values || "newText" in values || "multi" in values;
			if (hasPatch) {
				if (hasClassicFacts) return undefined;
				const text = stringAt(values, "patch");
				return text === undefined ? undefined : { kind: "change.patch", text, format: "codex" };
			}

			const rootPath = stringAt(values, "path");
			const hasOld = "oldText" in values;
			const hasNew = "newText" in values;
			if (hasOld !== hasNew) return undefined;
			const edits: RequestedReplacement[] = [];
			if (hasOld && hasNew) {
				if (typeof values.oldText !== "string" || typeof values.newText !== "string" || rootPath === undefined) return undefined;
				edits.push(replacementEdit(values, item, rootPath));
			}
			if ("multi" in values) {
				const multiValues = declaredArray(values, { edits: "multi" }, "edits", multi, replacementElement);
				if (!multiValues) return undefined;
				for (const entry of multiValues) {
					const path = "path" in entry ? stringAt(entry, "path") : undefined;
					if ("path" in entry && path === undefined) return undefined;
					const inherited = path === undefined ? rootPath : path;
					if (inherited === undefined || inherited === "") return undefined;
					edits.push(replacementEdit(entry, item, inherited));
				}
			}
			return edits.length > 0 ? { kind: "change.replacements", requestedEdits: edits } : undefined;
		},
	};
}

function matchShellLaunch(schema: Schema): RequestMatch | undefined {
	const command = selectRole(schema, "command", (key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "shell command", "shell script to run", "command to execute", "command to run"), ["command", "cmd"]);
	if (!command) return undefined;
	const commandDescription = description(schemaProperty(schema, command));
	if (!hasPhrase(commandDescription, "shell", "command to execute", "command to run")) return undefined;
	const fields: Record<string, string> = { command };
	const workdir = selectRole(schema, "cwd", (key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "working directory", "cwd"), ["workdir", "cwd"]);
	const shell = byKeyAndType(schema, ["shell"], "string");
	const login = byKeyAndType(schema, ["login"], "boolean");
	const pty = byKeyAndType(schema, ["tty", "pty"], "boolean");
	const wait = selectRole(schema, "wait", (key, property) => hasType(property, "number")
		&& hasPhrase(description(property), "wait", "attachment window", "yield"), ["yield_time_ms"]);
	const timeoutSeconds = selectRole(schema, "timeoutSeconds", (_key, property) => hasType(property, "number")
		&& /\btimeout\b[^.]*\bseconds?\b/i.test(description(property)), ["timeout"]);
	const timeoutMilliseconds = selectRole(schema, "timeoutMilliseconds", (key, property) => hasType(property, "number")
		&& (key === "timeout_ms" || (hasPhrase(description(property), "timeout", "runtime")
			&& hasPhrase(description(property), "milliseconds"))), ["timeout_ms"]);
	if (timeoutSeconds && timeoutMilliseconds) return undefined;
	if (workdir) fields.cwd = workdir;
	if (shell) fields.shell = shell;
	if (login) fields.login = login;
	if (pty) fields.pty = pty;
	if (wait) fields.wait = wait;
	if (timeoutSeconds) fields.timeoutSeconds = timeoutSeconds;
	if (timeoutMilliseconds) fields.timeoutMilliseconds = timeoutMilliseconds;

	return {
		family: "shell",
		construct: (args) => {
			const values = argsObject(args);
			if (!values || !required(schema, command) || !stringAt(values, command)) return undefined;
			const result: Record<string, unknown> = { kind: "shell.launch", command: values[command] };
			copyString(result, values, fields, "cwd");
			copyString(result, values, fields, "shell");
			copyBoolean(result, values, fields, "login");
			copyBoolean(result, values, fields, "pty");
			const timeoutKey = fields.timeoutMilliseconds ?? fields.timeoutSeconds;
			const timeout = timeoutKey ? numberAt(values, timeoutKey) : undefined;
			if (timeout !== undefined) result.processTimeoutMs = fields.timeoutSeconds ? timeout * 1000 : timeout;
			const waitMs = fields.wait ? numberAt(values, fields.wait) : undefined;
			if (waitMs !== undefined) result.wait = { milliseconds: waitMs };
			return result as unknown as ShellRequest;
		},
	};
}

function matchStdin(schema: Schema): RequestMatch | undefined {
	const sessionId = selectRole(schema, "sessionId", (key, property) => hasType(property, "number")
		&& (hasPhrase(description(property), "session") || key === "session_id" || key === "sessionId"), ["session_id", "sessionId"]);
	if (!sessionId || !required(schema, sessionId)) return undefined;
	const raw = selectRole(schema, "chars", (key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "stdin", "input"), ["chars"]);
	const base64 = selectRole(schema, "base64", (key, property) => hasType(property, "string")
		&& (key === "chars_b64" || hasPhrase(description(property), "base64")), ["chars_b64"]);
	if (!raw && !base64) return undefined;
	const wait = selectRole(schema, "wait", (key, property) => hasType(property, "number")
		&& hasPhrase(description(property), "wait", "attachment window", "yield"), ["yield_time_ms"]);
	const absoluteWait = selectRole(schema, "untilUtc", (key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "absolute utc deadline", "rfc 3339 utc"), ["yield_until"]);
	const fields: Record<string, string> = { sessionId };
	if (raw) fields.raw = raw;
	if (base64) fields.base64 = base64;
	if (wait) fields.wait = wait;
	if (absoluteWait) fields.untilUtc = absoluteWait;
	const rawDescription = raw ? description(schemaProperty(schema, raw)).toLowerCase() : "";
	const rawEncoding: "utf8" | "c-escaped-utf8" = hasPhrase(rawDescription, "c-style escapes", "c-escaped")
		? "c-escaped-utf8"
		: "utf8";

	return {
		family: "shell",
		construct: (args) => {
			const values = argsObject(args);
			const id = values && numberAt(values, sessionId);
			if (!values || id === undefined) return undefined;
			const rawText = raw ? stringAt(values, raw) : undefined;
			const encoded = base64 ? stringAt(values, base64) : undefined;
			if ((rawText !== undefined && rawText !== "") && (encoded !== undefined && encoded.trim() !== "")) return undefined;
			const waitMs = wait ? numberAt(values, wait) : undefined;
			const utc = absoluteWait ? stringAt(values, absoluteWait) : undefined;
			if (utc !== undefined && (waitMs !== undefined || (rawText !== undefined && rawText !== "") || (encoded !== undefined && encoded.trim() !== ""))) return undefined;
			if (utc !== undefined && !isRfc3339Utc(utc)) return undefined;
			const encodedHasData = encoded !== undefined && encoded.trim() !== "";
			const rawHasData = rawText !== undefined && rawText !== "";
			if (!rawHasData && !encodedHasData) {
				return {
					kind: "session.poll",
					sessionId: id,
					...(utc !== undefined ? { wait: { untilUtc: utc } } : waitMs !== undefined ? { wait: { milliseconds: waitMs } } : {}),
				};
			}
			const input = encodedHasData
				? { encoding: "base64" as const, text: encoded! }
				: { encoding: rawEncoding, text: rawText! };
			return {
				kind: "session.send",
				sessionId: id,
				input,
				...(waitMs !== undefined ? { wait: { milliseconds: waitMs } } : {}),
			};
		},
	};
}

function declaresProgramRun(declaration: EffectiveDeclaration): boolean {
	const introduction = declaration.description.split(/\n|(?<=[.!?])\s/, 1)[0] ?? "";
	const execution = /\b(?:runs?|executes?|evaluates?)\s+(?:(?:raw|arbitrary|a)\s+)?(?:javascript|typescript|code|scripts?)\b/i.exec(introduction);
	return execution !== null && !/\b(?:not|never|don't)\s+$/i.test(introduction.slice(0, execution.index));
}

function matchProgram(declaration: EffectiveDeclaration, schema: Schema): RequestMatch | undefined {
	if (!declaresProgramRun(declaration)) return undefined;
	const code = schemaProperty(schema, "code");
	if (!code || !hasType(code, "string") || !required(schema, "code")) return undefined;
	const codeDescription = description(code).toLowerCase();
	const isTypeScript = hasPhrase(codeDescription, "typescript code", "typescript source", "typeScript code");
	const isJavaScript = hasPhrase(codeDescription, "javascript source", "javascript code");
	if (isTypeScript === isJavaScript) return undefined;
	const stringsSchema = schemaProperty(schema, "strings");
	if (isTypeScript && (!stringsSchema || !hasObjectSchema(stringsSchema))) return undefined;
	if (isJavaScript && stringsSchema) return undefined;

	return {
		family: "program",
		construct: (args) => {
			const values = argsObject(args);
			const source = values && stringAt(values, "code");
			if (!values || source === undefined) return undefined;
			if (isJavaScript) return { kind: "program.javascript", source };
			const bindings = object(values.strings);
			if (values.strings !== undefined && (!bindings || !Object.values(bindings).every((item) => typeof item === "string"))) return undefined;
			return {
				kind: "program.typescript",
				source,
				...(bindings ? { strings: Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, value as string])) } : {}),
			};
		},
	};
}

function matchFreeform(declaration: EffectiveDeclaration): RequestMatch | undefined {
	if (declaration.input.kind !== "freeform") return undefined;
	if (!declaresProgramRun(declaration)) return undefined;
	if (!hasPhrase(declaration.description, "javascript") || hasPhrase(declaration.description, "typescript")) return undefined;
	const grammar = declaration.input.grammar;
	if (!grammar || grammar.syntax.toLowerCase() !== "lark") return undefined;
	const definition = grammar.definition;
	if (!hasPhrase(definition, "options_source") || !hasPhrase(definition, "plain_source")
		|| !hasPhrase(definition, "source") || !hasPhrase(definition, "@options", "options_line")) return undefined;
	return {
		family: "program",
		construct: (args) => typeof args === "string" ? { kind: "program.javascript", source: args } : undefined,
	};
}

function matchSourceByDescription(schema: Schema): RequestMatch | undefined {
	const path = selectRole(schema, "path", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "path to the source", "source file", "source code file"), ["path"]);
	if (!path) return undefined;
	const symbol = selectRole(schema, "symbol", (key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "symbol name", "exact symbol name"), ["symbol"]);
	const symbolKind = selectRole(schema, "symbolKind", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "kind filter", "filter by kind"), ["kind"]);
	const line = selectRole(schema, "line", (key, property) => hasType(property, "number")
		&& hasPhrase(description(property), "1-based line number", "line number inside"), ["line"]);
	const maxLines = selectRole(schema, "maxLines", (key, property) => hasType(property, "number")
		&& hasPhrase(description(property), "maximum lines", "maximum body size"), ["maxLines"]);
	if (symbol && !line && required(schema, path) && required(schema, symbol)) {
		return {
			family: "source",
			construct: (args) => {
				const values = argsObject(args);
				const target = values && stringAt(values, path);
				const name = values && stringAt(values, symbol);
				const kindFilter = values && symbolKind ? stringAt(values, symbolKind) : undefined;
				return target === undefined || name === undefined ? undefined : { kind: "source.symbol", path: target, symbol: name,
					...(kindFilter === undefined ? {} : { kindFilter }) };
			},
		};
	}
	if (line && maxLines && required(schema, path) && required(schema, line)) {
		return {
			family: "source",
			construct: (args) => {
				const values = argsObject(args);
				const target = values && stringAt(values, path);
				const line1 = values && numberAt(values, line);
				const maximum = values && numberAt(values, maxLines);
				return target === undefined || line1 === undefined ? undefined : {
					kind: "source.enclosing", path: target, line1,
					...(maximum === undefined ? {} : { maxLines: maximum }),
				};
			},
		};
	}
	return undefined;
}

function matchSearch(schema: Schema): RequestMatch | undefined {
	const pattern = selectRole(schema, "query", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "search pattern", "pattern to search", "fuzzy filename search", "glob pattern"), ["pattern"]);
	const patternProperty = pattern ? schemaProperty(schema, pattern) : undefined;
	const pathProperty = uniqueProperty(schema, (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "path constraint", "full repo-relative path", "directory or file to search", "directory to search", "directory to list"));
	const fff = Boolean(patternProperty && hasPhrase(description(patternProperty), "fuzzy filename search"));
	const globPattern = Boolean(patternProperty && !fff && hasPhrase(description(patternProperty), "glob pattern"));
	const grepPattern = Boolean(patternProperty && hasPhrase(description(patternProperty), "search pattern", "pattern to search"));
	const excludeKey = selectRole(schema, "exclude", (key, property) => hasType(property, "string") || hasType(property, "array")
		? hasPhrase(description(property), "exclude paths", "exclude")
		: false, ["exclude"]);
	const pathExpression = pathProperty && hasPhrase(description(pathProperty[1]), "path constraint", "full repo-relative path") ? pathProperty[0] : undefined;
	const rootPath = pathProperty && hasPhrase(description(pathProperty[1]), "directory or file to search", "directory to search") ? pathProperty[0] : undefined;

	if (pattern && fff && pathExpression) {
		const fields: Record<string, string> = { query: pattern, path: pathExpression };
		const limit = byKeyAndType(schema, ["limit"], "number");
		const cursor = byKeyAndType(schema, ["cursor"], "string");
		if (excludeKey) fields.exclude = excludeKey;
		if (limit) fields.limit = limit;
		if (cursor) fields.cursor = cursor;
		const excludeSchema = excludeKey ? schemaProperty(schema, excludeKey) : undefined;
		return {
			family: "search",
			construct: (args) => {
				const values = argsObject(args);
				const query = values && stringAt(values, pattern);
				if (!values || query === undefined) return undefined;
				const scope: SearchScope = {};
				const pathValue = stringAt(values, pathExpression);
				if (pathValue !== undefined) Object.assign(scope, { pathExpression: pathValue });
				if (excludeKey && excludeSchema && excludeKey in values) {
					const raw = values[excludeKey];
					if (typeof raw === "string") Object.assign(scope, { exclude: { kind: "text", text: raw } });
					else if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
						Object.assign(scope, { exclude: { kind: "list", entries: raw as readonly string[] } });
					} else return undefined;
				}
			return {
					kind: "search.files",
					query,
					dialect: "fuzzy-glob",
					scope,
					...(limit && numberAt(values, limit) !== undefined ? { limit: numberAt(values, limit)! } : {}),
					...(cursor && stringAt(values, cursor) !== undefined ? { cursor: stringAt(values, cursor)! } : {}),
				};
			},
		};
	}
	if (pattern && globPattern && rootPath && !schemaProperty(schema, "literal")) {
		const fields = { query: pattern, root: rootPath };
		const limit = byKeyAndType(schema, ["limit"], "number");
		return {
			family: "search",
			construct: (args) => {
				const values = argsObject(args);
				const query = values && stringAt(values, pattern);
				if (!values || query === undefined) return undefined;
				const root = stringAt(values, rootPath);
				const max = limit ? numberAt(values, limit) : undefined;
				return {
					kind: "search.files", query, dialect: "glob",
					scope: { ...(root === undefined ? {} : { root }) },
					...(max === undefined ? {} : { limit: max }),
				};
			},
		};
	}
	if (pattern && grepPattern) {
		const pathRole = pathExpression ? "pathExpression" : rootPath ? "root" : undefined;
		const literalKey = byKeyAndType(schema, ["literal"], "boolean");
		const ignoreKey = byKeyAndType(schema, ["ignoreCase"], "boolean");
		const smartCaseKey = byKeyAndType(schema, ["caseSensitive"], "boolean");
		const caseModeSchema = schemaProperty(schema, "caseMode");
		const caseModeValues = enumValues(caseModeSchema);
		const recognizedCaseModes = ["sensitive", "insensitive", "smart"];
		const caseModeKey = caseModeSchema && hasType(caseModeSchema, "string")
			&& caseModeValues?.length && caseModeValues.every((value) => typeof value === "string" && recognizedCaseModes.includes(value))
			? "caseMode"
			: undefined;
		const caseModeConflict = (caseModeSchema && !caseModeKey) || (ignoreKey && smartCaseKey)
			|| (caseModeKey && (ignoreKey || smartCaseKey));
		const context = byKeyAndType(schema, ["context"], "number");
		const limit = byKeyAndType(schema, ["limit"], "number");
		const cursor = byKeyAndType(schema, ["cursor"], "string");
		const includeGlob = byKeyAndType(schema, ["glob"], "string");
		const hasSearchDialect = Boolean(literalKey || smartCaseKey || ignoreKey || caseModeKey);
		if (!caseModeConflict && hasSearchDialect && (rootPath || pathExpression)) {
			return {
				family: "search-text",
				construct: (args) => {
					const values = argsObject(args);
					const query = values && stringAt(values, pattern);
					if (!values || query === undefined) return undefined;
					let dialect: "regex" | "literal" | "auto" = "auto";
					let caseMode: "sensitive" | "insensitive" | "smart" = "smart";
					if (literalKey) dialect = booleanAt(values, literalKey) === true ? "literal" : "regex";
					if (caseModeKey) {
						const declaredDefault = caseModeSchema?.default;
						const mode = stringAt(values, caseModeKey) ?? (typeof declaredDefault === "string" ? declaredDefault : undefined);
						if (mode === "sensitive" || mode === "insensitive" || mode === "smart") caseMode = mode;
						else return undefined;
					}
					if (ignoreKey) caseMode = booleanAt(values, ignoreKey) === true ? "insensitive" : "sensitive";
					if (smartCaseKey) caseMode = booleanAt(values, smartCaseKey) === true ? "sensitive" : "smart";
					const scope: SearchScope = {};
					if (pathRole === "root" && rootPath && stringAt(values, rootPath) !== undefined) Object.assign(scope, { root: stringAt(values, rootPath) });
					if (pathRole === "pathExpression" && pathExpression && stringAt(values, pathExpression) !== undefined) Object.assign(scope, { pathExpression: stringAt(values, pathExpression) });
					if (includeGlob && stringAt(values, includeGlob) !== undefined) Object.assign(scope, { includeGlob: stringAt(values, includeGlob) });
					if (excludeKey && values && excludeKey in values) {
						const raw = values[excludeKey];
						if (typeof raw === "string") Object.assign(scope, { exclude: { kind: "text", text: raw } });
						else if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) Object.assign(scope, { exclude: { kind: "list", entries: raw as readonly string[] } });
						else return undefined;
					}
					return {
						kind: "search.text", query, dialect, caseMode, scope,
						...(context && numberAt(values, context) !== undefined ? { contextLines: numberAt(values, context)! } : {}),
						...(limit && numberAt(values, limit) !== undefined ? { limit: numberAt(values, limit)! } : {}),
						...(cursor && stringAt(values, cursor) !== undefined ? { cursor: stringAt(values, cursor)! } : {}),
					};
				},
			};
		}
	}

	const patternsKey = selectRole(schema, "patterns", (_key, property) => property.type === "array"
		&& hasType(arrayItem(property), "string") && hasPhrase(description(property), "literal patterns", "patterns (or)"), ["patterns"]);
	if (patternsKey) {
		const patternsSchema = schemaProperty(schema, patternsKey)!;
		const constraints = schemaProperty(schema, "constraints");
		if (!constraints || !hasType(constraints, "string")) return undefined;
		const context = byKeyAndType(schema, ["context"], "number");
		const limit = byKeyAndType(schema, ["limit"], "number");
		const cursor = byKeyAndType(schema, ["cursor"], "string");
		return {
			family: "search",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				const patterns = declaredArray(values, { patterns: patternsKey }, "patterns", patternsSchema, (value) => typeof value === "string");
				if (!patterns || !required(schema, patternsKey)) return undefined;
				const scope: SearchScope = {};
				if (stringAt(values, "constraints") !== undefined) Object.assign(scope, { pathExpression: stringAt(values, "constraints") });
				return {
					kind: "search.literal-any", patterns, scope,
						...(context && numberAt(values, context) !== undefined ? { contextLines: numberAt(values, context)! } : {}),
						...(limit && numberAt(values, limit) !== undefined ? { limit: numberAt(values, limit)! } : {}),
						...(cursor && stringAt(values, cursor) !== undefined ? { cursor: stringAt(values, cursor)! } : {}),
				};
			},
		};
	}

	const listPath = selectRole(schema, "root", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "directory to search", "directory to list"), ["path"]);
	if (listPath && !pattern && !propertyByKey(schema, "glob", "string")) {
		const limit = byKeyAndType(schema, ["limit"], "number");
		return {
			family: "search",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				const max = limit ? numberAt(values, limit) : undefined;
				return {
					kind: "search.list",
					...(stringAt(values, listPath) === undefined ? {} : { root: stringAt(values, listPath)! }),
					...(max === undefined ? {} : { limit: max }),
				};
			},
		};
	}

	const symbolQuery = selectRole(schema, "query", (key, property) => key === "query" && hasType(property, "string")
		&& hasPhrase(description(property), "identifier-ish query", "symbol search query"), ["query"]);
	const lang = selectRole(schema, "language", (key, property) => hasType(property, "string")
		&& (key === "lang" || hasPhrase(description(property), "restrict hits to one language")), ["lang"]);
	const paths = schemaProperty(schema, "paths");
	if (symbolQuery && lang && paths && hasType(paths, "array") && hasType(arrayItem(paths), "string")) {
		const limit = byKeyAndType(schema, ["limit"], "number");
		return {
			family: "search",
			construct: (args) => {
				const values = argsObject(args);
				const query = values && stringAt(values, symbolQuery);
				if (!values || query === undefined) return undefined;
				let pathValues: readonly string[] | undefined;
				if ("paths" in values) {
					pathValues = declaredArray(values, { paths: "paths" }, "paths", paths, (value) => typeof value === "string");
					if (!pathValues) return undefined;
				}
				const languageValue = stringAt(values, lang);
				const maximum = limit ? numberAt(values, limit) : undefined;
				return {
					kind: "search.symbols", query,
					...(pathValues === undefined ? {} : { paths: pathValues }),
					...(languageValue === undefined ? {} : { language: languageValue }),
					...(maximum === undefined ? {} : { limit: maximum }),
				};
			},
		};
	}
	return undefined;
}

function matchAst(schema: Schema): RequestMatch | undefined {
	const language = selectRole(schema, "language", (key, property) => key === "lang" && hasType(property, "string")
		&& enumValues(property) !== undefined, ["lang"]);
	if (!language) return undefined;
	const pattern = propertyByKey(schema, "pattern", "string") ? "pattern" : undefined;
	const dump = byKeyAndType(schema, ["dump"], "boolean");
	const validate = byKeyAndType(schema, ["validateOnly"], "boolean");
	const outlinePaths = schemaProperty(schema, "paths");
	const outlineDescription = outlinePaths ? description(outlinePaths) : "";
	if (outlinePaths && outlinePaths.type === "array" && hasPhrase(outlineDescription, "to outline")) {
		return {
			family: "code",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				const valuesArray = declaredArray(values, { paths: "paths" }, "paths", outlinePaths, (value) => typeof value === "string");
				if (!valuesArray) return undefined;
				return {
					kind: "code.outline",
					paths: valuesArray,
					...(stringAt(values, language) === undefined ? {} : { language: stringAt(values, language)! }),
				};
			},
		};
	}
	const rewrite = schemaProperty(schema, "rewrite");
	if (pattern && rewrite && hasType(rewrite, "string") && hasPhrase(description(schemaProperty(schema, pattern)), "ast pattern")) {
		const pathsSchema = schemaProperty(schema, "paths");
		const pathsCan = pathsSchema && onlyType(pathsSchema, "array") && hasType(arrayItem(pathsSchema), "string");
		const apply = byKeyAndType(schema, ["apply"], "boolean");
		const constraints = astConstraintsFromInput(schema, undefined, "");
		return {
			family: "code",
			construct: (args) => {
				const values = argsObject(args);
				const lang = values && stringAt(values, language);
				const codePattern = values && stringAt(values, pattern);
				const replacement = values && stringAt(values, "rewrite");
				if (!values || lang === undefined || codePattern === undefined || replacement === undefined || !constraints) return undefined;
				const projectedConstraints = constraints.construct(values);
				if (!projectedConstraints) return undefined;
				let projectedPaths: readonly string[] | undefined;
				if (pathsCan && pathsSchema && "paths" in values) {
					projectedPaths = declaredArray(values, { paths: "paths" }, "paths", pathsSchema, (value) => typeof value === "string");
					if (!projectedPaths) return undefined;
				}
				return {
					kind: "change.structural",
					language: lang, pattern: codePattern, rewrite: replacement,
					...(projectedPaths === undefined ? {} : { paths: projectedPaths }),
					constraints: projectedConstraints,
					intent: apply && booleanAt(values, apply) === true ? "apply" : "preview",
				};
			},
		};
	}
	if (pattern && (dump || validate)) {
		const selectorKey = byKeyAndType(schema, ["selector"], "string");
		const ruleKey = byKeyAndType(schema, ["rule"], "string");
		const nodeKind = byKeyAndType(schema, ["nodeKind"], "string");
		const insideKind = byKeyAndType(schema, ["insideKind"], "string");
		const hasKind = byKeyAndType(schema, ["hasKind"], "string");
		const hasDescendantKind = byKeyAndType(schema, ["hasDescendantKind"], "string");
		const follows = byKeyAndType(schema, ["follows"], "string");
		const precedes = byKeyAndType(schema, ["precedes"], "string");
		const pathsSchema = schemaProperty(schema, "paths");
		const pathsCan = pathsSchema && onlyType(pathsSchema, "array") && hasType(arrayItem(pathsSchema), "string");
		const skip = byKeyAndType(schema, ["skip"], "number");
		const maxMatches = byKeyAndType(schema, ["maxMatches"], "number");
		return {
			family: "code",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				const codePattern = stringAt(values, pattern);
				const isDump = dump ? booleanAt(values, dump) === true : false;
			const isValidation = validate ? booleanAt(values, validate) === true : false;
				if (isDump) {
					const languageValue = stringAt(values, language);
					return codePattern === undefined || languageValue === undefined ? undefined : {
						kind: "code.ast-dump", language: languageValue, source: codePattern,
					};
				}
			const selector = makeAstSelector(values, { pattern, selectorKey, ruleKey, nodeKind, insideKind, hasKind, hasDescendantKind, follows, precedes });
			if (!selector || !stringAt(values, language)) return undefined;
			if (isValidation) return { kind: "code.ast-validate", language: stringAt(values, language)!, selector };
			let projectedPaths: readonly string[] | undefined;
			if (pathsCan && pathsSchema && "paths" in values) {
				projectedPaths = declaredArray(values, { paths: "paths" }, "paths", pathsSchema, (value) => typeof value === "string");
				if (!projectedPaths) return undefined;
			}
			return {
				kind: "search.ast", language: stringAt(values, language)!, selector,
				...(projectedPaths === undefined ? {} : { paths: projectedPaths }),
					...(skip && numberAt(values, skip) !== undefined ? { skip: numberAt(values, skip)! } : {}),
					...(maxMatches && numberAt(values, maxMatches) !== undefined ? { maxMatches: numberAt(values, maxMatches)! } : {}),
			};
			},
		};
	}
	return undefined;
}

function astConstraintsFromInput(
	schema: Schema,
	known: Readonly<Record<string, string | undefined>> | undefined,
	_key: string,
): { construct: (args: Args) => AstConstraints | undefined } | undefined {
	const fields = known ?? {
		nodeKind: byKeyAndType(schema, ["nodeKind"], "string"),
		insideKind: byKeyAndType(schema, ["insideKind"], "string"),
		hasKind: byKeyAndType(schema, ["hasKind"], "string"),
		hasDescendantKind: byKeyAndType(schema, ["hasDescendantKind"], "string"),
		follows: byKeyAndType(schema, ["follows"], "string"),
		precedes: byKeyAndType(schema, ["precedes"], "string"),
	};
	const hasAny = Object.values(fields).some((key) => key && schemaProperty(schema, key));
	if (!hasAny) return undefined;
	return {
		construct: (args) => {
			const constraints: Record<string, unknown> = {};
			copyString(constraints, args, fields, "nodeKind");
			copyString(constraints, args, fields, "insideKind");
			const child = stringAt(args, fields.hasKind ?? "");
			const descendant = stringAt(args, fields.hasDescendantKind ?? "");
			if (child !== undefined && descendant !== undefined) return undefined;
			if (child !== undefined) constraints.contains = { relation: "child", kind: child };
			else if (descendant !== undefined) constraints.contains = { relation: "descendant", kind: descendant };
			copyString(constraints, args, fields, "follows");
			copyString(constraints, args, fields, "precedes");
			return constraints as AstConstraints;
		},
	};
}

function makeAstSelector(
	args: Args,
	fields: Readonly<Record<string, string | undefined>>,
): AstSelector | undefined {
	const pattern = stringAt(args, fields.pattern ?? "");
	const rule = stringAt(args, fields.ruleKey ?? "");
	const selector = stringAt(args, fields.selectorKey ?? "");
	const nodeKind = stringAt(args, fields.nodeKind ?? "");
	const insideKind = stringAt(args, fields.insideKind ?? "");
	const hasKind = stringAt(args, fields.hasKind ?? "");
	const hasDescendantKind = stringAt(args, fields.hasDescendantKind ?? "");
	const follows = stringAt(args, fields.follows ?? "");
	const precedes = stringAt(args, fields.precedes ?? "");
	const hasStructural = [nodeKind, insideKind, hasKind, hasDescendantKind, follows, precedes].some((value) => value !== undefined);
	const hasPattern = pattern !== undefined || selector !== undefined;
	if (rule !== undefined && (hasStructural || hasPattern)) return undefined;
	if (rule !== undefined) return { kind: "rule", rule };
	if (hasKind !== undefined && hasDescendantKind !== undefined) return undefined;
	if (hasStructural) {
		const constraints: Record<string, unknown> = {};
		if (nodeKind !== undefined) constraints.nodeKind = nodeKind;
		if (insideKind !== undefined) constraints.insideKind = insideKind;
		if (hasKind !== undefined) constraints.contains = { relation: "child", kind: hasKind };
		if (hasDescendantKind !== undefined) constraints.contains = { relation: "descendant", kind: hasDescendantKind };
		if (follows !== undefined) constraints.follows = follows;
		if (precedes !== undefined) constraints.precedes = precedes;
		if (pattern !== undefined && selector !== undefined) return undefined;
		return { kind: "structural", constraints: constraints as AstConstraints, ...(pattern === undefined ? {} : { pattern }) };
	}
	if (pattern === undefined) return undefined;
	return { kind: "pattern", pattern, ...(selector === undefined ? {} : { selector }) };
}

function matchDiagnostics(schema: Schema): RequestMatch | undefined {
	const source = schemaProperty(schema, "source");
	const scope = schemaProperty(schema, "scope");
	const mode = schemaProperty(schema, "mode");
	if (!source || !scope || !mode) return undefined;
	const sourceValues = enumValues(source);
	const scopeValues = enumValues(scope);
	const modeValues = enumValues(mode);
	if (!sourceValues?.includes("session") || !sourceValues.includes("lsp")
		|| !scopeValues?.includes("paths") || !scopeValues.includes("workspace")
		|| !modeValues?.includes("delta") || !modeValues.includes("all") || !modeValues.includes("full")) return undefined;
	const path = byKeyAndType(schema, ["path"], "string");
	const pathsSchema = schemaProperty(schema, "paths");
	return {
		family: "code",
		construct: (args) => {
			const values = argsObject(args);
			if (!values) return undefined;
			let paths: readonly string[] | undefined;
			if (pathsSchema && "paths" in values) {
				paths = declaredArray(values, { paths: "paths" }, "paths", pathsSchema, (value) => typeof value === "string");
				if (!paths) return undefined;
			}
			const sourceValue = stringAt(values, "source");
			const scopeValue = stringAt(values, "scope");
			const modeValue = stringAt(values, "mode");
			if (sourceValue && !["session", "lsp"].includes(sourceValue)) return undefined;
			if (scopeValue && !["paths", "workspace"].includes(scopeValue)) return undefined;
			if (modeValue && !["delta", "all", "full"].includes(modeValue)) return undefined;
			return {
				kind: "code.diagnostics",
				...(sourceValue === undefined ? {} : { source: sourceValue as "session" | "lsp" }),
				...(scopeValue === undefined ? {} : { scope: scopeValue as "paths" | "workspace" }),
				...(modeValue === undefined ? {} : { mode: modeValue as "delta" | "all" | "full" }),
					...(path && stringAt(values, path) !== undefined ? { path: stringAt(values, path)! } : {}),
				...(paths === undefined ? {} : { paths }),
			};
		},
	};
}

function matchCodeReports(schema: Schema): RequestMatch | undefined {
	const path = selectRole(schema, "path", (_key, property) => hasType(property, "string")
		&& hasPhrase(description(property), "source file", "source file, e.g."), ["path"]);
	const maxRefs = selectRole(schema, "maxRefs", (_key, property) => hasType(property, "number")
		&& hasPhrase(description(property), "who-uses-this entries"), ["maxRefsPerSymbol"]);
	if (path && maxRefs && required(schema, path)) {
		return {
			family: "code",
			construct: (args) => {
				const values = argsObject(args);
				const target = values && stringAt(values, path);
				return target === undefined ? undefined : { kind: "code.module-report", path: target };
			},
		};
	}

	const limit = schemaProperty(schema, "limit");
	const focus = schemaProperty(schema, "focus");
	if (limit && focus && hasType(limit, "number")
		&& hasPhrase(description(limit), "scales every ranked section")
		&& hasPhrase(description(focus), "task hint used only to rank", "task hint used only to re-rank")) {
		return { family: "code", construct: (args) => argsObject(args) ? { kind: "code.project-report" } : undefined };
	}
	return undefined;
}

function matchLsp(schema: Schema): RequestMatch | undefined {
	const operationSchema = schemaProperty(schema, "operation");
	if (!operationSchema || !hasType(operationSchema, "string") || !hasPhrase(description(operationSchema), "lsp operation")) return undefined;
	const pathKey = byKeyAndType(schema, ["path"], "string");
	const lineKey = byKeyAndType(schema, ["line"], "number");
	const characterKey = byKeyAndType(schema, ["character"], "number");
	const symbolKey = byKeyAndType(schema, ["symbol"], "string");
	const endLine = byKeyAndType(schema, ["endLine"], "number");
	const endCharacter = byKeyAndType(schema, ["endCharacter"], "number");
	const newName = byKeyAndType(schema, ["newName"], "string");
	const newPath = byKeyAndType(schema, ["newFilePath"], "string");
	const query = byKeyAndType(schema, ["query"], "string");
	const command = byKeyAndType(schema, ["command"], "string");
	const apply = byKeyAndType(schema, ["apply"], "boolean");
	const commandArgs = schemaProperty(schema, "commandArguments");
	const callItem = schemaProperty(schema, "callHierarchyItem");
	const fieldKeys = { pathKey, lineKey, characterKey, symbolKey, endLine, endCharacter, newName, newPath, query, command, apply };

	return {
		family: "code",
		construct: (args) => {
			const values = argsObject(args);
			const operation = values && stringAt(values, "operation");
			if (!values || operation === undefined) return undefined;
			const intent: ApplyIntent = apply && booleanAt(values, apply) === true ? "apply" : "preview";
			if (operation === "documentSymbol") {
				const path = pathKey ? stringAt(values, pathKey) : undefined;
				return path === undefined ? undefined : { kind: "code.document-symbols", path };
			}
			if (operation === "findSymbol" || operation === "workspaceSymbol") {
				const text = query ? stringAt(values, query) : undefined;
				const path = pathKey ? stringAt(values, pathKey) : undefined;
				return text === undefined ? undefined : { kind: "code.symbol-query", operation, query: text, ...(path === undefined ? {} : { path }) };
			}
			if (operation === "codeAction") {
				const target = positionFrom(values, fieldKeys);
				return target ? { kind: "code.actions", target } : undefined;
			}
			if (operation === "prepareCallHierarchy") {
				const target = positionFrom(values, fieldKeys);
				return target ? { kind: "code.hierarchy", operation, target } : undefined;
			}
			if (operation === "incomingCalls" || operation === "outgoingCalls") {
				const item = callItem ? object(values.callHierarchyItem) : undefined;
				return item && isJson(item) ? { kind: "code.hierarchy", operation, target: { kind: "provided-item", item } } : undefined;
			}
			if (operation === "workspaceDiagnostics") {
				const path = pathKey ? stringAt(values, pathKey) : undefined;
				return { kind: "code.workspace-diagnostics", ...(path === undefined ? {} : { path }) };
			}
			if (operation === "capabilities") {
				const path = pathKey ? stringAt(values, pathKey) : undefined;
				return { kind: "code.capabilities", ...(path === undefined ? {} : { path }) };
			}
			if (operation === "executeCommand") {
				const commandValue = command ? stringAt(values, command) : undefined;
				if (commandValue === undefined) return undefined;
				let argumentsValue: readonly Json[] | undefined;
				if (commandArgs && "commandArguments" in values) {
					argumentsValue = declaredArray(values, { arguments: "commandArguments" }, "arguments", commandArgs, (value): value is Json => isJson(value));
					if (!argumentsValue) return undefined;
				}
				return { kind: "code.command", command: commandValue, ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }), intent };
			}
			if (operation === "rename") {
				const target = positionFrom(values, fieldKeys);
				const name = newName ? stringAt(values, newName) : undefined;
				return target && name !== undefined ? { kind: "change.rename-symbol", target, newName: name, intent } : undefined;
			}
			if (operation === "rename_file") {
				const path = pathKey ? stringAt(values, pathKey) : undefined;
				const destination = newPath ? stringAt(values, newPath) : undefined;
				return path !== undefined && destination !== undefined ? { kind: "change.rename-file", path, newPath: destination, intent } : undefined;
			}
			if (["definition", "typeDefinition", "declaration", "references", "hover", "signatureHelp", "implementation"].includes(operation)) {
				const target = positionFrom(values, fieldKeys);
				return target ? { kind: "code.navigation", operation: operation as Extract<CodeRequest, { kind: "code.navigation" }>['operation'], target } : undefined;
			}
			return undefined;
		},
	};
}

function positionFrom(
	args: Args,
	fields: Readonly<Record<string, string | undefined>>,
): PositionRequest | undefined {
	const path = stringAt(args, fields.pathKey ?? "");
	if (path === undefined) return undefined;
	const rawLine = fields.lineKey ? numberAt(args, fields.lineKey) : undefined;
	if (rawLine === undefined) return undefined;
	const line1 = rawLine;
	const character = fields.characterKey ? numberAt(args, fields.characterKey) : undefined;
	const symbol = fields.symbolKey ? stringAt(args, fields.symbolKey) : undefined;
	const anchor = character !== undefined && character > 0
		? { kind: "character" as const, character1: character }
		: symbol !== undefined
			? { kind: "symbol-on-line" as const, symbol }
			: { kind: "line-start" as const };
	const endLine = fields.endLine ? numberAt(args, fields.endLine) : undefined;
	const endCharacter = fields.endCharacter ? numberAt(args, fields.endCharacter) : undefined;
	const end = endLine === undefined && endCharacter === undefined ? undefined : {
		...(endLine === undefined ? {} : { line1: endLine }),
		...(endCharacter === undefined ? {} : { character1: endCharacter }),
	};
	return { path, line1, anchor, ...(end === undefined ? {} : { end }) };
}

function matchWeb(schema: Schema): RequestMatch | undefined {
	const responseId = schemaProperty(schema, "responseId");
	if (responseId && hasType(responseId, "string") && required(schema, "responseId")) {
		const findText = schemaProperty(schema, "findText");
		const findMode = schemaProperty(schema, "findMode");
		const offset = byKeyAndType(schema, ["offset"], "number");
		const limit = byKeyAndType(schema, ["limit"], "number");
		if (findText || findMode || offset || limit) {
			const querySelector = schemaProperty(schema, "query");
			const urlSelector = schemaProperty(schema, "url");
			const queryIndex = byKeyAndType(schema, ["queryIndex"], "number");
			const urlIndex = byKeyAndType(schema, ["urlIndex"], "number");
			return {
				family: "web",
				construct: (args) => {
					const values = argsObject(args);
					const id = values && stringAt(values, "responseId");
					if (!values || id === undefined) return undefined;
					const selectors: { query?: import("../presentation.ts").StoredSelection; url?: import("../presentation.ts").StoredSelection } = {};
					const queryValue = querySelector ? stringAt(values, "query") : undefined;
					const qIndex = queryIndex ? numberAt(values, queryIndex) : undefined;
					const urlValue = urlSelector ? stringAt(values, "url") : undefined;
					const uIndex = urlIndex ? numberAt(values, urlIndex) : undefined;
					if (queryValue !== undefined && qIndex !== undefined) selectors.query = { kind: "both", value: queryValue, index0: qIndex };
					else if (queryValue !== undefined) selectors.query = { kind: "text", value: queryValue };
					else if (qIndex !== undefined) selectors.query = { kind: "index", index0: qIndex };
					if (urlValue !== undefined && uIndex !== undefined) selectors.url = { kind: "both", value: urlValue, index0: uIndex };
					else if (urlValue !== undefined) selectors.url = { kind: "text", value: urlValue };
					else if (uIndex !== undefined) selectors.url = { kind: "index", index0: uIndex };
					if (findText && "findText" in values) {
						const findKey = "findText";
						const findValues = scalarOrArray(values, findKey, findText, (value) => typeof value === "string");
						if (findValues.kind !== "value") return undefined;
						const mode = stringAt(values, "findMode") ?? "case-insensitive";
						if (!["exact", "case-insensitive", "fuzzy"].includes(mode)) return undefined;
						return { kind: "web.stored-find", responseId: id, selectors, needles: findValues.values, mode: mode as "exact" | "case-insensitive" | "fuzzy" };
					}
					if (findMode && "findMode" in values) return undefined;
					return {
						kind: "web.stored-slice", responseId: id, selectors,
						...(offset && numberAt(values, offset) !== undefined ? { offsetUtf16: numberAt(values, offset)! } : {}),
						...(limit && numberAt(values, limit) !== undefined ? { limitUtf16: numberAt(values, limit)! } : {}),
					};
				},
			};
		}
	}

	const claim = selectRole(schema, "claim", (key, property) => key === "claim" && hasType(property, "string")
		&& hasPhrase(description(property), "assertion to gather web sources"), ["claim"]);
	if (claim) {
		const queries = schemaProperty(schema, "queries");
		return {
			family: "web",
			construct: (args) => {
				const values = argsObject(args);
				const statement = values && stringAt(values, claim);
				if (!values || statement === undefined) return undefined;
				let queryValues: readonly string[] | undefined;
				if (queries && "queries" in values) {
					queryValues = declaredArray(values, { queries: "queries" }, "queries", queries, (value) => typeof value === "string");
					if (!queryValues) return undefined;
				}
				return { kind: "web.source-check", claim: statement, ...(queryValues === undefined ? {} : { queries: queryValues }) };
			},
		};
	}

	const queryProp = schemaProperty(schema, "query");
	const queriesProp = schemaProperty(schema, "queries");
	const urlsProp = schemaProperty(schema, "urls");
	if (queryProp && hasType(queryProp, "string") && urlsProp && hasType(urlsProp, "array")
		&& hasType(arrayItem(urlsProp), "string") && hasPhrase(description(queryProp), "question or task to perform on the urls")) {
		return {
			family: "web",
			construct: (args) => {
				const values = argsObject(args);
				const query = values && stringAt(values, "query");
				if (!values || query === undefined) return undefined;
				const urls = declaredArray(values, { urls: "urls" }, "urls", urlsProp, (value) => typeof value === "string");
				return urls ? { kind: "web.url-context", query, urls } : undefined;
			},
		};
	}

	const fetchDescription = [schemaProperty(schema, "url"), urlsProp].filter(Boolean).map((field) => description(field)).join(" ");
	if ((schemaProperty(schema, "url") || urlsProp) && hasPhrase(fetchDescription, "url to fetch", "urls (parallel)")) {
		const urlField = schemaProperty(schema, "url");
		const mode = byKeyAndType(schema, ["mode"], "string");
		const prompt = byKeyAndType(schema, ["prompt"], "string");
		return {
			family: "web-fetch",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				let single: string | undefined;
				let multiple: readonly string[] | undefined;
				if (urlField && "url" in values) {
					if (typeof values.url !== "string") return undefined;
					single = values.url;
				}
				if (urlsProp && "urls" in values) {
					multiple = declaredArray(values, { urls: "urls" }, "urls", urlsProp, (value) => typeof value === "string");
					if (!multiple) return undefined;
				}
				if (single === undefined && multiple === undefined) return undefined;
				const targets = single !== undefined && multiple !== undefined ? { kind: "both" as const, url: single, urls: multiple }
					: single !== undefined ? { kind: "single" as const, url: single }
						: { kind: "multiple" as const, urls: multiple! };
				const modeValue = mode ? stringAt(values, mode) : undefined;
				if (modeValue !== undefined && !["readable", "raw", "answer"].includes(modeValue)) return undefined;
				const promptValue = prompt ? stringAt(values, prompt) : undefined;
				return {
					kind: "web.fetch", targets,
					...(modeValue === undefined ? {} : { mode: modeValue as "readable" | "raw" | "answer" }),
					...(promptValue === undefined ? {} : { prompt: promptValue }),
				};
			},
		};
	}

	const searchQuery = queryProp && hasType(queryProp, "string")
		&& hasPhrase(description(queryProp), "single search query", "search query or question to answer")
		? "query"
		: undefined;
	const searchQueries = queriesProp && hasType(queriesProp, "array") && hasType(arrayItem(queriesProp), "string")
		&& hasPhrase(description(queriesProp), "multiple queries", "queries searched concurrently") ? "queries" : undefined;
	if (searchQuery || searchQueries) {
		const contextUrls = urlsProp && hasType(urlsProp, "array") && hasType(arrayItem(urlsProp), "string")
			&& hasPhrase(description(urlsProp), "additional urls") ? urlsProp : undefined;
		return {
			family: "web",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				let queryValue: string | undefined;
				let queriesValue: readonly string[] | undefined;
				if (searchQuery && searchQuery in values) {
					if (typeof values[searchQuery] !== "string") return undefined;
					queryValue = values[searchQuery] as string;
				}
				if (searchQueries && searchQueries in values) {
					queriesValue = declaredArray(values, { queries: searchQueries }, "queries", queriesProp!, (value) => typeof value === "string");
					if (!queriesValue) return undefined;
				}
				if (queryValue === undefined && queriesValue === undefined) return undefined;
				const input = queryValue !== undefined && queriesValue !== undefined ? { kind: "both" as const, query: queryValue, queries: queriesValue }
					: queryValue !== undefined ? { kind: "single" as const, query: queryValue }
						: { kind: "multiple" as const, queries: queriesValue! };
				let context: readonly string[] | undefined;
				if (contextUrls && "urls" in values) {
					context = declaredArray(values, { contextUrls: "urls" }, "contextUrls", contextUrls, (value) => typeof value === "string");
					if (!context) return undefined;
				}
				return { kind: "web.search", input, ...(context === undefined ? {} : { contextUrls: context }) };
			},
		};
	}

	const operationFields = propertyEntries(schema).filter(([key, property]) => {
		if (!hasType(property, "array")) return false;
		const item = arrayItem(property);
		return item !== undefined && hasObjectSchema(item) && ["search", "open", "click", "find", "finance", "sports", "weather", "time", "screenshot"].some((section) => key.toLowerCase().includes(section));
	});
	if (operationFields.some(([key]) => key === "search_query" || key === "image_query")
		&& operationFields.some(([key]) => key === "open")
		&& operationFields.some(([key]) => key === "click")
		&& operationFields.some(([key]) => key === "find")) {
		return {
			family: "web",
			construct: (args) => {
				const values = argsObject(args);
				if (!values) return undefined;
				const actions: WebAction[] = [];
				let hasDeclaredSection = false;
				for (const [key, field] of operationFields) {
					if (!(key in values)) continue;
					hasDeclaredSection = true;
					const item = arrayItem(field)!;
					const entries = declaredArray(values, { section: key }, "section", field, (value, elementSchema) => isObjectElement(value, elementSchema));
					if (!entries) return undefined;
					for (const entry of entries) {
						const action = compoundAction(key, entry, item);
						if (!action) return undefined;
						actions.push(action);
					}
				}
			return hasDeclaredSection ? { kind: "web.compound", actions } : undefined;
			},
		};
	}
	return undefined;
}

function compoundAction(key: string, value: import("../presentation.ts").JsonObject, itemSchema: Schema): WebAction | undefined {
	if (key === "search_query" || key === "image_query") {
		const query = stringAt(value, "q");
		if (query === undefined) return undefined;
		const recencyDays = numberAt(value, "recency");
		let domains: readonly string[] | undefined;
		const domainSchema = schemaProperty(itemSchema, "domains");
		if ("domains" in value) {
			if (!domainSchema) return undefined;
			domains = declaredArray(value, { domains: "domains" }, "domains", domainSchema, (entry): entry is string => typeof entry === "string");
			if (!domains) return undefined;
		}
		return {
			kind: key === "search_query" ? "search" : "image-search",
			query,
			...(recencyDays === undefined ? {} : { recencyDays }),
			...(domains === undefined ? {} : { domains }),
		};
	}
	if (key === "open") {
		const reference = stringAt(value, "ref_id");
		const line = numberAt(value, "lineno");
		return reference === undefined ? undefined : { kind: "open", reference, ...(line === undefined ? {} : { line }) };
	}
	if (key === "click") {
		const reference = stringAt(value, "ref_id");
		const linkId = numberAt(value, "id");
		return reference === undefined || linkId === undefined ? undefined : { kind: "click", reference, linkId };
	}
	if (key === "find") {
		const reference = stringAt(value, "ref_id");
		const pattern = stringAt(value, "pattern");
		return reference === undefined || pattern === undefined ? undefined : { kind: "find", reference, pattern };
	}
	const sections = ["finance", "sports", "weather", "time", "screenshot"] as const;
	if (sections.includes(key as typeof sections[number])) return { kind: "lookup", section: key as typeof sections[number], suppliedArguments: value };
	return undefined;
}

function matchImage(declaration: EffectiveDeclaration, schema: Schema): RequestMatch | undefined {
	const imageDescription = declaration.description.toLowerCase();
	const path = selectRole(schema, "path", (key, property) => hasType(property, "string")
		&& (hasPhrase(description(property), "path to the local image", "image file to view")
			|| (key === "path" && hasPhrase(imageDescription, "image") && hasPhrase(imageDescription, "view"))), ["path"]);
	const prompt = schemaProperty(schema, "prompt");
	const explicitPaths = schemaProperty(schema, "referenced_image_paths");
	const count = schemaProperty(schema, "num_last_images_to_include");
	const promptDescribesImage = prompt && hasPhrase(description(prompt), "image prompt", "prompt for image");
	if (path && (explicitPaths || count || promptDescribesImage)) return undefined;
	if (path) {
		return {
			family: "image",
			construct: (args) => {
				const values = argsObject(args);
				const target = values && stringAt(values, path);
				return target === undefined ? undefined : { kind: "image.view", path: target };
			},
		};
	}
	if (!prompt && !explicitPaths && !count) return undefined;
	if (prompt && !promptDescribesImage
		&& !explicitPaths && !count) return undefined;
	const explicitArray = explicitPaths ? arraySchemaBranch(explicitPaths) : undefined;
	const pathsArray = explicitArray && hasType(arrayItem(explicitArray), "string");
	const pathRequests = explicitArray && !pathsArray ? arrayItem(explicitArray) : undefined;
	if (explicitPaths && !pathsArray && !pathRequests) return undefined;
	return {
		family: "image",
		construct: (args) => {
			const values = argsObject(args);
			if (!values) return undefined;
			const referenceRequests: ({ readonly kind: "path"; readonly path: string } | { readonly kind: "recent"; readonly count: number })[] = [];
			if (explicitPaths && "referenced_image_paths" in values) {
				if (values.referenced_image_paths === null) {
					// Null means no explicit image references.
				} else if (pathsArray) {
					const paths = reconstructArray(values.referenced_image_paths, arrayItem(explicitArray!)!, (value) => typeof value === "string");
					if (!paths) return undefined;
					for (const imagePath of paths) referenceRequests.push({ kind: "path", path: imagePath });
				} else if (pathRequests) {
					const refs = reconstructArray(values.referenced_image_paths, arrayItem(explicitArray!)!, (value, elementSchema) => isObjectElement(value, elementSchema));
					if (!refs) return undefined;
					for (const reference of refs) {
						if (reference.kind === "path" && typeof reference.path === "string") referenceRequests.push({ kind: "path", path: reference.path });
						else if (reference.kind === "recent" && typeof reference.count === "number") referenceRequests.push({ kind: "recent", count: reference.count });
						else return undefined;
					}
				}
			}
			const recent = count ? numberAt(values, "num_last_images_to_include") : undefined;
			if (recent !== undefined) referenceRequests.push({ kind: "recent", count: recent });
			const promptValue = prompt ? stringAt(values, "prompt") : undefined;
			return {
				kind: "image.synthesize",
				...(promptValue === undefined ? {} : { prompt: promptValue }),
				referenceRequests,
			};
		},
	};
}

export function compileRequest(declaration: EffectiveDeclaration): RequestMatch | undefined {
	const freeform = matchFreeform(declaration);
	if (freeform) return freeform;
	if (declaration.input.kind !== "json") return undefined;
	const schema = object(declaration.input.schema);
	if (!schema) return undefined;

	const matches = [
		matchRead(declaration, schema),
		matchWrite(schema),
		matchReplacements(schema),
		matchLocatedEdit(schema, declaration.description),
		matchMitsupiEdit(schema),
		matchPatch(schema),
		matchShellLaunch(schema),
		matchStdin(schema),
		matchProgram(declaration, schema),
		matchSourceByDescription(schema),
		matchSearch(schema),
		matchAst(schema),
		matchDiagnostics(schema),
		matchCodeReports(schema),
		matchLsp(schema),
		matchWeb(schema),
		matchImage(declaration, schema),
	].filter((candidate): candidate is RequestMatch => candidate !== undefined);
	return matches.length === 1 ? matches[0] : undefined;
}
