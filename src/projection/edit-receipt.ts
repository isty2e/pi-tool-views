import { parseUnified } from "../diff/formats.ts";
import type { RequestView, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { object } from "./schema.ts";

export function editReceipt(result: SuppliedToolResult, request: RequestView | undefined, parts: readonly ResultPart[]): ResultPart | undefined {
  if (result.isError || request?.kind !== "change.replacements" || request.requestedEdits.length !== 1 || result.content.length !== 1) return undefined;
  const edit = request.requestedEdits[0]!;
  const path = "kind" in edit && edit.kind === "transfer" ? edit.destination.path : edit.path;
  if (!path) return undefined;

  const details = object(result.details), receipt = object(details?.ptcValue), diffData = object(details?.diffData), stats = object(diffData?.stats);
  if (!receipt || receipt.tool !== "edit" || receipt.ok !== true || receipt.summary !== `Updated ${path}`
    || typeof details?.diff !== "string" || receipt.diff !== details.diff || diffData?.version !== 1
    || typeof stats?.added !== "number" || !Number.isSafeInteger(stats.added) || stats.added < 0
    || typeof stats.removed !== "number" || !Number.isSafeInteger(stats.removed) || stats.removed < 0) return undefined;
  const diffs = parts.filter(part => part.kind === "diff");
  if (diffs.length !== 1 || diffs[0]?.origin !== "reported" || diffs[0].representations.numbered !== details.diff) return undefined;

  const patch = diffs[0].representations.unified;
  const parsed = patch === undefined ? undefined : parseUnified(patch);
  const section = parsed?.sections[0];
  if (!parsed || parsed.scopeConflict || parsed.sections.length !== 1 || section?.kind !== "hunks"
    || section.target?.path !== path || section.target.moveTo !== undefined || section.hunks.length === 0) return undefined;
  let added = 0, removed = 0;
  for (const hunk of section.hunks) {
    for (const block of hunk.blocks) {
      if (block.kind === "change") {
        for (const pair of block.pairs) {
          if (pair.before) removed += 1;
          if (pair.after) added += 1;
        }
      } else if (block.kind !== "context") return undefined;
    }
  }
  if (added !== stats.added || removed !== stats.removed || added + removed === 0) return undefined;

  const content = result.content[0];
  if (content?.kind !== "text") return undefined;
  const text = content.text;
  const lineWord = Math.max(stats.added, stats.removed) === 1 ? "line" : "lines";
  const summary = `Edited ${path} (1 change, +${stats.added} -${stats.removed} ${lineWord})`;
  let prefix = "", separator = "", offset = 0;
  if (!text.startsWith(summary)) {
    if (!text.startsWith("[Context hygiene] ") || !object(details.contextHygiene)) return undefined;
    separator = text.includes("\r\n\r\n---\r\n") ? "\r\n\r\n---\r\n" : "\n\n---\n";
    const boundary = text.indexOf(separator);
    if (boundary < 0) return undefined;
    prefix = text.slice(0, boundary);
    offset = boundary + separator.length;
  }
  if (!text.startsWith(summary, offset)) return undefined;
  const suffix = text.slice(offset + summary.length);
  if (suffix && !suffix.startsWith("\n") && !suffix.startsWith("\r\n")) return undefined;
  return { kind: "edit-receipt", path, prefix, separator, summary, suffix };
}
