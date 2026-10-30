import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Json, ReportedLocation, ScopedApplicationReport, SourceText } from "../presentation.ts";
import { locationLabel } from "../location-label.ts";
import { terminalControls } from "./terminal-controls.ts";

export function applicationText(report: ScopedApplicationReport): string {
  const target = report.scope.kind === "call" ? "Call" : report.scope.path + (report.scope.moveTo ? ` → ${report.scope.moveTo}` : "");
  const outcome = report.outcome === "reported-complete" ? "reported complete"
    : report.outcome === "reported-partial" ? "reported partial result" : "reported failure";
  return `${target}: ${outcome}`;
}

export function locationQualifier(location: ReportedLocation, plural: boolean): string {
  const hasColumn = location.character !== undefined || location.endExclusive?.character !== undefined;
  const unit = hasColumn && location.characterUnit === "utf16" ? `UTF-16 column${plural ? "s" : ""}` : "";
  return [unit, location.endExclusive ? "end exclusive" : ""].filter(Boolean).join("; ");
}

export function locationText(location: ReportedLocation): string {
  const target = location.target.kind === "file" ? location.target.path : location.target.uri;
  const adjustment = location.indexBase === 0 ? 1 : 0;
  const character = location.character === undefined ? "" : `:${location.character + adjustment}`;
  const end = location.endExclusive ? `–${location.endExclusive.line + adjustment}${location.endExclusive.character === undefined ? "" : `:${location.endExclusive.character + adjustment}`}` : "";
  const note = locationQualifier(location, location.endExclusive !== undefined);
  return `${target}:${location.line + adjustment}${character}${end}${note ? ` (${note})` : ""}`;
}

export function previewJson(value: Json, limit: number): { readonly text: string; readonly clipped: boolean } {
  let text = "";
  let clipped = false;
  const append = (piece: string) => {
    const remaining = Math.max(0, limit - text.length);
    if (piece.length > remaining) clipped = true;
    text += piece.slice(0, remaining);
  };
  const visit = (item: Json, depth: number): void => {
    if (text.length >= limit || depth > 128) { clipped = true; return; }
    if (typeof item === "string") {
      const remaining = limit - text.length;
      let prefix = item.slice(0, remaining);
      if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length < item.length) clipped = true;
      append(JSON.stringify(prefix));
    } else if (item === null || typeof item !== "object") append(JSON.stringify(item));
    else if (Array.isArray(item)) {
      append("[");
      for (let index = 0; index < item.length; index++) {
        if (text.length >= limit) { clipped = true; break; }
        if (index) append(",");
        visit(item[index]!, depth + 1);
      }
      append("]");
    } else {
      append("{");
      let first = true;
      for (const key of Object.keys(item)) {
        if (text.length >= limit) { clipped = true; break; }
        if (!first) append(",");
        first = false;
        visit(key, depth + 1);
        append(":");
        visit((item as { readonly [key: string]: Json })[key]!, depth + 1);
      }
      append("}");
    }
  };
  visit(value, 0);
  return { text: text + (clipped ? "…" : ""), clipped };
}

