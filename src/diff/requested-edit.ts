import type { RequestedEdit } from "../presentation.ts";
import { compareText, splitLogicalLines } from "./compare.ts";
import type { ComparisonBudget } from "./compare.ts";
import type { DiffHunk } from "./model.ts";

export function requestedEditHunk(edit: RequestedEdit, budget: ComparisonBudget): { readonly hunk?: DiffHunk; readonly coarse: boolean } {
  if (!("kind" in edit)) return compareText(edit.oldText, edit.newText, budget);
  if (edit.kind === "symbol") return requestedEditHunk({ kind: "located", operation: "replace", path: edit.path,
    anchor: { token: `symbol ${edit.symbol}` }, newText: edit.newText }, budget);
  if (edit.kind === "transfer") {
    const source = `${edit.source.path ? `${edit.source.path} ` : ""}${edit.source.start}–${edit.source.end}`;
    const target = `${edit.destination.path ? `${edit.destination.path} ` : ""}${edit.destination.direction} ${edit.destination.anchor}`;
    const context = edit.contextPath ? ` · supplied path ${edit.contextPath}` : "";
    return { hunk: { blocks: [{ kind: "instruction", text: `${edit.operation === "copy" ? "Copy" : "Move"} ${source} → ${target}${context}` }] }, coarse: false };
  }
  if (edit.kind === "match") {
    const location = edit.range ? ` in ${edit.range.start}–${edit.range.end}` : "";
    const mode = `${edit.all ? "all matches" : "one match"}${edit.fuzzy ? ", fuzzy fallback" : ""}`;
    const compared = compareText(edit.oldText, edit.newText, budget);
    return { hunk: { blocks: [{ kind: "instruction", text: `Requested match${location} (${mode})` }, ...(compared.hunk?.blocks ?? [])] }, coarse: compared.coarse };
  }

  const label = edit.end && edit.end.token !== edit.anchor.token ? `${edit.anchor.token}–${edit.end.token}` : edit.anchor.token;
  const cells = edit.operation === "delete" ? [] : edit.newLines === undefined
    ? splitLogicalLines(edit.newText) : edit.newLines.map(text => ({ text, emphasis: [] }));
  const start = edit.anchor.line1 === undefined ? undefined
    : edit.anchor.line1 + (edit.operation === "insert-after" ? 1 : 0);
  const after = cells.map((cell, index) => {
    const line1 = start === undefined ? undefined : start + index;
    return { ...cell, ...(line1 !== undefined && Number.isSafeInteger(line1) && line1 > 0 ? { line1 } : {}),
      emphasis: cell.text.length ? [{ startUtf16: 0, endUtf16: cell.text.length }] : [] };
  });
  return { hunk: { blocks: [{ kind: "located-change", operation: edit.operation, locationLabel: label,
    ...(edit.anchor.line1 === undefined ? {} : { beforeLine1: edit.anchor.line1 }), after }] }, coarse: false };
}
