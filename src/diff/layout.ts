import type { DiffBlock, DiffCell, DiffHunk, DiffPresentation, DiffSection, DiffViewUnit } from "./model.ts";
import type { ChangedLinePair, ChangedSpan } from "./model.ts";
import { wrapColumnUnits, wrapSlicedColumns } from "./column-wrap.ts";
import type { ColumnUnit, ColumnWrapper } from "./column-wrap.ts";
import type { DisplayBlock, ObservedHunks } from "./observed-context.ts";

export type DiffLayout = "unified" | "split" | "auto";
export type DiffSide = "before" | "after";

export interface DiffLayoutOptions {
  /** Selects one-column, two-column, or width/content-adaptive rendering. Defaults to Auto. */
  readonly layout?: DiffLayout;
  /** Maximum supplied context lines to retain on either side of each change; zero is valid. */
  readonly context?: number;
  /** Auto selects Split only when each pane has at least this much content width. */
  readonly autoSplitMinContentWidth?: number;
  /** Highlights the complete visual row instead of only changed text spans. */
  readonly wholeRowHighlight?: boolean;
  readonly lineNumbers?: boolean;
  /** Enables provenance and file captions; defaults to true. */
  readonly showHeadings?: boolean;
  readonly hideReportedHeading?: boolean;
  /** Measures terminal columns; provide this for ANSI-colored paint output. */
  readonly visibleWidth?: (text: string) => number;
  /** Slices terminal columns for custom geometry when no forward wrapper is supplied. */
  readonly sliceVisible?: (text: string, startColumn: number, endColumn: number) => string;
  /** Wraps columns consistently with visibleWidth; omitted custom wrappers retain slicing behavior. */
  readonly wrapVisible?: ColumnWrapper;
  readonly observed?: ObservedHunks;
}

export interface DiffPaint {
  /** Highlights each independent old or new source stream, returning one painted string per input cell. */
  readonly highlightFlow?: (cells: readonly DiffCell[], side: DiffSide) => readonly string[];
  /** Applies backgrounds after syntax highlighting and before padding or wrapping.
   * A paired cell may have no original spans because its partner broadens emphasis. */
  readonly applyChange?: (cell: DiffCell, syntaxText: string, spans: readonly ChangedSpan[], side: DiffSide, pair?: ChangedLinePair) => string;
  /** Styles the marker and line-number gutter independently of source characters. */
  readonly gutter?: (text: string, side: DiffSide, changed: boolean) => string;
  /** Applies optional row-wide styling after layout has added the row's available padding. */
  readonly wholeRow?: (row: string, side: DiffSide, width: number) => string;
}

interface VisibleBlock {
  readonly block: DisplayBlock;
  readonly index: number;
}

interface DrawLine {
  readonly cell?: DiffCell;
  readonly side: DiffSide;
  readonly marker: " " | "+" | "-";
  readonly number?: number;
  readonly changed: boolean;
  readonly syntaxText: string;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
const graphemes = (text: string) => graphemeSegmenter?.segment(text) ?? Array.from(text, segment => ({ segment }));

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}/u.test(value) || value.includes("\u200d") || /[\u{1f1e6}-\u{1f1ff}]/u.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (/\p{Mark}/u.test(character) || codePoint === 0xfe0f || codePoint === 0xfe0e || codePoint === 0x200d) continue;
    width = Math.max(width, isWide(codePoint) ? 2 : 1);
  }
  return width;
}

function defaultVisibleWidth(text: string): number {
  let width = 0;
  for (const item of graphemes(text)) width += graphemeWidth(item.segment);
  return width;
}

function defaultSliceVisible(text: string, startColumn: number, endColumn: number): string {
  let column = 0;
  let output = "";
  for (const item of graphemes(text)) {
    const width = graphemeWidth(item.segment);
    const end = column + width;
    if (column >= startColumn && end <= endColumn) output += item.segment;
    column = end;
  }
  return output;
}

