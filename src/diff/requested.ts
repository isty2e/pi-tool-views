import type { RequestView } from "../presentation.ts";
import type { ComparisonBudget } from "./compare.ts";
import { decorateSections } from "./compare.ts";
import { parseRequestedPatch } from "./formats.ts";
import type { DiffSection, DiffViewUnit } from "./model.ts";
import { requestedEditHunk } from "./requested-edit.ts";

export interface RequestedChangeSource {
  readonly targets: readonly DiffSection["target"][];
  readonly unit: (index: number) => DiffViewUnit;
}

/** Build each occurrence at most once within the containing comparison budget, including no-op occurrences. */
export function requestedChangeSource(request: RequestView, budget: ComparisonBudget): RequestedChangeSource | undefined {
  const builders: (() => DiffViewUnit)[] = [];
  const targets: DiffSection["target"][] = [];
  const append = (target: DiffSection["target"], build: () => { readonly section: DiffSection; readonly coarse: boolean }) => {
    targets.push(target);
    builders.push(() => {
      const { section, coarse } = build();
      return { origin: "request", scope: target?.path ? { kind: "file", ...target } : { kind: "call" }, sections: [section],
        ...(coarse ? { coarseComparison: true } : {}) };
    });
  };

  if (request.kind === "change.replacements") {
    for (const edit of request.requestedEdits) {
      const target = edit.path ? { path: edit.path } : undefined;
      append(target, () => {
        const compared = requestedEditHunk(edit, budget);
        return { section: { kind: "hunks", ...(target ? { target } : {}), hunks: compared.hunk ? [compared.hunk] : [] }, coarse: compared.coarse };
      });
    }
  } else if (request.kind === "change.patch") {
    const parsed = parseRequestedPatch(request);
    const sections = parsed && !parsed.scopeConflict ? parsed.sections : [{ kind: "raw" as const, sources: [{ text: request.text }] as const }];
    for (const section of sections) append(section.target, () => {
      const refined = decorateSections([section], budget);
      return { section: refined.sections[0]!, coarse: refined.coarse };
    });
  } else return undefined;

  const units: DiffViewUnit[] = [];
  return { targets, unit: index => units[index] ??= builders[index]!() };
}
