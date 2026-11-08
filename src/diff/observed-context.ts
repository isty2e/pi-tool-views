import type { ChangedLinePair, DiffBlock, DiffCell, DiffHunk, DiffPresentation, DiffViewUnit } from "./model.ts";

export type ObservedContextBlock = { readonly kind: "observed-context" } & (
  { readonly before: DiffCell; readonly after?: DiffCell } | { readonly before?: DiffCell; readonly after: DiffCell }
);
export type DisplayBlock = DiffBlock | ObservedContextBlock;
export interface DisplayHunk { readonly blocks: readonly DisplayBlock[] }
export type ObservedHunks = ReadonlyMap<DiffHunk, DisplayHunk>;
export interface FileObservations { readonly before?: string; readonly after?: string }

interface LiteralSide { readonly cells: readonly DiffCell[]; readonly start?: number }
interface Line { readonly start: number; readonly end: number; readonly ending: NonNullable<DiffCell["lineEnding"]> }
interface Match { readonly start: number; readonly leading: readonly DiffCell[]; readonly trailing: readonly DiffCell[] }
interface Candidate { readonly hunk: DiffHunk; readonly side: "before" | "after"; readonly literal: LiteralSide; readonly anchor: number }

function literalSide(hunk: DiffHunk, side: "before" | "after"): LiteralSide | undefined {
  const cells: DiffCell[] = [];
  for (const block of hunk.blocks) {
    if (block.kind === "context") {
      const line1 = side === "before" ? block.oldLine1 : block.newLine1;
      cells.push({ text: block.text, emphasis: [], ...(line1 === undefined ? {} : { line1 }) });
    } else if (block.kind === "change") {
      for (const pair of block.pairs) if (pair[side]) cells.push(pair[side]!);
    } else return undefined;
  }
  if (!cells.length) return undefined;
  let start: number | undefined;
  for (const [index, cell] of cells.entries()) {
    if (cell.line1 === undefined) continue;
    const proposed = cell.line1 - index - 1;
    if (proposed < 0 || (start !== undefined && start !== proposed)) return undefined;
    start = proposed;
  }
  return { cells, ...(start === undefined ? {} : { start }) };
}

// Copy excerpts so retaining a few context rows does not retain a complete observed file.
function ownedText(text: string): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(text));
}

async function matchFile(text: string, candidates: readonly Candidate[], radius: number, current: () => boolean): Promise<Map<Candidate, Match>> {
  let yieldedAt = performance.now();
  const yieldIfNeeded = async () => {
    if (performance.now() - yieldedAt < 4) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    yieldedAt = performance.now();
  };
  const lines: Line[] = [];
  const anchors = new Map<string, number[]>();
  for (const candidate of candidates) {
    if (candidate.literal.start === undefined) anchors.set(candidate.literal.cells[candidate.anchor]!.text, []);
  }
  let start = 0;
  for (let offset = 0; offset < text.length; offset++) {
    if (offset % 131072 === 0) {
      await yieldIfNeeded();
      if (!current()) return new Map();
    }
    const character = text[offset];
    if (character !== "\r" && character !== "\n") continue;
    const ending = character === "\r" && text[offset + 1] === "\n" ? "\r\n" : character;
    anchors.get(text.slice(start, offset))?.push(lines.length);
    lines.push({ start, end: offset, ending });
    if (lines.length > 250_000) return new Map();
    if (ending === "\r\n") offset++;
    start = offset + 1;
  }
  if (start < text.length) {
    anchors.get(text.slice(start))?.push(lines.length);
    lines.push({ start, end: text.length, ending: "" });
  }

  const result = new Map<Candidate, Match>();
  const context = new Map<number, DiffCell>();
  const contextCell = (index: number): DiffCell => {
    let cell = context.get(index);
    if (!cell) {
      const line = lines[index]!;
      cell = { text: ownedText(text.slice(line.start, line.end)), line1: index + 1, lineEnding: line.ending, emphasis: [] };
      context.set(index, cell);
    }
    return cell;
  };
  let compared = 0;
  for (const candidate of candidates) {
    const literal = candidate.literal;
    const positions = literal.start === undefined ? anchors.get(literal.cells[candidate.anchor]!.text) ?? [] : [literal.start];
    let match: number | undefined;
    let ambiguous = false;
    for (const anchor of positions) {
      const position = literal.start === undefined ? anchor - candidate.anchor : anchor;
      if (position < 0 || position + literal.cells.length > lines.length) continue;
      let equal = true;
      for (let index = 0; index < literal.cells.length; index++) {
        if (++compared > 500_000) return result;
        if (compared % 4096 === 0) {
          await yieldIfNeeded();
          if (!current()) return new Map();
        }
        const line = lines[position + index]!;
        if (text.slice(line.start, line.end) !== literal.cells[index]!.text) { equal = false; break; }
      }
      if (!equal) continue;
      if (match !== undefined) { ambiguous = true; break; }
      match = position;
    }
    if (match !== undefined && !ambiguous) {
      result.set(candidate, { start: match,
        leading: Array.from({ length: Math.min(radius, match) }, (_, index) => contextCell(Math.max(0, match! - radius) + index)),
        trailing: Array.from({ length: Math.min(radius, lines.length - match - literal.cells.length) }, (_, index) => contextCell(match! + literal.cells.length + index)),
      });
    }
    await yieldIfNeeded();
    if (!current()) return new Map();
  }
  return result;
}

