import { diffArrays } from "diff";
import type { ChangedLinePair, DiffBlock, DiffCell, DiffHunk, DiffViewUnit } from "./model.ts";

export interface ComparisonOptions {
  /** Maximum comparison work across lines, row matching and graphemes (default 25,000; cap 500,000). */
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

function lineSimilarity(before: string, after: string): number {
  if (before === after) return 1;
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return (prefix + suffix) / Math.max(before.length, after.length);
}

function separateChangedLines(before: readonly DiffCell[], after: readonly DiffCell[]): ChangedLinePair[] {
  return [
    ...before.map((cell) => ({ before: { ...cell, emphasis: fullSpan(cell) } })),
    ...after.map((cell) => ({ after: { ...cell, emphasis: fullSpan(cell) } })),
  ];
}

function alignChangedLines(before: readonly DiffCell[], after: readonly DiffCell[], budget: ComparisonBudget): ChangedLinePair[] | undefined {
  if ((before.length === 1 && after.length === 1)
    || (before.length === after.length && before.every((cell, index) => cell.text === after[index]!.text))) {
    return before.map((cell, index) => ({ before: cell, after: after[index]! }));
  }

  const width = after.length + 1;
  const work = (before.length + 1) * width
    + before.reduce((total, cell) => total + cell.text.length, 0)
    + after.reduce((total, cell) => total + cell.text.length, 0);
  if (work > budget.maxComparisonTokens - budget.consumedTokens || remainingTime(budget) <= 0) return undefined;
  budget.consumedTokens += work;

  const oldText = before.map(cell => cell.text.replace(/\s+/g, ""));
  const newText = after.map(cell => cell.text.replace(/\s+/g, ""));
  const scores = new Float64Array((before.length + 1) * width);
  const steps = new Uint8Array(scores.length);
  const minimumSimilarity = 0.2;

  // Zero-cost gaps let unrelated rows stay separate while stronger matches retain their order.
  for (let oldIndex = 1; oldIndex <= before.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= after.length; newIndex += 1) {
      if (remainingTime(budget) <= 0) return undefined;
      const index = oldIndex * width + newIndex;
      const remove = scores[index - width]!;
      const add = scores[index - 1]!;
      let score = Math.max(remove, add);
      let step = add >= remove ? 2 : 1;
      const similarity = lineSimilarity(oldText[oldIndex - 1]!, newText[newIndex - 1]!);
      const paired = scores[index - width - 1]! + similarity - minimumSimilarity;
      if (similarity > minimumSimilarity && paired > score) {
        score = paired;
        step = 3;
      }
      scores[index] = score;
      steps[index] = step;
    }
  }

  const pairs: ChangedLinePair[] = [];
  let oldIndex = before.length;
  let newIndex = after.length;
  while (oldIndex > 0 || newIndex > 0) {
    const step = steps[oldIndex * width + newIndex];
    if (oldIndex > 0 && newIndex > 0 && step === 3) {
      pairs.push({ before: before[--oldIndex]!, after: after[--newIndex]! });
    } else if (oldIndex > 0 && (newIndex === 0 || step === 1)) {
      pairs.push({ before: before[--oldIndex]! });
    } else {
      pairs.push({ after: after[--newIndex]! });
    }
  }
  return pairs.reverse();
}

function refineChangedLines(before: readonly DiffCell[], after: readonly DiffCell[], budget: ComparisonBudget): {
  readonly pairs: readonly [ChangedLinePair, ...ChangedLinePair[]];
  readonly coarse: boolean;
} {
  if (before.length === 0 || after.length === 0) {
    return { pairs: separateChangedLines(before, after) as [ChangedLinePair, ...ChangedLinePair[]], coarse: false };
  }
  const aligned = alignChangedLines(before, after, budget);
  if (aligned === undefined) return { pairs: separateChangedLines(before, after) as [ChangedLinePair, ...ChangedLinePair[]], coarse: true };

  let coarse = false;
  const pairs = aligned.map(pair => {
    if (pair.before === undefined) return { after: { ...pair.after!, emphasis: fullSpan(pair.after!) } };
    if (pair.after === undefined) return { before: { ...pair.before, emphasis: fullSpan(pair.before) } };
    const emphasized = graphemeEmphasis(pair.before, pair.after, budget);
    coarse ||= emphasized.coarse;
    return { before: emphasized.before, after: emphasized.after };
  });
  return { pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]], coarse };
}

function coarseHunk(before: readonly DiffCell[], after: readonly DiffCell[]): DiffHunk | undefined {
  if (before.length === 0 && after.length === 0) return undefined;
  const pairs = separateChangedLines(before, after);
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

    const refined = refineChangedLines(removed, added, budget);
    blocks.push({ kind: "change", pairs: refined.pairs });
    coarse ||= refined.coarse;
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

  return blocks.length === 0
    ? { coarse }
    : { hunk: { blocks: blocks as [DiffBlock, ...DiffBlock[]] }, coarse };
}

export function decorateUnit(unit: DiffViewUnit, budget: ComparisonBudget): DiffViewUnit {
  let coarse = unit.coarseComparison === true;
  const mapSection = (section: DiffViewUnit["sections"][number]) => {
    if (section.kind !== "hunks") return section;

    const hunks = section.hunks.map((hunk) => ({
      ...hunk,
      blocks: hunk.blocks.map((block) => {
        if (block.kind !== "change") return block;
        const before: DiffCell[] = [];
        const after: DiffCell[] = [];
        for (const pair of block.pairs) {
          if (pair.before) before.push(pair.before);
          if (pair.after) after.push(pair.after);
        }
        const refined = refineChangedLines(before, after, budget);
        coarse ||= refined.coarse;
        return { ...block, pairs: refined.pairs };
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