function integerOption(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function contextWindow(hunk: DiffHunk, radius: number, observed?: ObservedHunks): VisibleBlock[] {
  const blocks = observed?.get(hunk)?.blocks ?? hunk.blocks;
  const keep = new Set<number>();
  blocks.forEach((block, index) => {
    if (block.kind !== "change" && block.kind !== "located-change") return;
    keep.add(index);

    for (const direction of [-1, 1]) {
      for (let distance = 1; distance <= radius; distance += 1) {
        const candidateIndex = index + direction * distance;
        const candidate = blocks[candidateIndex];
        if (candidate?.kind !== "context" && candidate?.kind !== "observed-context") break;
        keep.add(candidateIndex);
      }
    }
  });

  return blocks.flatMap((block, index) =>
    block.kind === "gap" || block.kind === "instruction" || keep.has(index) ? [{ block, index }] : [],
  );
}

function contextCell(block: Extract<DiffBlock, { readonly kind: "context" }>, side: DiffSide): DiffCell {
  const line1 = side === "before" ? block.oldLine1 : block.newLine1;
  return {
    text: block.text,
    ...(line1 === undefined ? {} : { line1 }),
    ...(side === "after" && block.newLabel !== undefined ? { locationLabel: block.newLabel } : {}),
    ...(block.lineEnding === undefined ? {} : { lineEnding: block.lineEnding }),
    emphasis: [],
  };
}

function cellFlows(visible: readonly VisibleBlock[], paint: DiffPaint | undefined): {
  readonly before: ReadonlyMap<DiffCell, string>;
  readonly after: ReadonlyMap<DiffCell, string>;
  readonly beforeContext: ReadonlyMap<DiffBlock, DiffCell>;
  readonly afterContext: ReadonlyMap<DiffBlock, DiffCell>;
} {
  const before = new Map<DiffCell, string>();
  const after = new Map<DiffCell, string>();
  const beforeContext = new Map<DiffBlock, DiffCell>();
  const afterContext = new Map<DiffBlock, DiffCell>();
  let segment: VisibleBlock[] = [];

  const flush = (): void => {
    if (segment.length === 0) return;
    const oldCells: DiffCell[] = [];
    const newCells: DiffCell[] = [];
    for (const { block } of segment) {
      if (block.kind === "context") {
        const oldCell = contextCell(block, "before");
        const newCell = contextCell(block, "after");
        beforeContext.set(block, oldCell);
        afterContext.set(block, newCell);
        oldCells.push(oldCell);
        newCells.push(newCell);
      } else if (block.kind === "observed-context") {
        if (block.before) oldCells.push(block.before);
        if (block.after) newCells.push(block.after);
      } else if (block.kind === "change") {
        for (const pair of block.pairs) {
          if (pair.before !== undefined) oldCells.push(pair.before);
          if (pair.after !== undefined) newCells.push(pair.after);
        }
      } else if (block.kind === "located-change") {
        newCells.push(...block.after);
      }
    }

    const oldPaint = oldCells.length === 0 ? [] : paint?.highlightFlow?.(oldCells, "before") ?? oldCells.map((cell) => cell.text);
    const newPaint = newCells.length === 0 ? [] : paint?.highlightFlow?.(newCells, "after") ?? newCells.map((cell) => cell.text);
    if (oldPaint.length !== oldCells.length || newPaint.length !== newCells.length) {
      throw new RangeError("highlightFlow must return exactly one string for each input cell");
    }
    oldCells.forEach((cell, index) => before.set(cell, oldPaint[index]!));
    newCells.forEach((cell, index) => after.set(cell, newPaint[index]!));
    segment = [];
  };

  let previousIndex: number | undefined;
  for (const item of visible) {
    if (item.block.kind === "gap" || item.block.kind === "instruction" || (previousIndex !== undefined && item.index !== previousIndex + 1)) flush();
    if (item.block.kind === "gap" || item.block.kind === "instruction") {
      previousIndex = item.index;
      continue;
    }
    segment.push(item);
    previousIndex = item.index;
  }
  flush();
  return { before, after, beforeContext, afterContext };
}

function storedContextCell(
  block: Extract<DiffBlock, { readonly kind: "context" }>,
  side: DiffSide,
  flows: ReturnType<typeof cellFlows>,
): DiffCell {
  return (side === "before" ? flows.beforeContext : flows.afterContext).get(block) ?? contextCell(block, side);
}

function textForCell(cell: DiffCell, side: DiffSide, flows: ReturnType<typeof cellFlows>, paint: DiffPaint | undefined, changed: boolean, pair?: ChangedLinePair): string {
  const syntaxText = (side === "before" ? flows.before : flows.after).get(cell) ?? cell.text;
  return changed && (cell.emphasis.length > 0 || pair !== undefined) && paint?.applyChange !== undefined
    ? paint.applyChange(cell, syntaxText, cell.emphasis, side, pair)
    : syntaxText;
}

function defaultWrapColumns(text: string, width: number): readonly string[] {
  if (width <= 0) return [""];
  if (defaultVisibleWidth(text) <= width) return [text];

  function* units(): Iterable<ColumnUnit> {
    for (const part of graphemes(text)) yield { text: part.segment, columns: graphemeWidth(part.segment) };
  }
  return wrapColumnUnits(units(), width);
}

function gutterWidth(presentation: DiffPresentation, lineNumbers: boolean, observed?: ObservedHunks): number {
  if (!lineNumbers) return 2;
  let digits = 1;
  for (const unit of presentation.units) {
    for (const section of unit.sections) {
      if (section.kind !== "hunks") continue;
      for (const hunk of section.hunks) {
        for (const block of observed?.get(hunk)?.blocks ?? hunk.blocks) {
          if (block.kind === "context") {
            digits = Math.max(digits, String(block.oldLine1 ?? "").length, String(block.newLine1 ?? "").length, (block.newLabel ?? "").length);
          } else if (block.kind === "observed-context") {
            digits = Math.max(digits, cellLabel(block.before).length, cellLabel(block.after).length);
          } else if (block.kind === "change") {
            for (const pair of block.pairs) {
              digits = Math.max(digits, cellLabel(pair.before).length, cellLabel(pair.after).length);
            }
          } else if (block.kind === "located-change") {
            digits = Math.max(digits, block.locationLabel.length);
            for (const cell of block.after) digits = Math.max(digits, cellLabel(cell).length);
          }
        }
      }
    }
  }
  return digits + 3;
}

function headerText(section: DiffSection, unit: DiffViewUnit): string | undefined {
  const target = section.target ?? (unit.scope.kind === "file" ? { path: unit.scope.path, ...(unit.scope.moveTo === undefined ? {} : { moveTo: unit.scope.moveTo }) } : undefined);
  if (target === undefined) return undefined;
  const path = target.moveTo === undefined ? target.path : `${target.path} → ${target.moveTo}`;
  return section.activity === undefined ? path : `${path} · ${section.activity}`;
}

function rawLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    lines.push(text.slice(start, index));
    if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return text.length === 0 ? [""] : lines;
}

