import { diffArrays } from "diff";
import type { ChangedLinePair, DiffBlock, DiffCell, DiffHunk, DiffViewUnit } from "./model.ts";

export interface ComparisonOptions {
  /** Maximum total line and grapheme tokens refined across one build call (default 25,000; cap 500,000). */
  readonly maxComparisonTokens?: number;
  /** Maximum edit distance considered by each refinement (default 1,024; cap 4,096). */
  readonly maxEditLength?: number;
  /** Maximum elapsed time spent in all refinements for one build call (default 25 ms; cap 500 ms). */
  readonly timeoutMs?: number;
}

export interface ComparisonBudget {
  readonly maxComparisonTokens: number;
  readonly maxEditLength: number;
  readonly timeoutMs: number;
  readonly startedAt: number;
  consumedTokens: number;
}

export interface ComparedHunk {
  readonly hunk?: DiffHunk;
  readonly coarse: boolean;
}

const MAX_TOKENS = 500_000;
const MAX_EDIT_LENGTH = 4_096;
const MAX_TIMEOUT_MS = 500;

const graphemeSegmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function createComparisonBudget(options: ComparisonOptions = {}): ComparisonBudget {
  return {
    ...resolveComparisonOptions(options),
    startedAt: performance.now(),
    consumedTokens: 0,
  };
}

export function resolveComparisonOptions(options: ComparisonOptions): Required<ComparisonOptions> {
  return {
    maxComparisonTokens: boundedOption(options.maxComparisonTokens, 25_000, MAX_TOKENS, "maxComparisonTokens"),
    maxEditLength: boundedOption(options.maxEditLength, 1_024, MAX_EDIT_LENGTH, "maxEditLength"),
    timeoutMs: boundedOption(options.timeoutMs, 25, MAX_TIMEOUT_MS, "timeoutMs"),
  };
}

function boundedOption(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return Math.min(Math.floor(value), maximum);
}

function remainingTime(budget: ComparisonBudget): number {
  return Math.max(0, budget.timeoutMs - (performance.now() - budget.startedAt));
}

function diffTokens<T>(
  before: readonly T[],
  after: readonly T[],
  budget: ComparisonBudget,
  comparator?: (left: T, right: T) => boolean,
): readonly { readonly value: readonly T[]; readonly added?: boolean; readonly removed?: boolean }[] | undefined {
  const tokenCost = before.length + after.length;
  if (budget.consumedTokens + tokenCost > budget.maxComparisonTokens || remainingTime(budget) <= 0) return undefined;

  budget.consumedTokens += tokenCost;
  return diffArrays([...before], [...after], {
    maxEditLength: budget.maxEditLength,
    timeout: remainingTime(budget),
    ...(comparator === undefined ? {} : { comparator }),
  });
}

export function splitLogicalLines(text: string): DiffCell[] {
  const lines: DiffCell[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") continue;

    const lineEnding = character === "\r" && text[index + 1] === "\n" ? "\r\n" : character;
    lines.push({ text: text.slice(start, index), lineEnding, emphasis: [] });
    if (lineEnding === "\r\n") index += 1;
    start = index + 1;
  }

  if (start < text.length) lines.push({ text: text.slice(start), lineEnding: "", emphasis: [] });
  return lines;
}

function fullSpan(cell: DiffCell): readonly { readonly startUtf16: number; readonly endUtf16: number }[] {
  return cell.text.length === 0 ? [] : [{ startUtf16: 0, endUtf16: cell.text.length }];
}

function graphemes(text: string, maximum: number): { readonly value: string; readonly start: number; readonly end: number }[] | undefined {
  if (!graphemeSegmenter) return undefined;
  const tokens: { readonly value: string; readonly start: number; readonly end: number }[] = [];
  for (const item of graphemeSegmenter.segment(text)) {
    if (tokens.length === maximum) return undefined;
    tokens.push({ value: item.segment, start: item.index, end: item.index + item.segment.length });
  }
  return tokens;
}

function spansForChanges(tokens: readonly { readonly value: string; readonly start: number; readonly end: number }[], changed: ReadonlySet<number>) {
  const spans: { startUtf16: number; endUtf16: number }[] = [];

  for (const index of changed) {
    const token = tokens[index];
    if (token === undefined) continue;

    const previous = spans.at(-1);
    if (previous !== undefined && previous.endUtf16 === token.start) previous.endUtf16 = token.end;
    else spans.push({ startUtf16: token.start, endUtf16: token.end });
  }

  return spans;
}

function graphemeEmphasis(before: DiffCell, after: DiffCell, budget: ComparisonBudget): {
  readonly before: DiffCell;
  readonly after: DiffCell;
  readonly coarse: boolean;
} {
  if (before.text === after.text) {
    return { before: { ...before, emphasis: [] }, after: { ...after, emphasis: [] }, coarse: false };
  }

  const remaining = Math.max(0, budget.maxComparisonTokens - budget.consumedTokens);
  const oldTokens = graphemes(before.text, remaining);
  if (oldTokens === undefined) {
    budget.consumedTokens = budget.maxComparisonTokens;
    return { before: { ...before, emphasis: fullSpan(before) }, after: { ...after, emphasis: fullSpan(after) }, coarse: true };
  }
  const newTokens = graphemes(after.text, remaining - oldTokens.length);
  if (newTokens === undefined) {
    budget.consumedTokens = budget.maxComparisonTokens;
    return { before: { ...before, emphasis: fullSpan(before) }, after: { ...after, emphasis: fullSpan(after) }, coarse: true };
  }
  const changes = diffTokens(oldTokens, newTokens, budget, (left, right) => left.value === right.value);

  if (changes === undefined) {
    return {
      before: { ...before, emphasis: fullSpan(before) },
      after: { ...after, emphasis: fullSpan(after) },
      coarse: true,
    };
  }

  const oldChanged = new Set<number>();
  const newChanged = new Set<number>();
  let oldIndex = 0;
  let newIndex = 0;

  for (const change of changes) {
    for (const token of change.value) {
      if (change.removed) oldChanged.add(oldIndex++);
      else if (change.added) newChanged.add(newIndex++);
      else {
        oldIndex += 1;
        newIndex += 1;
      }
    }
  }

  return {
    before: { ...before, emphasis: spansForChanges(oldTokens, oldChanged) },
    after: { ...after, emphasis: spansForChanges(newTokens, newChanged) },
    coarse: false,
  };
}

