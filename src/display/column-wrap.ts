import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { wrapColumnUnits, wrapSlicedColumns } from "../diff/column-wrap.ts";
import type { ColumnUnit } from "../diff/column-wrap.ts";
import { isolateStyles } from "./text.ts";

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
const styles = /\x1b(?:\[[0-9;]*m|\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/g;
const unsupportedText = /[\x00-\x1f\x7f-\x9f]/;
const attributes = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 22, 23, 24, 25, 27, 28, 29, 39, 49]);

function canReopenStyle(style: string): boolean {
  if (style.startsWith("\x1b]8;")) {
    const payload = style.slice(4, style.endsWith("\x07") ? -1 : -2);
    return payload.includes(";") && !unsupportedText.test(payload);
  }
  const body = style.slice(2, -1);
  if (!body) return true;
  const parts = body.split(";");
  if (parts.some(part => !part)) return false;

  for (let index = 0; index < parts.length; index++) {
    const code = Number(parts[index]);
    if (code === 38 || code === 48) {
      const size = parts[index + 1] === "2" ? 3 : parts[index + 1] === "5" ? 1 : 0;
      const values = parts.slice(index + 2, index + 2 + size).map(Number);
      if (!size || values.length !== size || values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
      index += size + 1;
    } else if (!attributes.has(code) && !(code >= 30 && code <= 37) && !(code >= 40 && code <= 47)
      && !(code >= 90 && code <= 97) && !(code >= 100 && code <= 107)) return false;
  }
  return true;
}

function paintedUnits(text: string): Iterable<ColumnUnit> | undefined {
  if (!segmenter) return undefined;
  const chunks: string[] = [];
  const escapes: { readonly at: number; readonly length: number }[] = [];
  let at = 0, plainLength = 0;
  for (const match of text.matchAll(styles)) {
    const plain = text.slice(at, match.index);
    if (unsupportedText.test(plain) || !canReopenStyle(match[0])) return undefined;
    chunks.push(plain);
    plainLength += plain.length;
    escapes.push({ at: plainLength, length: match[0].length });
    at = match.index + match[0].length;
  }
  const tail = text.slice(at);
  if (unsupportedText.test(tail)) return undefined;
  chunks.push(tail);
  const plain = chunks.join("");
  const graphemes = segmenter.segment(plain);

  return (function* (): Iterable<ColumnUnit> {
    let cursor = 0, removed = 0, index = 0;
    for (const part of graphemes) {
      const end = part.index + part.segment.length;
      while (index < escapes.length && escapes[index]!.at < end) removed += escapes[index++]!.length;
      const rawEnd = end + removed;
      yield { text: text.slice(cursor, rawEnd), columns: visibleWidth(part.segment) };
      cursor = rawEnd;
    }
    if (cursor < text.length) yield { text: text.slice(cursor), columns: 0 };
  })();
}

function closeLink(row: string): string {
  let terminator: string | undefined;
  for (const match of row.matchAll(styles)) {
    if (match[0].startsWith("\x1b]8;")) terminator = match[0].endsWith("\x07") ? "\x07" : "\x1b\\";
  }
  return terminator ? `\x1b]8;;${terminator}` : "";
}

export function wrapPaintedColumns(text: string, width: number): readonly string[] {
  if (width <= 0) return [""];
  if (visibleWidth(text) <= width) return [text];
  const units = paintedUnits(text);
  // SDK 1.4 cannot reopen every SGR variant; preserve opaque styles through the existing slicer.
  if (!units) return wrapSlicedColumns(text, width, visibleWidth,
    (value, start, end) => isolateStyles(sliceByColumn(value, start, end - start, true)));

  const rows = wrapColumnUnits(units, width);
  const styleWidth = rows.reduce((maximum, row) => Math.max(maximum, visibleWidth(row)), width);
  return wrapTextWithAnsi(rows.join("\n"), styleWidth).map(row => isolateStyles(row + closeLink(row)));
}
