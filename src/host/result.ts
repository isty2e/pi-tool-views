import { asObject, toJson } from "../json.ts";
import type { EffectiveDeclaration, SuppliedContent, SuppliedToolResult } from "../presentation.ts";

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

function suppliedContent(value: unknown): SuppliedContent {
  const type = ownValue(value, "type");
  const text = ownValue(value, "text");
  if (type === "text" && typeof text === "string") return { kind: "text", text };
  const data = ownValue(value, "data");
  const mimeType = ownValue(value, "mimeType");
  if (type === "image" && typeof data === "string" && typeof mimeType === "string") return { kind: "image", data, mimeType };
  const json = toJson(value);
  return json === undefined ? { kind: "unavailable" } : { kind: "other", value: json };
}

export function suppliedResult(value: unknown, isError: boolean, durationMs?: number): SuppliedToolResult {
  const raw = ownValue(value, "content");
  const content: SuppliedContent[] = Array.isArray(raw)
    ? Array.from({ length: raw.length }, (_, index) => suppliedContent(ownValue(raw, String(index))))
    : [{ kind: "unavailable" }];
  const details = toJson(ownValue(value, "details"));
  const structuredContent = toJson(ownValue(value, "structuredContent"));

  return {
    content,
    isError,
    ...(details !== undefined ? { details } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

export function effectiveDeclaration(value: unknown): EffectiveDeclaration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const selected: Record<string, unknown> = {};
  for (const key of ["description", "parameters", "constrainedSampling", "outputSchema"]) {
    const field = fields[key];
    if (field && !("value" in field)) return undefined;
    if (field) selected[key] = field.value;
  }
  const object = asObject(toJson(selected));
  if (!object || typeof object.description !== "string" || object.parameters === undefined) return undefined;

  return {
    description: object.description,
    input: { kind: "json", schema: object.parameters },
    ...(object.constrainedSampling !== undefined ? { sampling: object.constrainedSampling } : {}),
    ...(object.outputSchema !== undefined ? { outputSchema: object.outputSchema } : {}),
  };
}