function displayHunk(hunk: DiffHunk, before: Match | undefined, after: Match | undefined): DisplayHunk {
  const blocks: DisplayBlock[] = [];
  const appendContext = (left: readonly DiffCell[], right: readonly DiffCell[], alignEnd: boolean) => {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
      const oldCell = left[index - (alignEnd ? length - left.length : 0)];
      const newCell = right[index - (alignEnd ? length - right.length : 0)];
      blocks.push(oldCell ? { kind: "observed-context", before: oldCell, ...(newCell ? { after: newCell } : {}) }
        : { kind: "observed-context", after: newCell! });
    }
  };
  appendContext(before?.leading ?? [], after?.leading ?? [], true);
  let oldIndex = 0;
  let newIndex = 0;
  const numbered = (cell: DiffCell, match: Match | undefined, index: number): DiffCell =>
    cell.line1 !== undefined || !match ? cell : { ...cell, line1: match.start + index + 1 };
  for (const block of hunk.blocks) {
    if (block.kind === "context") {
      blocks.push({ ...block, ...(before && block.oldLine1 === undefined ? { oldLine1: before.start + oldIndex + 1 } : {}),
        ...(after && block.newLine1 === undefined ? { newLine1: after.start + newIndex + 1 } : {}) });
      oldIndex++;
      newIndex++;
    } else if (block.kind === "change") {
      const numberPair = (pair: ChangedLinePair): ChangedLinePair => {
        const oldCell = pair.before ? numbered(pair.before, before, oldIndex++) : undefined;
        const newCell = pair.after ? numbered(pair.after, after, newIndex++) : undefined;
        return oldCell ? { before: oldCell, ...(newCell ? { after: newCell } : {}) } : { after: newCell! };
      };
      blocks.push({ kind: "change", pairs: [numberPair(block.pairs[0]), ...block.pairs.slice(1).map(numberPair)] });
    } else blocks.push(block);
  }
  appendContext(before?.trailing ?? [], after?.trailing ?? [], false);
  return { blocks };
}

/** Locate literal, file-scoped hunks without changing source selection or application evidence. */
export async function observeDiffContext(
  presentation: DiffPresentation,
  files: ReadonlyMap<DiffHunk, FileObservations>,
  radius: number,
  current: () => boolean = () => true,
): Promise<ObservedHunks> {
  if (!Number.isSafeInteger(radius) || radius < 0) throw new RangeError("Context must be a non-negative integer");
  const groups = new Map<FileObservations, { before: Candidate[]; after: Candidate[] }>();
  const seen = new Set<DiffHunk>();
  const units: readonly DiffViewUnit[] = [...presentation.units, ...(presentation.compoundRequest?.units ?? [])];
  for (const unit of units) for (const section of unit.sections) {
    const path = section.target?.path ?? (unit.scope.kind === "file" ? unit.scope.path : undefined);
    if (!path || section.kind !== "hunks" || unit.ambiguousAssociation) continue;
    for (const hunk of section.hunks) {
      if (seen.has(hunk)) continue;
      seen.add(hunk);
      const observation = files.get(hunk);
      if (!observation) continue;
      let candidates = groups.get(observation);
      if (!candidates) { candidates = { before: [], after: [] }; groups.set(observation, candidates); }
      for (const side of ["before", "after"] as const) {
        const literal = literalSide(hunk, side);
        if (!literal) continue;
        let anchor = 0;
        for (let index = 1; index < literal.cells.length; index++) {
          if (literal.cells[index]!.text.length > literal.cells[anchor]!.text.length) anchor = index;
        }
        candidates[side].push({ hunk, side, literal, anchor });
      }
    }
  }
  const matches = new Map<DiffHunk, { before?: Match; after?: Match }>();
  for (const [observation, candidates] of groups) for (const side of ["before", "after"] as const) {
    const text = observation[side];
    if (text === undefined || !candidates[side].length || !current()) continue;
    for (const [candidate, match] of await matchFile(text, candidates[side], radius, current)) {
      let sides = matches.get(candidate.hunk);
      if (!sides) { sides = {}; matches.set(candidate.hunk, sides); }
      sides[side] = match;
    }
  }
  return current() ? new Map([...matches].map(([hunk, match]) => [hunk, displayHunk(hunk, match.before, match.after)])) : new Map();
}
