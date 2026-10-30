import { object } from "./schema.ts";
import { parseNumbered } from "../diff/formats.ts";
import type { RequestView, ResultPart, SuppliedToolResult } from "../presentation.ts";

export function anchorSectionRemainder(result: SuppliedToolResult, request: RequestView | undefined, parts: readonly ResultPart[]): string | undefined {
  if (result.isError || request?.kind !== "change.replacements" || result.content.length !== 1) return undefined;
  const paths = new Set(request.requestedEdits.map(edit => edit.path));
  if (paths.size !== 1 || ![...paths][0]) return undefined;

  const detail = object(result.details);
  if (!detail || detail.classification !== "applied" || typeof detail.diff !== "string") return undefined;

  const diffs = parts.filter(part => part.kind === "diff");
  if (diffs.length !== 1 || diffs[0]?.origin !== "reported" || diffs[0].representations.numbered !== detail.diff) return undefined;
  const parsed = parseNumbered(detail.diff);
  if (!parsed || parsed.scopeConflict || !parsed.sections.some(section => section.kind === "hunks")
    || parsed.sections.some(section => section.target && section.target.path !== [...paths][0])) return undefined;

  const content = result.content[0];
  if (content?.kind !== "text") return undefined;
  const header = /^--- Anchors ([1-9]\d*)-([1-9]\d*) ---\n/.exec(content.text);
  if (!header) return undefined;
  const first = Number(header[1]);
  const last = Number(header[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last - first >= content.text.length) return undefined;

  let offset = header[0].length;
  for (let line = first; line <= last; line++) {
    const end = content.text.indexOf("\n", offset);
    const raw = content.text.slice(offset, end < 0 ? undefined : end);
    const match = /^([1-9]\d*#[A-Za-z0-9]+):(.*)$/.exec(raw);
    if (!match || !match[1]?.startsWith(`${line}#`)) return undefined;
    offset = end < 0 ? content.text.length : end + 1;
  }
  const suffix = content.text.slice(offset);
  if (suffix && !suffix.startsWith("\n")) return undefined;
  return suffix.startsWith("\n") ? suffix.slice(1) : suffix;
}