function cellLabel(cell: DiffCell | undefined): string {
  if (!cell) return "";
  return cell.locationLabel ?? String(cell.line1 ?? "");
}

function lineDraw(cell: DiffCell | undefined, side: DiffSide, marker: " " | "+" | "-", changed: boolean, number: number | undefined, flows: ReturnType<typeof cellFlows>, paint: DiffPaint | undefined, pair?: ChangedLinePair): DrawLine {
  return {
    ...(cell === undefined ? {} : { cell }),
    side,
    marker,
    ...(number === undefined ? {} : { number }),
    changed,
    syntaxText: cell === undefined ? "" : textForCell(cell, side, flows, paint, changed, pair),
  };
}

function wrapDrawLine(draw: DrawLine, width: number, widths: UnifiedGutterWidths, measure: (text: string) => number, wrap: ColumnWrapper, paint: DiffPaint | undefined, contextOldLine1?: number): string[] {
  const label = cellLabel(draw.cell) || draw.number;
  const oldLabel = draw.side === "before" ? label : contextOldLine1;
  const newLabel = draw.side === "after" ? label : undefined;
  const field = (value: number | string | undefined, fieldWidth: number): string => {
    const text = value === undefined ? "" : String(value);
    return (text.length <= fieldWidth ? text : "").padStart(fieldWidth, " ");
  };
  const prefix = widths.before > 0 ? `${field(oldLabel, widths.before)} ${field(newLabel, widths.after)} ${draw.marker} `
    : width <= 2 ? draw.marker : `${draw.marker} `;
  const contentWidth = Math.max(0, width - measure(prefix));
  const pieces = wrap(draw.syntaxText, contentWidth);
  return pieces.map((piece, index) => {
    const gutter = index === 0 ? prefix : " ".repeat(measure(prefix));
    return `${paint?.gutter?.(gutter, draw.side, draw.changed) ?? gutter}${piece}`;
  });
}

