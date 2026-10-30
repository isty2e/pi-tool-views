import type { ChangedSpan } from "../diff/model.ts";
export interface DisplayCell { readonly text: string; readonly spans: readonly ChangedSpan[] }
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function nearby(text: string, start: number, end: number, maximumGap: number): boolean {
  const gap = text.slice(start, end);
  if (!segmenter || gap.includes("\n")) return false;
  let distance = 0;
  for (const _ of segmenter.segment(gap)) if (++distance > maximumGap) return false;
  return true;
}

export function coalescedEmphasis(cell: DisplayCell, maximumGap: number): readonly ChangedSpan[] {
  if (!maximumGap || cell.spans.length < 2 || !segmenter) return cell.spans;
  const spans: ChangedSpan[] = [];
  let current = cell.spans[0]!;
  for (const next of cell.spans.slice(1)) {
    if (nearby(cell.text, current.endUtf16, next.startUtf16, maximumGap)) {
      current = { startUtf16: current.startUtf16, endUtf16: Math.max(current.endUtf16, next.endUtf16) };
    } else { spans.push(current); current = next; }
  }
  spans.push(current);
  return spans;
}

export function pairedEmphasis(before: DisplayCell, after: DisplayCell, maximumGap: number): Readonly<Record<"before" | "after", readonly ChangedSpan[]>> {
  const full = (cell: DisplayCell): readonly ChangedSpan[] => cell.text.length ? [{ startUtf16: 0, endUtf16: cell.text.length }] : [];
  const coarse = () => ({ before: full(before), after: full(after) });
  const partition = (cell: DisplayCell) => {
    const boundaries = segmenter ? new Set([0, cell.text.length, ...Array.from(segmenter.segment(cell.text), part => part.index)]) : undefined;
    const chunks: string[] = [], anchors: number[] = [];
    let previous = 0, removed = 0;
    for (const span of cell.spans) {
      if (span.startUtf16 < previous || (boundaries && (!boundaries.has(span.startUtf16) || !boundaries.has(span.endUtf16)))) return undefined;
      chunks.push(cell.text.slice(previous, span.startUtf16));
      anchors.push(span.startUtf16 - removed);
      removed += span.endUtf16 - span.startUtf16;
      previous = span.endUtf16;
    }
    chunks.push(cell.text.slice(previous));
    return { common: chunks.join(""), anchors, boundaries };
  };
  const old = partition(before), updated = partition(after);
  if (!old || !updated || old.common !== updated.common) return coarse();
  if (!maximumGap || !segmenter) return { before: before.spans, after: after.spans };

  const anchors = [...old.anchors, ...updated.anchors].sort((left, right) => left - right);
  const groups: { start: number; end: number }[] = [];
  for (const anchor of anchors) {
    const last = groups.at(-1);
    if (last && nearby(old.common, last.end, anchor, maximumGap)) last.end = anchor;
    else groups.push({ start: anchor, end: anchor });
  }

  const project = (cell: DisplayCell): readonly ChangedSpan[] => {
    const spans: ChangedSpan[] = [];
    let index = 0, removed = 0;
    for (const group of groups) {
      while (index < cell.spans.length && cell.spans[index]!.startUtf16 - removed < group.start) {
        const span = cell.spans[index++]!;
        removed += span.endUtf16 - span.startUtf16;
      }
      const startUtf16 = group.start + removed;
      while (index < cell.spans.length && cell.spans[index]!.startUtf16 - removed <= group.end) {
        const span = cell.spans[index++]!;
        removed += span.endUtf16 - span.startUtf16;
      }
      const endUtf16 = group.end + removed;
      if (endUtf16 > startUtf16) spans.push({ startUtf16, endUtf16 });
    }
    return spans;
  };
  const result = { before: project(before), after: project(after) };
  if (result.before.some(span => !old.boundaries?.has(span.startUtf16) || !old.boundaries?.has(span.endUtf16))
    || result.after.some(span => !updated.boundaries?.has(span.startUtf16) || !updated.boundaries?.has(span.endUtf16))) return coarse();
  return result;
}
