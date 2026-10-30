import type { RequestView, ResultView } from "../presentation.ts";
import type { DiffViewUnit } from "./model.ts";

/** Whether a complete receipt and a whole-call diff describe the same visible replacement pairs. */
export function reportedCoversRequestedEdits(request: RequestView, result: ResultView | undefined, units: readonly DiffViewUnit[]): boolean {
  if (request.kind !== "change.replacements" || request.requestedEdits.length < 2 || result?.completeEditReceipt !== true
    || result.parts.filter(part => part.kind === "diff").length !== 1 || units.length !== 1) return false;

  const diff = result.parts.find(part => part.kind === "diff");
  if (!diff || diff.kind !== "diff" || Object.values(diff.representations).filter(value => value !== undefined).length !== 1) return false;

  const unit = units[0]!;
  if (unit.origin !== "reported" || unit.coarseComparison) return false;
  const filePath = unit.scope.kind === "file" ? unit.scope.path : undefined;
  if (filePath !== undefined && request.requestedEdits.some(edit => edit.path !== filePath)) return false;

  const counts = new Map<string, number>();
  for (const edit of request.requestedEdits) {
    if ("kind" in edit) return false;
    if (!edit.path || !edit.oldText || !edit.newText || edit.oldText === edit.newText
      || /[\r\n]/.test(edit.oldText) || /[\r\n]/.test(edit.newText)) return false;
    const key = JSON.stringify([edit.oldText, edit.newText]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let seen = 0;
  for (const section of unit.sections) {
    if (section.kind !== "hunks" || !section.hunks.length) return false;
    if (unit.scope.kind === "call" && section.target !== undefined) return false;
    if (unit.scope.kind === "file" && (section.target?.path !== unit.scope.path || section.target.moveTo !== undefined)) return false;
    for (const hunk of section.hunks) {
      for (const block of hunk.blocks) {
        if (block.kind === "gap") return false;
        if (block.kind !== "change") continue;
        for (const pair of block.pairs) {
          if (!pair.before || !pair.after) return false;
          if (pair.before.text === pair.after.text) continue;
          const key = JSON.stringify([pair.before.text, pair.after.text]);
          const count = counts.get(key) ?? 0;
          if (count === 0) return false;
          counts.set(key, count - 1);
          seen++;
        }
      }
    }
  }
  return seen === request.requestedEdits.length && [...counts.values()].every(count => count === 0);
}
