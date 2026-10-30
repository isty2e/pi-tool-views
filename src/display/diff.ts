import { backgroundAnsi, mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderDiffPresentation } from "../diff/index.ts";
import type { ChangedSpan, DiffCell, DiffPresentation, DiffSide } from "../diff/index.ts";
import type { ChangedLinePair } from "../diff/model.ts";
import type { Settings } from "../settings/model.ts";
import { isolateStyles, safeText } from "./text.ts";
import { coalescedEmphasis, pairedEmphasis } from "./emphasis.ts";
import type { DisplayCell } from "./emphasis.ts";
import { wrapPaintedColumns } from "./column-wrap.ts";
import { terminalControls } from "./terminal-controls.ts";

// Cache normalized facts only; display grouping depends on the current settings.
const displayCells = new WeakMap<DiffCell, DisplayCell>();

function displayCell(cell: DiffCell): DisplayCell {
  const cached = displayCells.get(cell);
  if (cached) return cached;
  const raw = cell.text;
  const offsets = new Uint32Array(raw.length + 1);
  let text = "";
  let previous = 0;
  for (const { startUtf16: start, endUtf16: end } of terminalControls(raw)) {
    for (let index = previous; index <= start; index++) offsets[index] = text.length + index - previous;
    text += raw.slice(previous, start);
    const replacement = raw[start] === "\t" ? "    " : raw[start] === "\r" ? "\n" : "";
    for (let index = start; index < end; index++) offsets[index] = text.length;
    text += replacement;
    previous = end;
  }
  for (let index = previous; index <= raw.length; index++) offsets[index] = text.length + index - previous;
  text += raw.slice(previous);
  const spans = cell.emphasis.flatMap(span => {
    const startUtf16 = offsets[span.startUtf16];
    const endUtf16 = offsets[span.endUtf16];
    return startUtf16 !== undefined && endUtf16 !== undefined && endUtf16 > startUtf16 ? [{ startUtf16, endUtf16 }] : [];
  });
  const value = { text, spans };
  displayCells.set(cell, value);
  return value;
}