function makePair(before: DiffCell | undefined, after: DiffCell | undefined): ChangedLinePair | undefined {
  if (before === undefined && after === undefined) return undefined;
  return before === undefined ? { after: after! } : after === undefined ? { before } : { before, after };
}

function coarseHunk(before: readonly DiffCell[], after: readonly DiffCell[]): DiffHunk | undefined {
  if (before.length === 0 && after.length === 0) return undefined;
  const pairs: ChangedLinePair[] = [
    ...before.map((cell) => ({ before: { ...cell, emphasis: fullSpan(cell) } })),
    ...after.map((cell) => ({ after: { ...cell, emphasis: fullSpan(cell) } })),
  ];
  return { blocks: [{ kind: "change", pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]] }] };
}

export function compareText(beforeText: string, afterText: string, budget: ComparisonBudget): ComparedHunk {
  if (beforeText === afterText) return { coarse: false };
  const before = splitLogicalLines(beforeText);
  const after = splitLogicalLines(afterText);
  const changes = diffTokens(before, after, budget, (left, right) =>
    left.text === right.text && left.lineEnding === right.lineEnding,
  );

  if (changes === undefined) {
    const hunk = coarseHunk(before, after);
    return hunk === undefined ? { coarse: false } : { hunk, coarse: true };
  }

  const blocks: DiffBlock[] = [];
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];
  let coarse = false;

  const flushChanged = (): void => {
    if (removed.length === 0 && added.length === 0) return;

    const pairs: ChangedLinePair[] = [];
    const pairCount = Math.max(removed.length, added.length);
    for (let index = 0; index < pairCount; index += 1) {
      pairs.push(makePair(removed[index], added[index])!);
    }
    blocks.push({ kind: "change", pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]] });
    removed = [];
    added = [];
  };

  for (const change of changes) {
    for (const cell of change.value) {
      if (change.removed) removed.push(cell);
      else if (change.added) added.push(cell);
      else {
        flushChanged();
        blocks.push({ kind: "context", text: cell.text, ...(cell.lineEnding === undefined ? {} : { lineEnding: cell.lineEnding }) });
      }
    }
  }

  flushChanged();

  const refinedBlocks = blocks.map((block) => {
    if (block.kind !== "change") return block;
    const pairs: ChangedLinePair[] = [];
    for (const pair of block.pairs) {
      if (pair.before === undefined || pair.after === undefined) {
        const cell = pair.before ?? pair.after!;
        pairs.push(pair.before === undefined
          ? { after: { ...cell, emphasis: fullSpan(cell) } }
          : { before: { ...cell, emphasis: fullSpan(cell) } });
        continue;
      }

      const emphasized = graphemeEmphasis(pair.before, pair.after, budget);
      pairs.push({ before: emphasized.before, after: emphasized.after });
      coarse ||= emphasized.coarse;
    }
    return { ...block, pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]] };
  });

  return refinedBlocks.length === 0
    ? { coarse }
    : { hunk: { blocks: refinedBlocks as [DiffBlock, ...DiffBlock[]] }, coarse };
}

export function decorateUnit(unit: DiffViewUnit, budget: ComparisonBudget): DiffViewUnit {
  let coarse = unit.coarseComparison === true;
  const mapSection = (section: DiffViewUnit["sections"][number]) => {
    if (section.kind !== "hunks") return section;

    const hunks = section.hunks.map((hunk) => ({
      ...hunk,
      blocks: hunk.blocks.map((block) => {
        if (block.kind !== "change") return block;
        const pairs = block.pairs.map((pair) => {
          if (pair.before === undefined) return { after: { ...pair.after!, emphasis: fullSpan(pair.after!) } };
          if (pair.after === undefined) return { before: { ...pair.before, emphasis: fullSpan(pair.before) } };
          const emphasized = graphemeEmphasis(pair.before, pair.after, budget);
          coarse ||= emphasized.coarse;
          return { before: emphasized.before, after: emphasized.after };
        });
        return { ...block, pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]] };
      }) as [DiffBlock, ...DiffBlock[]],
    }));
    return { ...section, hunks };
  };
  const [firstSection, ...remainingSections] = unit.sections;
  const sections = [mapSection(firstSection), ...remainingSections.map(mapSection)] as DiffViewUnit["sections"];

  return { ...unit, sections, ...(coarse ? { coarseComparison: true } : {}) };
}

export function decorateSections(sections: DiffViewUnit["sections"], budget: ComparisonBudget): {
  readonly sections: DiffViewUnit["sections"];
  readonly coarse: boolean;
} {
  const decorated = decorateUnit({ scope: { kind: "call" }, origin: "request", sections }, budget);
  return { sections: decorated.sections, coarse: decorated.coarseComparison === true };
}
