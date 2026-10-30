import type { RequestView, ResultPart, ResultView, SourceText } from "../presentation.ts";
import type { ComparisonBudget, ComparisonOptions } from "./compare.ts";
import { compareText, createComparisonBudget, decorateSections, resolveComparisonOptions } from "./compare.ts";
import { reportedCoversRequestedEdits } from "./coverage.ts";
import { locationLabel } from "../location-label.ts";
import { requestedEditHunk } from "./requested-edit.ts";
import { parseCodex, parseNumbered, parseUnified } from "./formats.ts";
import type { ParsedPatch } from "./formats.ts";
import type { DiffOrigin, DiffPresentation, DiffScope, DiffSection, DiffViewUnit, ScopedApplicationReport } from "./model.ts";
import { requestedChangeSource } from "./requested.ts";
import type { RequestedChangeSource } from "./requested.ts";

interface BuiltSections {
  readonly sections: readonly DiffSection[];
  readonly coarse?: boolean;
  readonly refine?: boolean;
}

interface CandidateEntry {
  readonly scope: DiffScope;
  readonly ambiguousAssociation?: true;
  readonly build: (budget: ComparisonBudget) => BuiltSections | undefined;
}

interface Candidate {
  readonly origin: DiffOrigin;
  readonly entries: readonly CandidateEntry[];
  readonly callBundle?: CandidateEntry;
}

interface ReportCandidate {
  readonly report: ScopedApplicationReport;
  readonly partIndex: number;
}

const ORIGIN_ORDER: readonly DiffOrigin[] = ["reported", "producer-preview", "request"];

function fileScope(path: string, moveTo?: string): DiffScope | undefined {
  if (path.length === 0 || (moveTo !== undefined && moveTo.length === 0)) return undefined;
  return { kind: "file", path, ...(moveTo === undefined ? {} : { moveTo }) };
}

function scopeKey(scope: DiffScope): string {
  return scope.kind === "call" ? "call" : `file\u0000${scope.path}`;
}

function nonEmptySections(sections: readonly DiffSection[]): DiffViewUnit["sections"] | undefined {
  return sections.length === 0 ? undefined : sections as [DiffSection, ...DiffSection[]];
}

function rawSection(sources: readonly SourceText[]): DiffSection {
  return { kind: "raw", sources: sources as [SourceText, ...SourceText[]] };
}

function staticCandidate(origin: DiffOrigin, sections: readonly DiffSection[], ambiguousAssociation?: true): Candidate {
  const completeSections = sections;
  const allAttributable = completeSections.length > 0 && completeSections.every((section) => section.target !== undefined && section.target.path.length > 0);

  if (!allAttributable) {
    return {
      origin,
      entries: [{
        scope: { kind: "call" },
        build: () => completeSections.length === 0 ? undefined : { sections: completeSections, refine: true },
      }],
    };
  }

  const grouped = new Map<string, { scope: DiffScope; sections: DiffSection[] }>();
  for (const section of completeSections) {
    const target = section.target!;
    const scope = fileScope(target.path);
    if (scope === undefined) continue;
    const key = scopeKey(scope);
    const group = grouped.get(key) ?? { scope, sections: [] };
    group.sections.push(section);
    grouped.set(key, group);
  }

  return {
    origin,
    entries: Array.from(grouped.values(), (group) => ({
      scope: group.scope,
      ...(ambiguousAssociation ? { ambiguousAssociation } : {}),
      build: () => ({ sections: group.sections, refine: true }),
    })),
    callBundle: {
      scope: { kind: "call" },
      build: () => ({ sections: completeSections, refine: true }),
    },
  };
}