function applyWholeRow(rows: string[], draw: DrawLine, enabled: boolean, paint: DiffPaint | undefined, width: number, measure: (text: string) => number): string[] {
  if (!enabled || !draw.changed || paint?.wholeRow === undefined) return rows;
  return rows.map((row) => paint.wholeRow!(row + " ".repeat(Math.max(0, width - measure(row))), draw.side, width));
}

function renderUnifiedHunk(
  hunk: DiffHunk,
  radius: number,
  width: number,
  widths: UnifiedGutterWidths,
  measure: (text: string) => number,
  wrap: ColumnWrapper,
  wholeRow: boolean,
  paint: DiffPaint | undefined,
  observed: ObservedHunks | undefined,
): string[] {
  const visible = contextWindow(hunk, radius, observed);
  const flows = cellFlows(visible, paint);
  const rows: string[] = [];

  for (const { block } of visible) {
    if (block.kind === "gap") {
      rows.push(block.label ?? "…");
      continue;
    }
    if (block.kind === "instruction") {
      rows.push(...wrap(block.text, width));
      continue;
    }

    if (block.kind === "context") {
      const cell = storedContextCell(block, "after", flows);
      const draw = lineDraw(cell, "after", " ", false, block.newLine1, flows, paint);
      rows.push(...wrapDrawLine(draw, width, widths, measure, wrap, paint, block.oldLine1));
      continue;
    }

    if (block.kind === "observed-context") {
      if (block.before && block.after && block.before.text === block.after.text && block.before.lineEnding === block.after.lineEnding) {
        const draw = lineDraw(block.after, "after", " ", false, block.after.line1, flows, paint);
        rows.push(...wrapDrawLine(draw, width, widths, measure, wrap, paint, block.before.line1));
      } else {
        for (const side of ["before", "after"] as const) {
          const cell = block[side];
          if (!cell) continue;
          rows.push(...wrapDrawLine(lineDraw(cell, side, " ", false, cell.line1, flows, paint), width, widths, measure, wrap, paint));
        }
      }
      continue;
    }

    if (block.kind === "located-change") {
      if (block.operation === "replace" || block.operation === "delete") {
        const cell: DiffCell = { text: "…", locationLabel: block.locationLabel, emphasis: [] };
        const draw = lineDraw(cell, "before", "-", true, block.beforeLine1, flows, paint);
        rows.push(...applyWholeRow(wrapDrawLine(draw, width, widths, measure, wrap, paint), draw, wholeRow, paint, width, measure));
      } else {
        rows.push(...wrap(`Insert ${block.operation === "insert-before" ? "before" : "after"} ${block.locationLabel}`, width));
      }
      for (const cell of block.after) {
        const draw = lineDraw(cell, "after", "+", true, undefined, flows, paint);
        rows.push(...applyWholeRow(wrapDrawLine(draw, width, widths, measure, wrap, paint), draw, wholeRow, paint, width, measure));
      }
      continue;
    }

    for (const pair of block.pairs) {
      if (pair.before !== undefined) {
        const draw = lineDraw(pair.before, "before", "-", true, pair.before.line1, flows, paint, pair);
        rows.push(...applyWholeRow(wrapDrawLine(draw, width, widths, measure, wrap, paint), draw, wholeRow, paint, width, measure));
      }
    }
    for (const pair of block.pairs) {
      if (pair.after !== undefined) {
        const draw = lineDraw(pair.after, "after", "+", true, pair.after.line1, flows, paint, pair);
        rows.push(...applyWholeRow(wrapDrawLine(draw, width, widths, measure, wrap, paint), draw, wholeRow, paint, width, measure));
      }
    }
  }
  return rows;
}