function emphasize(syntax: string, spans: readonly ChangedSpan[], open: string): string {
  let text = "";
  let position = 0;
  let spanIndex = 0;
  let active = false;
  for (const match of syntax.matchAll(/\x1b\[[\d;:]*m|[\s\S]/gu)) {
    const token = match[0];
    if (token.startsWith("\x1b")) {
      text += token + (active ? open : "");
      continue;
    }
    while (spanIndex < spans.length && spans[spanIndex]!.endUtf16 <= position) spanIndex++;
    const span = spans[spanIndex];
    const changed = span !== undefined && span.startUtf16 <= position && span.endUtf16 > position;
    if (changed !== active) text += changed ? open : "\x1b[49m";
    active = changed;
    text += token;
    position += token.length;
  }
  return text + (active ? "\x1b[49m" : "");
}

export function renderToolDiff(plan: DiffPresentation, width: number, settings: Settings, theme: Theme, captionedPath?: string, operationCard = false, hideReportedHeading = false): string[] {
  const pairedSpans = new WeakMap<ChangedLinePair, ReturnType<typeof pairedEmphasis>>();
  let backgrounds: Readonly<Record<DiffSide, string>> | undefined;
  let subtleBackgrounds: Readonly<Record<DiffSide, string>> | undefined;
  try {
    const makeBackground = (side: DiffSide, amount: number) => backgroundAnsi(mixColors(
      theme.colors[side === "before" ? "toolDiffRemoved" : "toolDiffAdded"],
      theme.colors[side === "before" ? "toolErrorBg" : "toolSuccessBg"], amount, "srgb"), theme.getColorMode());
    backgrounds = { before: makeBackground("before", 0.8), after: makeBackground("after", 0.8) };
    subtleBackgrounds = { before: makeBackground("before", 0.94), after: makeBackground("after", 0.94) };
  } catch { /* A host without the palette API still receives the same text and layout. */ }
  const omitReportedHeading = plan.units.length > 0 && plan.units.every(unit => unit.origin === "reported"
    && unit.sections.every(section => section.target?.path || (unit.scope.kind === "file" && unit.scope.path)));
  const rows: string[] = [];
  let requestNotes = plan.requestNotes;
  for (const unit of plan.units) {
    let previousAnonymous = false;
    let sectionRendered = false;
    for (const section of unit.sections) {
      const path = section.target?.path ?? (unit.scope.kind === "file" ? unit.scope.path : undefined);
      const language = path ? getLanguageFromPath(path) : undefined;
      const one: DiffPresentation = { units: [{ ...unit, sections: [section] }], applicationReports: [], context: [], ...(requestNotes ? { requestNotes } : {}) };
      const redundantCaption = plan.units.length === 1 && unit.sections.length === 1
        && unit.origin === "reported" && path !== undefined && path === captionedPath
        && section.target?.moveTo === undefined && (unit.scope.kind !== "file" || unit.scope.moveTo === undefined)
        && (section.activity === undefined || section.activity === "updated");
      const paint = {
        highlightFlow(cells: readonly DiffCell[]) {
          const source = cells.map(cell => displayCell(cell).text);
          if (!language) return source.map(isolateStyles);
          try {
            const highlighted = highlightCode(source.join("\n"), language);
            return (highlighted.length === source.length ? highlighted : source).map(isolateStyles);
          }
          catch { return source.map(isolateStyles); }
        },
        applyChange(cell: DiffCell, syntax: string, _spans: readonly ChangedSpan[], side: DiffSide, pair?: ChangedLinePair) {
          if (!backgrounds) return isolateStyles(syntax);
          let spans: readonly ChangedSpan[];
          if (pair?.before && pair.after) {
            let grouped = pairedSpans.get(pair);
            if (!grouped) {
              grouped = pairedEmphasis(displayCell(pair.before), displayCell(pair.after), settings.diffEmphasisGap);
              pairedSpans.set(pair, grouped);
            }
            spans = grouped[side];
          } else spans = coalescedEmphasis(displayCell(cell), settings.diffEmphasisGap);
          return isolateStyles(emphasize(syntax, spans, backgrounds[side]));
        },
        gutter(text: string, side: DiffSide, changed: boolean) {
          const color = changed ? side === "before" ? "toolDiffRemoved" : "toolDiffAdded" : "dim";
          const background = changed ? subtleBackgrounds?.[side] ?? "" : "";
          return isolateStyles(background + theme.fg(color, text));
        },
        wholeRow(text: string, side: DiffSide) {
          const open = subtleBackgrounds?.[side];
          if (!open) return text;
          return open + text.replace(/\x1b\[(?:0|49)?m/g, sequence => sequence + open) + "\x1b[49m";
        },
      };
      const options = {
        layout: settings.diffMode === "native" ? "unified" as const : settings.diffMode,
        context: settings.diffContext, lineNumbers: settings.lineNumbers,
        showHeadings: !operationCard && !redundantCaption,
        hideReportedHeading: hideReportedHeading || omitReportedHeading || (sectionRendered && unit.origin === "reported"),
        wholeRowHighlight: settings.diffRowBackground, visibleWidth,
        wrapVisible: wrapPaintedColumns,
      };
      let rendered: string[];
      try {
        rendered = renderDiffPresentation(one, width, options, paint);
      } catch (error) {
        if (!(error instanceof RangeError) || settings.diffMode !== "split") throw error;
        rendered = renderDiffPresentation(one, width, { ...options, layout: "unified" }, paint);
        rendered.push(truncateToWidth(theme.fg("muted", "Split needs a wider terminal."), width));
      }
      const anonymous = unit.scope.kind === "call" && section.target === undefined;
      if (rendered.length && previousAnonymous && anonymous) rows.push("");
      rows.push(...rendered);
      if (rendered.length) {
        requestNotes = undefined;
        previousAnonymous = anonymous;
        sectionRendered = true;
      }
    }
  }
  return rows.map(line => truncateToWidth(safeText(line).replace(/\n/g, " "), Math.max(1, width)));
}
