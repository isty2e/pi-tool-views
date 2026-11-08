import { isAbsolute, resolve } from "node:path";
import type { FileContext, FileReference, Json, RequestView } from "../presentation.ts";
import { description, hasType, object, propertyEntries, type Schema } from "./schema.ts";

function directoryRole(key: string, field: Schema): boolean {
  const text = description(field);
  const meaning = /^\s*(?:optional\s+)?(?:the\s+)?(?:(?:absolute(?: or relative)?|relative)\s+)?(?:(?:current|working|base|root)\s+)?(?:directory|working folder|workspace root)\b|^\s*path (?:to|of) (?:the |a )?(?:(?:working|base|root) )?directory\b/i.test(text);
  return hasType(field, "string") && (meaning || (/^(?:cwd|workdir|working_directory|workingDirectory|baseDirectory|base_directory)$/.test(key) && !text));
}

export function operationArguments(schema: Schema | undefined, args: Json): Json {
  const values = object(args);
  if (!schema || !values) return args;
  const contextual = new Set(propertyEntries(schema).filter(([key, field]) => directoryRole(key, field) || spaceRole(key, field)).map(([key]) => key));
  return contextual.size ? Object.fromEntries(Object.entries(values).filter(([key]) => !contextual.has(key))) : args;
}

function spaceRole(key: string, field: Schema): boolean {
  const text = description(field);
  return hasType(field, "string") && ((/^(?:execution_environment|executionEnvironment|filesystem|remote_host|container_id|sandbox_id)$/.test(key) && !text)
    || /^\s*(?:optional\s+)?(?:the\s+)?(?:execution environment|remote host|container identifier|sandbox identifier|filesystem namespace)\b/i.test(text));
}

/** Missing context inherits; conflicting declared context must not inherit silently. */
export function normalizeFileContext(schema: Schema | undefined, args: Json, toolDescription = ""): FileContext | undefined {
  const values = object(args);
  const fields = schema ? propertyEntries(schema) : [];
  const present = ([key, field]: readonly [string, Schema]) => values && key in values && !(values[key] === null && hasType(field, "null"));
  const directories = fields.filter(([key, field]) => directoryRole(key, field) && present([key, field])).map(([key]) => values![key]);
  const spaces = fields.filter(([key, field]) => spaceRole(key, field) && present([key, field])).map(([key, field]) => ({ value: values![key],
    identifier: /^(?:remote_host|container_id|sandbox_id)$/.test(key) || /^\s*(?:optional\s+)?(?:the\s+)?(?:remote host|container identifier|sandbox identifier)\b/i.test(description(field)) }));
  const directory = directories[0];
  const space = spaces[0]?.value;
  if (directories.some(value => typeof value !== "string" || !value || value.includes("\0") || value !== directory)
    || spaces.some(({ value }) => typeof value !== "string" || !value || value !== space)
    || (spaces.some(item => item.identifier) && spaces.some(item => !item.identifier && typeof item.value === "string" && /^(?:local|workspace|host|current)$/i.test(item.value)))) return { kind: "unresolved" };
  const externalDescription = /\b(?:in|on|inside|within) (?:a |the )?(?:remote (?:host|workspace|filesystem)|container|sandbox)\b/i.test(toolDescription);
  if (typeof space === "string" && (spaces.some(item => item.identifier) || !/^(?:local|workspace|host|current)$/i.test(space))) return { kind: "external", reference: space };
  if (externalDescription && space === undefined) return { kind: "external", reference: toolDescription };
  if (typeof directory === "string" && /^[a-z][a-z\d+.-]*:\/\//i.test(directory)) return { kind: "external", reference: directory };
  if (typeof space === "string") return { kind: "local", ...(typeof directory === "string" ? { directory } : {}) };
  return typeof directory === "string" ? { kind: "directory", path: directory } : undefined;
}

export function attachFileContext(request: RequestView, schema: Schema | undefined, args: Json, toolDescription: string): RequestView {
  if (!request.kind.startsWith("change.")) return request;
  const context = normalizeFileContext(schema, args, toolDescription);
  return context ? { ...request, fileContext: context } as RequestView : request;
}

/** Bind normalized scope to an invocation directory; no filesystem or environment access occurs here. */
export function fileReference(path: string, invocationDirectory: string, ...contexts: readonly (FileContext | undefined)[]): FileReference {
  if (!path || path.includes("\0") || !isAbsolute(invocationDirectory)) return { kind: "unresolved", path };
  let directory = invocationDirectory;
  let external: string | undefined;
  for (const context of contexts) {
    if (!context) continue;
    if (context.kind === "unresolved") return { kind: "unresolved", path };
    if (context.kind === "external") { external = context.reference; continue; }
    if (context.kind === "local") {
      if (external !== undefined) directory = invocationDirectory;
      external = undefined;
      if (context.directory !== undefined) directory = resolve(directory, context.directory);
    } else if (external === undefined) directory = resolve(directory, context.path);
  }
  if (external !== undefined) return { kind: "external", reference: external };
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return { kind: "external", reference: path };
  return { kind: "local", absolutePath: resolve(directory, path) };
}