function renderSplitHunk(
  hunk: DiffHunk,
  radius: number,
  width: number,
  gutter: number,
  measure: (text: string) => number,
  wrap: ColumnWrapper,
  wholeRow: boolean,
  paint: DiffPaint | undefined,
  observed: ObservedHunks | undefined,
): string[] {
  const visible = contextWindow(hunk, radius, observed);
  const flows = cellFlows(visible, paint);
  const separator = "│";
  const contentWidth = Math.max(0, Math.floor((width - measure(separator) - gutter * 2) / 2));
  const rows: string[] = [];

  const appendPair = (before: DiffCell | undefined, after: DiffCell | undefined, changed: boolean, beforeNumber: number | undefined, afterNumber: number | undefined, pair?: ChangedLinePair): void => {
    const leftDraw = lineDraw(before, "before", before === undefined ? " " : changed ? "-" : " ", changed && before !== undefined, beforeNumber, flows, paint, pair);
    const rightDraw = lineDraw(after, "after", after === undefined ? " " : changed ? "+" : " ", changed && after !== undefined, afterNumber, flows, paint, pair);
    const leftText = wrap(leftDraw.syntaxText, contentWidth);
    const rightText = wrap(rightDraw.syntaxText, contentWidth);
    const rowCount = Math.max(leftText.length, rightText.length);

    for (let index = 0; index < rowCount; index += 1) {
      const leftPrefix = before === undefined || index > 0 ? " ".repeat(gutter) : gutterForPane(leftDraw.marker, cellLabel(before) || beforeNumber, gutter);
      const rightPrefix = after === undefined || index > 0 ? " ".repeat(gutter) : gutterForPane(rightDraw.marker, cellLabel(after) || afterNumber, gutter);
      let leftPart = `${paint?.gutter?.(leftPrefix, "before", leftDraw.changed) ?? leftPrefix}${leftText[index] ?? ""}${" ".repeat(Math.max(0, contentWidth - measure(leftText[index] ?? "")))}`;
      let rightPart = `${paint?.gutter?.(rightPrefix, "after", rightDraw.changed) ?? rightPrefix}${rightText[index] ?? ""}${" ".repeat(Math.max(0, contentWidth - measure(rightText[index] ?? "")))}`;
      if (wholeRow && paint?.wholeRow !== undefined) {
        if (leftDraw.changed) leftPart = paint.wholeRow(leftPart, "before", measure(leftPart));
        if (rightDraw.changed) rightPart = paint.wholeRow(rightPart, "after", measure(rightPart));
      }
      const row = `${leftPart}${separator}${rightPart}`;
      if (measure(row) > width) throw new RangeError("Split cannot fit the supplied grapheme at this width.");
      rows.push(row);
    }
  };

  for (const { block } of visible) {
    if (block.kind === "gap") {
      rows.push(block.label ?? "…");
      continue;
    }
    if (block.kind === "instruction") {
      rows.push(...wrap(block.text, width));
      continue;
    }

    if (block.kind === "context") {
      appendPair(storedContextCell(block, "before", flows), storedContextCell(block, "after", flows), false, block.oldLine1, block.newLine1);
      continue;
    }
    if (block.kind === "observed-context") {
      appendPair(block.before, block.after, false, block.before?.line1, block.after?.line1);
      continue;
    }
    if (block.kind === "located-change") {
      if (block.operation === "insert-before" || block.operation === "insert-after") {
        rows.push(...wrap(`Insert ${block.operation === "insert-before" ? "before" : "after"} ${block.locationLabel}`, width));
      }
      const before: DiffCell | undefined = block.operation === "replace" || block.operation === "delete"
        ? { text: "…", locationLabel: block.locationLabel, emphasis: [] } : undefined;
      const count = Math.max(before ? 1 : 0, block.after.length);
      for (let index = 0; index < count; index += 1) appendPair(index === 0 ? before : undefined, block.after[index], true, undefined, undefined);
      continue;
    }
    for (const pair of block.pairs) {
      appendPair(pair.before, pair.after, true, pair.before?.line1, pair.after?.line1, pair);
    }
  }
  return rows;
}

