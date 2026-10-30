export interface ColumnUnit { readonly text: string; readonly columns: number }
export type ColumnWrapper = (text: string, width: number) => readonly string[];

export function wrapColumnUnits(units: Iterable<ColumnUnit>, width: number): string[] {
  if (width <= 0) return [""];
  const rows: string[] = [];
  let parts: string[] = [], pending: string[] = [], columns = 0;

  for (const unit of units) {
    if (unit.columns === 0) { pending.push(unit.text); continue; }
    if (columns > 0 && columns + unit.columns > width) {
      rows.push(parts.join(""));
      parts = [];
      columns = 0;
    }
    if (pending.length) { parts.push(pending.join("")); pending = []; }
    parts.push(unit.text);
    columns += unit.columns;
  }

  if (pending.length) parts.push(pending.join(""));
  if (parts.length || !rows.length) rows.push(parts.join(""));
  return rows;
}

/** Retain caller-owned slicing semantics when no forward wrapper is supplied. */
export function wrapSlicedColumns(text: string, width: number, measure: (text: string) => number,
  slice: (text: string, start: number, end: number) => string): string[] {
  if (width <= 0) return [""];
  const total = measure(text);
  if (total <= width) return [text];
  const rows: string[] = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(total, start + width);
    let piece = slice(text, start, end);
    while (piece.length === 0 && end < total) { end += 1; piece = slice(text, start, Math.min(end, total)); }
    if (piece.length === 0) break;
    rows.push(piece);
    start += Math.max(1, measure(piece));
  }
  return rows.length === 0 ? [text] : rows;
}