function parseByPreference(text: string, allowed: readonly ("unified" | "numbered" | "codex")[]): ParsedPatch | undefined {
  for (const format of allowed) {
    const parsed = format === "unified" ? parseUnified(text) : format === "numbered" ? parseNumbered(text) : parseCodex(text);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function resultDiffCandidate(part: Extract<ResultPart, { readonly kind: "diff" }>): Candidate {
  const mapNonEmpty = <T, U>(items: readonly [T, ...T[]], map: (item: T) => U): [U, ...U[]] => [map(items[0]), ...items.slice(1).map(map)];
  const origin: DiffOrigin = part.origin === "reported" ? "reported" : "producer-preview";
  const candidates: { readonly format: "unified" | "numbered" | "codex"; readonly text: string }[] = [];
  if (part.representations.unified !== undefined) candidates.push({ format: "unified", text: part.representations.unified });
  if (part.representations.numbered !== undefined) candidates.push({ format: "numbered", text: part.representations.numbered });
  if (part.representations.codex !== undefined) candidates.push({ format: "codex", text: part.representations.codex });

  let parsed: ParsedPatch | undefined;
  for (const candidate of candidates) {
    parsed = parseByPreference(candidate.text, [candidate.format]);
    if (parsed !== undefined) break;
  }

  if (parsed === undefined || parsed.scopeConflict === true) {
    const raw = rawSection(candidates.map(({ text }) => ({ text })));
    const canUseOuterPath = parsed?.scopeConflict !== true;
    return staticCandidate(origin, !canUseOuterPath || part.path === undefined
      ? [raw]
      : [{ ...raw, ...(part.path.length === 0 ? {} : { target: { path: part.path, ...(part.moveTo === undefined ? {} : { moveTo: part.moveTo }) } }) }], part.ambiguousAssociation);
  }

  let attributionConflict = false;
  const identifiers = new Map(part.lineIdentifiers?.map(item => [JSON.stringify([item.path, item.side, item.line1]), item.identifier]));
  const labelFor = (path: string, side: "before" | "after", line1: number | undefined): string | undefined => {
    if (line1 === undefined) return undefined;
    const identifier = identifiers.get(JSON.stringify([path, side, line1]));
    return identifier === undefined ? undefined : locationLabel(line1, identifier);
  };
  const sections = parsed.sections.map((section) => {
    const path = section.target?.path ?? part.path;
    if (path && section.kind === "hunks" && identifiers.size) {
      section = { ...section, hunks: section.hunks.map(hunk => ({ ...hunk, blocks: mapNonEmpty(hunk.blocks, block => {
        if (block.kind === "context") {
          const label = labelFor(path, "after", block.newLine1);
          return label === undefined ? block : { ...block, newLabel: label };
        }
        if (block.kind !== "change") return block;
        return { ...block, pairs: mapNonEmpty(block.pairs, pair => {
          const before = pair.before && labelFor(path, "before", pair.before.line1);
          const after = pair.after && labelFor(path, "after", pair.after.line1);
          return { ...pair, ...(before && pair.before ? { before: { ...pair.before, locationLabel: before } } : {}),
            ...(after && pair.after ? { after: { ...pair.after, locationLabel: after } } : {}) };
        }) };
      }) })) };
    }
    if (section.target === undefined) {
      return part.path === undefined ? section : { ...section, target: { path: part.path, ...(part.moveTo === undefined ? {} : { moveTo: part.moveTo }) } };
    }
    if ((part.path !== undefined && section.target.path !== part.path)
      || (part.moveTo !== undefined && section.target.moveTo !== undefined && section.target.moveTo !== part.moveTo)) attributionConflict = true;
    if (part.moveTo !== undefined && section.target.moveTo === undefined) return { ...section, target: { ...section.target, moveTo: part.moveTo } };
    return section;
  });

  if (attributionConflict) {
    return {
      origin,
      entries: [{ scope: { kind: "call" }, build: () => ({ sections, refine: true }) }],
    };
  }
  return staticCandidate(origin, sections, part.ambiguousAssociation);
}

function requestedCandidate(request: RequestView, source: RequestedChangeSource): Candidate {
  const indices = source.targets.map((_target, index) => index);
  const build = (items: readonly number[]): BuiltSections | undefined => {
    const sections: DiffSection[] = [];
    let coarse = false;
    for (const index of items) {
      const unit = source.unit(index);
      coarse ||= unit.coarseComparison === true;
      sections.push(...unit.sections.filter(section => request.kind !== "change.replacements" || section.kind !== "hunks" || section.hunks.length > 0));
    }
    return sections.length === 0 ? undefined : { sections, coarse };
  };

  if (source.targets.some(target => !target?.path)) return {
    origin: "request", entries: [{ scope: { kind: "call" }, build: () => build(indices) }],
  };

  const grouped = new Map<string, { readonly scope: DiffScope; indices: number[] }>();
  for (const index of indices) {
    const scope = fileScope(source.targets[index]!.path)!;
    const key = scopeKey(scope);
    const group = grouped.get(key) ?? { scope, indices: [] };
    group.indices.push(index);
    grouped.set(key, group);
  }

  return {
    origin: "request",
    entries: Array.from(grouped.values(), (group) => ({
      scope: group.scope,
      build: () => build(group.indices),
    })),
    callBundle: {
      scope: { kind: "call" },
      build: () => build(indices),
    },
  };
}

function renameCandidate(request: Extract<RequestView, { readonly kind: "change.rename-file" }>): Candidate | undefined {
  if (request.path.length === 0 || request.newPath.length === 0 || request.path === request.newPath) return undefined;
  const scope = fileScope(request.path);
  const section: DiffSection = {
    kind: "hunks",
    target: { path: request.path, moveTo: request.newPath },
    activity: "moved",
    hunks: [],
  };
  return {
    origin: "request",
    entries: [{ scope: scope ?? { kind: "call" }, build: () => ({ sections: [section] }) }],
  };
}

function requestCandidates(request: RequestView, source: RequestedChangeSource | undefined): Candidate[] {
  if (source) return [requestedCandidate(request, source)];
  if (request.kind === "change.rename-file") {
    const candidate = renameCandidate(request);
    return candidate === undefined ? [] : [candidate];
  }
  // A write has no supplied before-image; its new content is not a diff.
  return [];
}

function collectApplicationReports(result: ResultView | undefined): {
  readonly reports: readonly ScopedApplicationReport[];
  readonly consumedParts: ReadonlySet<number>;
} {
  if (result === undefined) return { reports: [], consumedParts: new Set() };

  const candidates: ReportCandidate[] = [];
  result.parts.forEach((part, partIndex) => {
    if (part.kind !== "changes" || part.application === undefined) return;
    candidates.push({ report: part.application, partIndex });
  });

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = scopeKey(candidate.report.scope);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const accepted = candidates.filter((candidate) => counts.get(scopeKey(candidate.report.scope)) === 1);
  return {
    reports: accepted.map(({ report }) => report),
    consumedParts: new Set(accepted.map(({ partIndex }) => partIndex)),
  };
}

function outputUnit(scope: DiffScope, origin: DiffOrigin, built: BuiltSections, budget: ComparisonBudget): DiffViewUnit | undefined {
  const sections = nonEmptySections(built.sections);
  if (sections === undefined) return undefined;
  const refined = built.refine === true ? decorateSections(sections, budget) : undefined;
  const coarse = built.coarse === true || refined?.coarse === true;
  return {
    scope,
    origin,
    sections: refined?.sections ?? sections,
    ...(coarse ? { coarseComparison: true } : {}),
  };
}

function chooseUnits(candidates: readonly Candidate[], budget: ComparisonBudget): DiffViewUnit[] {
  const callWide = candidates.some((candidate) => candidate.entries.some((entry) => entry.scope.kind === "call"));
  if (callWide) {
    const origin = ORIGIN_ORDER.find((value) => candidates.some((candidate) => candidate.origin === value));
    if (origin === undefined) return [];
    const sections: DiffSection[] = [];
    let coarse = false;

    for (const candidate of candidates) {
      if (candidate.origin !== origin) continue;
      const entries = candidate.entries.some((entry) => entry.scope.kind === "call")
        ? candidate.entries
        : candidate.callBundle === undefined ? candidate.entries : [candidate.callBundle];
      for (const entry of entries) {
        const built = entry.build(budget);
        if (built === undefined) continue;
        sections.push(...built.sections);
        coarse ||= built.coarse === true;
        if (built.refine === true) {
          const sectionsToDecorate = nonEmptySections(built.sections);
          if (sectionsToDecorate === undefined) continue;
          const refined = decorateSections(sectionsToDecorate, budget);
          sections.splice(sections.length - built.sections.length, built.sections.length, ...refined.sections);
          coarse ||= refined.coarse;
        }
      }
    }

    const completeSections = nonEmptySections(sections);
    if (completeSections === undefined) return [];
    return [{ scope: { kind: "call" }, origin, sections: completeSections, ...(coarse ? { coarseComparison: true } : {}) }];
  }

  const byScope = new Map<string, { readonly scope: DiffScope; entries: { readonly origin: DiffOrigin; readonly entry: CandidateEntry }[] }>();
  for (const candidate of candidates) {
    for (const entry of candidate.entries) {
      const key = scopeKey(entry.scope);
      const group = byScope.get(key) ?? { scope: entry.scope, entries: [] };
      group.entries.push({ origin: candidate.origin, entry });
      byScope.set(key, group);
    }
  }

  const units: DiffViewUnit[] = [];
  for (const group of byScope.values()) {
    if (group.entries.some(item => item.origin !== "request" && item.entry.ambiguousAssociation)) {
      for (const item of group.entries.filter(entry => entry.origin !== "request")) {
        const built = item.entry.build(budget);
        if (built === undefined) continue;
        const unit = outputUnit(group.scope, item.origin, built, budget);
        if (unit) units.push({ ...unit, ambiguousAssociation: true });
      }
      continue;
    }

    const origin = ORIGIN_ORDER.find((value) => group.entries.some((item) => item.origin === value));
    if (origin === undefined) continue;
    const sections: DiffSection[] = [];
    let coarse = false;

    for (const item of group.entries) {
      if (item.origin !== origin) continue;
      const built = item.entry.build(budget);
      if (built === undefined) continue;
      const unit = outputUnit(group.scope, origin, built, budget);
      if (unit === undefined) continue;
      sections.push(...unit.sections);
      coarse ||= unit.coarseComparison === true;
    }

    const completeSections = nonEmptySections(sections);
    if (completeSections !== undefined) units.push({ scope: group.scope, origin, sections: completeSections, ...(coarse ? { coarseComparison: true } : {}) });
  }
  return units;
}

function resultCandidates(result: ResultView | undefined): Candidate[] {
  if (result === undefined) return [];
  return result.parts.flatMap((part) => part.kind === "diff" && part.placement !== "inline" ? [resultDiffCandidate(part)] : []);
}

function retainedContext(result: ResultView | undefined, consumedReports: ReadonlySet<number>): DiffPresentation["context"] {
  if (result === undefined) return [];
  const context: ResultPart[] = [];

  result.parts.forEach((part, partIndex) => {
    if (part.kind === "diff" && part.placement !== "inline") return;
    if (part.kind === "changes" && consumedReports.has(partIndex) && part.application !== undefined) {
      if (part.changes.length > 0) context.push({ kind: "changes", changes: part.changes });
      return;
    }
    context.push(part);
  });

  return context;
}

/**
 * Compile supplied change material into one source-selected, provenance-preserving plan.
 * This function compares only admitted request strings and the supplied result snapshot; it performs no execution or I/O.
 */
export function buildDiffPresentation(
  request: RequestView,
  result: ResultView | undefined,
  options: ComparisonOptions = {},
): DiffPresentation {
  const budget = createComparisonBudget(options);
  const requested = requestedChangeSource(request, budget);
  const candidates = [...requestCandidates(request, requested), ...resultCandidates(result)];
  const { reports, consumedParts } = collectApplicationReports(result);
  const units = chooseUnits(candidates, budget);
  const inline = result?.parts.filter((part): part is Extract<ResultPart, { kind: "diff" }> => part.kind === "diff" && part.placement === "inline") ?? [];
  const inlineUnits = inline.length === 1 && result?.completeEditReceipt ? chooseUnits([resultDiffCandidate(inline[0]!)], budget) : [];
  const requestNotes = unreportedTransferNotes(request, units, budget);
  const compoundUnits = requested && requested.targets.length > 1 ? requested.targets.map((_target, index) => requested.unit(index)) : [];
  return {
    units,
    ...(requested ? { compoundRequest: { request, comparison: { maxComparisonTokens: budget.maxComparisonTokens,
      maxEditLength: budget.maxEditLength, timeoutMs: budget.timeoutMs }, units: compoundUnits } } : {}),
    ...(requestNotes.length ? { requestNotes } : {}),

    applicationReports: reports,
    context: retainedContext(result, consumedParts),
    ...(reportedCoversRequestedEdits(request, result, units) ? { reportedCoversRequest: true } : {}),
    ...(reportedCoversRequestedEdits(request, result, inlineUnits) ? { inlineCoversRequest: true } : {}),
  };
}

export function compoundRequestUnits(request: RequestView, plan: DiffPresentation, options: ComparisonOptions): readonly DiffViewUnit[] {
  const comparison = resolveComparisonOptions(options);
  const prepared = plan.compoundRequest;
  if (prepared?.request === request && prepared.comparison.maxComparisonTokens === comparison.maxComparisonTokens
    && prepared.comparison.maxEditLength === comparison.maxEditLength && prepared.comparison.timeoutMs === comparison.timeoutMs) return prepared.units;
  return buildDiffPresentation(request, undefined, comparison).compoundRequest?.units ?? [];
}

function unreportedTransferNotes(request: RequestView, units: readonly DiffViewUnit[], budget: ComparisonBudget): readonly string[] {
  if (request.kind !== "change.replacements" || request.requestedEdits.length !== 1) return [];
  const edit = request.requestedEdits[0];
  if (!edit || !("kind" in edit) || edit.kind !== "transfer" || edit.operation !== "move"
    || !edit.source.path || !edit.destination.path || edit.source.path === edit.destination.path) return [];
  const reports = units.filter(unit => unit.origin === "reported");
  if (!reports.length) return [];
  const paths = new Set(reports.flatMap(unit => [
    ...(unit.scope.kind === "file" ? [unit.scope.path, unit.scope.moveTo] : []),
    ...unit.sections.flatMap(section => [section.target?.path, section.target?.moveTo]),
  ].filter((path): path is string => path !== undefined)));
  if (paths.has(edit.source.path) && paths.has(edit.destination.path)) return [];
  const block = requestedEditHunk(edit, budget).hunk?.blocks[0];
  return block?.kind === "instruction" ? [`Requested: ${block.text}`] : [];
}
