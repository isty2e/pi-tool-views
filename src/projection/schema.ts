import type { Json, JsonObject } from "../presentation.ts";

export type Schema = JsonObject;

export function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

export function string(value: Json | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function number(value: Json | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boolean(value: Json | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function stringAt(record: JsonObject, key: string): string | undefined {
	return string(record[key]);
}

export function numberAt(record: JsonObject, key: string): number | undefined {
	return number(record[key]);
}

export function booleanAt(record: JsonObject, key: string): boolean | undefined {
	return boolean(record[key]);
}

export function schemaProperties(schema: Schema | undefined): JsonObject | undefined {
	return schema ? object(schema.properties) : undefined;
}

export function schemaProperty(schema: Schema | undefined, key: string): Schema | undefined {
	const properties = schemaProperties(schema);
	return properties ? object(properties[key]) : undefined;
}

export function propertyEntries(schema: Schema | undefined): readonly (readonly [string, Schema])[] {
	const properties = schemaProperties(schema);
	if (!properties) return [];

	return Object.entries(properties).flatMap(([key, value]) => {
		const child = object(value);
		return child ? [[key, child] as const] : [];
	});
}

export function required(schema: Schema | undefined, key: string): boolean {
	const requiredFields = schema?.required;
	return Array.isArray(requiredFields) && requiredFields.includes(key);
}

export function hasType(schema: Schema | undefined, expected: string): boolean {
	if (!schema) return false;
	if (schema.type === expected) return true;
	if (expected === "number" && schema.type === "integer") return true;
	if (Array.isArray(schema.type) && (schema.type.includes(expected) || (expected === "number" && schema.type.includes("integer")))) return true;

	for (const branchKey of ["anyOf", "oneOf", "allOf"] as const) {
		const branches = schema[branchKey];
		if (Array.isArray(branches) && branches.some((branch) => hasType(object(branch), expected))) {
			return true;
		}
	}

	return false;
}

export function onlyType(schema: Schema | undefined, expected: string): boolean {
	if (!schema) return false;
	if (schema.type === expected) return true;
	if (Array.isArray(schema.type)) return schema.type.length > 0 && schema.type.every((type) => type === expected);

	for (const branchKey of ["anyOf", "oneOf"] as const) {
		const branches = schema[branchKey];
		if (Array.isArray(branches)) {
			return branches.length > 0 && branches.every((branch) => onlyType(object(branch), expected));
		}
	}

	return false;
}

export function arrayItem(schema: Schema | undefined): Schema | undefined {
	if (schema?.type !== "array") return undefined;
	return object(schema.items);
}

export function enumValues(schema: Schema | undefined): readonly Json[] | undefined {
	return schema && Array.isArray(schema.enum) ? schema.enum : undefined;
}

export function description(schema: Schema | undefined): string {
	return typeof schema?.description === "string" ? schema.description : "";
}

export function hasPhrase(text: string, ...phrases: readonly string[]): boolean {
	const lower = text.toLocaleLowerCase("en-US");
	return phrases.some((phrase) => lower.includes(phrase.toLocaleLowerCase("en-US")));
}

export function uniqueProperty(
	schema: Schema | undefined,
	predicate: (key: string, property: Schema) => boolean,
): readonly [string, Schema] | undefined {
	const matches = propertyEntries(schema).filter(([key, property]) => predicate(key, property));
	return matches.length === 1 ? matches[0] : undefined;
}
export function isJson(value: unknown): value is Json {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	if (typeof value !== "object") return false;
	return Object.values(value).every(isJson);
}