function gutterForPane(marker: " " | "+" | "-", line1: number | string | undefined, width: number): string {
  if (width === 0) return "";
  if (width === 1) return marker;
  if (width === 2) return `${marker} `;
  const digitWidth = Math.max(0, width - 3);
  const number = line1 === undefined || String(line1).length > digitWidth ? " ".repeat(digitWidth) : String(line1).padStart(digitWidth, " ");
  return `${number} ${marker} `;
}

function renderSection(
  unit: DiffViewUnit,
  section: DiffSection,
  width: number,
  mode: "unified" | "split",
  radius: number,
  baseGutter: number,
  unifiedWidths: UnifiedGutterWidths,
  measure: (text: string) => number,
  wrap: ColumnWrapper,
  wholeRow: boolean,
  paint: DiffPaint | undefined,
  showHeadings: boolean,
  observed: ObservedHunks | undefined,
): string[] {
  const rows: string[] = [];
  const header = headerText(section, unit);
  if (showHeadings && header !== undefined) rows.push(...wrap(header, width));

  if (section.kind === "raw") {
    for (const source of section.sources) {
      for (const line of rawLines(source.text)) rows.push(...wrap(line, width));
    }
    return rows;
  }

  for (const hunk of section.hunks) {
    rows.push(...(mode === "unified"
      ? renderUnifiedHunk(hunk, radius, width, unifiedWidths, measure, wrap, wholeRow, paint, observed)
      : renderSplitHunk(hunk, radius, width, baseGutter, measure, wrap, wholeRow, paint, observed)));
  }
  return rows;
}

function hasPairedChange(section: DiffSection): boolean {
  return section.kind === "hunks" && section.hunks.some(hunk => hunk.blocks.some(block =>
    block.kind === "change" && block.pairs.some(pair => pair.before !== undefined && pair.after !== undefined)));
}

