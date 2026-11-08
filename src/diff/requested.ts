import type { FileContext, RequestView } from "../presentation.ts";
import type { ComparisonBudget } from "./compare.ts";
import { decorateSections } from "./compare.ts";
import { parseRequestedPatch } from "./formats.ts";
import type { DiffSection, DiffViewUnit } from "./model.ts";
import { requestedEditHunk } from "./requested-edit.ts";

export interface RequestedChangeSource {
  readonly targets: readonly DiffSection["target"][];
  readonly unit: (index: number) => DiffViewUnit;
}

export interface PreparedRequestedChanges {
  readonly request: RequestView;
  readonly targets: readonly ((NonNullable<DiffSection["target"]> & { readonly fileContext?: FileContext }) | undefined)[];
  source(budget: ComparisonBudget): RequestedChangeSource;
}

/** Decode request material before capture without spending the presentation comparison budget. */
export function prepareRequestedChanges(request: RequestView): PreparedRequestedChanges | undefined {
  const builders: ((budget: ComparisonBudget) => DiffViewUnit)[] = [];
  const targets: PreparedRequestedChanges["targets"][number][] = [];
  const append = (target: DiffSection["target"], build: (budget: ComparisonBudget) => { readonly section: DiffSection; readonly coarse: boolean }, fileContext?: FileContext) => {
    targets.push(target ? { ...target, ...(fileContext ? { fileContext } : {}) } : undefined);
    builders.push(budget => {
      const { section, coarse } = build(budget);
      return { origin: "request", scope: target?.path ? { kind: "file", ...target } : { kind: "call" }, sections: [section],
        ...(coarse ? { coarseComparison: true } : {}) };
    });
  };

  if (request.kind === "change.replacements") {
    for (const edit of request.requestedEdits) {
      const target = edit.path ? { path: edit.path } : undefined;
      append(target, budget => {
        const compared = requestedEditHunk(edit, budget);
        return { section: { kind: "hunks", ...(target ? { target } : {}), hunks: compared.hunk ? [compared.hunk] : [] }, coarse: compared.coarse };
      }, edit.fileContext);
    }
  } else if (request.kind === "change.patch") {
    const parsed = parseRequestedPatch(request);
    const sections = parsed && !parsed.scopeConflict ? parsed.sections : [{ kind: "raw" as const, sources: [{ text: request.text }] as const }];
    for (const section of sections) append(section.target, budget => {
      const refined = decorateSections([section], budget);
      return { section: refined.sections[0]!, coarse: refined.coarse };
    });
  } else return undefined;

  return { request, targets, source: budget => {
    const units: DiffViewUnit[] = [];
    return { targets, unit: index => units[index] ??= builders[index]!(budget) };
  } };
}

export function requestedChangeSource(request: RequestView, budget: ComparisonBudget, prepared?: PreparedRequestedChanges): RequestedChangeSource | undefined {
  return (prepared?.request === request ? prepared : prepareRequestedChanges(request))?.source(budget);
}