export function safeText(text: string, keepColor = true): string {
  const parts: string[] = [];
  let previous = 0;
  for (const { startUtf16, endUtf16 } of terminalControls(text)) {
    const sequence = text.slice(startUtf16, endUtf16);
    parts.push(text.slice(previous, startUtf16));
    if (sequence === "\x1b" || (keepColor && /^\x1b\[[\d;:]*m$/.test(sequence))) parts.push(sequence);
    else if (sequence === "\t") parts.push("    ");
    else if (sequence[0] === "\r") parts.push("\n");
    previous = endUtf16;
  }
  parts.push(text.slice(previous));
  // Stray ESC cleanup follows control removal, preserving the established malformed-input interpretation.
  return parts.join("").replace(/\x1b(?!\[[\d;:]*m)/g, "");
}

export function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(safeText(text), Math.max(1, width));
}

/** Hang continuations under a renderer-owned prefix; fall back if that layout cannot fit. */
export function wrapPrefixed(text: string, width: number, prefix: string): string[] {
  const label = safeText(prefix);
  const full = label + safeText(text);
  const columns = visibleWidth(label);
  const available = Math.max(1, width);
  if (!columns || columns >= available || label.includes("\n")) return wrapTextWithAnsi(full, available);
  const body = sliceByColumn(full, columns, Number.MAX_SAFE_INTEGER);
  const rows = wrapTextWithAnsi(body, available - columns);
  if (rows.some(row => visibleWidth(row) > available - columns)) return wrapTextWithAnsi(full, available);
  return rows.map((row, index) => (index === 0 ? label : " ".repeat(columns)) + row);
}

export function isolateStyles(text: string): string {
  return `\x1b[0m${text}\x1b[0m`;
}

export function compactTarget(text: string, width: number, home = ""): string {
  let value = safeText(text, false).replace(/\n/g, " ");
  if (home && (value === home || value.startsWith(`${home}/`))) value = `~${value.slice(home.length)}`;
  if (visibleWidth(value) <= width) return value;
  if (width < 3) return truncateToWidth(value, Math.max(1, width));
  const first = Math.min(Math.floor(width / 3), Math.max(1, value.indexOf("/") + 1));
  const tail = Math.max(1, width - first - 1);
  return `${sliceByColumn(value, 0, first)}…${sliceByColumn(value, Math.max(0, visibleWidth(value) - tail), tail)}`;
}

export function sourceLines(source: SourceText, path: string | undefined, width: number,
  numbered: boolean, theme: Theme, minimumLabelWidth = 0): string[] {
  const raw = safeText(source.text, false);
  const language = source.language ?? (path ? getLanguageFromPath(path) : undefined);
  let highlighted: string[];
  try { highlighted = language ? highlightCode(raw, language) : raw.split("\n"); }
  catch { highlighted = raw.split("\n"); }
  const start = typeof source.firstLine1 === "number" && Number.isSafeInteger(source.firstLine1) && source.firstLine1 > 0
    ? source.firstLine1 : undefined;
  const identifiers = source.lineIdentifiers?.length === highlighted.length ? source.lineIdentifiers : undefined;
  const labels = numbered && start !== undefined ? highlighted.map((_, index) => locationLabel(start + index, identifiers?.[index])) : [];
  const digits = labels.reduce((max, label) => Math.max(max, visibleWidth(label)), labels.length ? minimumLabelWidth : 0);
  const gutter = digits ? digits + 1 : 0;
  if (width <= gutter) return highlighted.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)).map(isolateStyles));

  return highlighted.flatMap((line, index) => {
    const rows = line ? wrapTextWithAnsi(line, Math.max(1, width - gutter)) : [""];
    return rows.map((row, continuation) => {
      const label = labels[index] ?? "";
      const prefix = digits ? continuation === 0 ? `${" ".repeat(Math.max(0, digits - visibleWidth(label)))}${label} ` : " ".repeat(gutter) : "";
      return isolateStyles(theme.fg("dim", prefix)) + isolateStyles(row);
    });
  });
}


export interface ClippedRows { readonly lines: readonly string[]; readonly omitted: number }

export function clipRows(lines: readonly string[], budget: number | null, mode: "head" | "tail" | "head-tail"): ClippedRows {
  if (budget === null || lines.length <= budget) return { lines, omitted: 0 };
  if (budget <= 0) return { lines: [], omitted: lines.length };
  const kept = Math.max(0, budget - 1);
  const omitted = lines.length - kept;
  const marker = `… ${omitted} rows hidden by preview`;
  if (mode === "head") return { lines: [...lines.slice(0, kept), marker], omitted };
  if (mode === "tail") return { lines: [marker, ...lines.slice(lines.length - kept)], omitted };
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return { lines: [...lines.slice(0, head), marker, ...(tail ? lines.slice(-tail) : [])], omitted };
}