/** Render a compiled presentation without reparsing or changing its source selection. */
export function renderDiffPresentation(
  presentation: DiffPresentation,
  width: number,
  options: DiffLayoutOptions = {},
  paint?: DiffPaint,
): string[] {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("width must be a positive integer");
  const radius = integerOption(options.context, 3, 0, Number.MAX_SAFE_INTEGER, "context");
  const minimum = integerOption(options.autoSplitMinContentWidth, 24, 1, 100, "autoSplitMinContentWidth");
  const requestedMode = options.layout ?? "auto";
  const measure = options.visibleWidth ?? defaultVisibleWidth;
  const slice = options.sliceVisible ?? defaultSliceVisible;
  const wrap: ColumnWrapper = options.wrapVisible ?? (options.visibleWidth || options.sliceVisible
    ? (text, columns) => wrapSlicedColumns(text, columns, measure, slice) : defaultWrapColumns);
  const fullGutter = gutterWidth(presentation, options.lineNumbers !== false, options.observed);
  const splitGutter = Math.min(fullGutter, Math.max(0, Math.floor((width - 5) / 2)));
  const gutter = requestedMode === "split" ? splitGutter : Math.min(fullGutter, Math.max(0, width - 1));
  const splitContent = Math.floor((width - measure("│") - gutter * 2) / 2);
  const containsHunks = presentation.units.some((unit) => unit.sections.some((section) => section.kind === "hunks" && section.hunks.length > 0));
  if (requestedMode === "split" && containsHunks && splitContent < 1) {
    throw new RangeError("Split layout needs at least one content column in each pane");
  }
  const mode: "unified" | "split" = requestedMode === "unified"
    ? "unified"
    : requestedMode === "split"
      ? "split"
      : splitContent >= minimum ? "split" : "unified";

  const unifiedWidths = requestedMode !== "split" ? unifiedGutterWidths(presentation, width, radius, options.lineNumbers !== false, options.observed) : { before: 0, after: 0 };
  const rows: string[] = [];
  for (const note of presentation.requestNotes ?? []) rows.push(...wrap(note, width));

  for (const unit of presentation.units) {
    if (options.showHeadings !== false && !(options.hideReportedHeading && unit.origin === "reported")) {
      rows.push(...wrap(unit.origin === "request" ? "Requested changes" : unit.origin === "producer-preview" ? "Producer preview" : "Reported changes", width));
    }
    if (unit.coarseComparison) rows.push(...wrap("Coarse comparison (refinement budget reached)", width));
    let previousAnonymous = false;
    for (const section of unit.sections) {
      const sectionMode = requestedMode === "auto" && !hasPairedChange(section) ? "unified" : mode;
      const rendered = renderSection(unit, section, width, sectionMode, radius, gutter, unifiedWidths, measure, wrap, options.wholeRowHighlight === true, paint, options.showHeadings !== false, options.observed);
      const anonymous = unit.scope.kind === "call" && section.target === undefined;
      if (rendered.length && previousAnonymous && anonymous) rows.push("");
      rows.push(...rendered);
      if (rendered.length) previousAnonymous = anonymous;
    }
  }
  return rows;
}

interface UnifiedGutterWidths { readonly before: number; readonly after: number }

function unifiedGutterWidths(presentation: DiffPresentation, width: number, radius: number, lineNumbers: boolean, observed?: ObservedHunks): UnifiedGutterWidths {
  const available = width - 6;
  if (!lineNumbers || available < 2) return { before: 0, after: 0 };
  let before = 1;
  let after = 1;
  for (const unit of presentation.units) for (const section of unit.sections) {
    if (section.kind !== "hunks") continue;
    for (const hunk of section.hunks) for (const { block } of contextWindow(hunk, radius, observed)) {
      if (block.kind === "context") {
        before = Math.max(before, String(block.oldLine1 ?? "").length);
        after = Math.max(after, (block.newLabel ?? String(block.newLine1 ?? "")).length);
      } else if (block.kind === "observed-context") {
        before = Math.max(before, cellLabel(block.before).length);
        after = Math.max(after, cellLabel(block.after).length);
      } else if (block.kind === "change") {
        for (const pair of block.pairs) {
          before = Math.max(before, cellLabel(pair.before).length);
          after = Math.max(after, cellLabel(pair.after).length);
        }
      } else if (block.kind === "located-change") {
        if (block.operation === "replace" || block.operation === "delete") before = Math.max(before, block.locationLabel.length);
        for (const cell of block.after) after = Math.max(after, cellLabel(cell).length);
      }
    }
  }
  if (before + after <= available) return { before, after };
  if (before <= after) {
    const fittedBefore = Math.min(before, available - 1);
    return { before: fittedBefore, after: Math.min(after, available - fittedBefore) };
  }
  const fittedAfter = Math.min(after, available - 1);
  return { before: Math.min(before, available - fittedAfter), after: fittedAfter };
}
