import type { DiffHunk, DiffPresentation, DiffViewUnit } from "../diff/model.ts";
import type { FileObservations } from "../diff/observed-context.ts";
import type { CapturedFiles } from "./file-observations.ts";
import type { PreparedFiles, PreparedFileTarget } from "./file-targets.ts";
import type { ObservationMaterial } from "../display/row.ts";
import { fileReference } from "../projection/file-context.ts";

export function observedMaterial(material: ObservationMaterial, files: PreparedFiles, captured: CapturedFiles): {
  readonly plan: DiffPresentation;
  readonly observations: ReadonlyMap<DiffHunk, FileObservations>;
} {
  const observations = new Map<DiffHunk, FileObservations>();
  const shared = new Map<string, FileObservations>();
  const context = "fileContext" in files.request ? files.request.fileContext : undefined;
  const observation = (target: Pick<PreparedFileTarget, "before" | "after">): FileObservations => {
    const key = JSON.stringify([target.before, target.after]);
    let value = shared.get(key);
    if (!value) {
      const before = target.before.kind === "local" ? captured.before.get(target.before.absolutePath)?.text : undefined;
      const after = target.after.kind === "local" ? captured.after.get(target.after.absolutePath)?.text : undefined;
      value = { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
      shared.set(key, value);
    }
    return value;
  };
  const append = (unit: DiffViewUnit, explicit?: PreparedFileTarget) => {
    if (unit.ambiguousAssociation || unit.scope.kind !== "file") return;
    for (const section of unit.sections) {
      if (section.kind !== "hunks") continue;
      const path = section.target?.path ?? unit.scope.path;
      const moveTo = section.target?.moveTo ?? unit.scope.moveTo;
      const candidates = explicit ? [explicit] : files.targets.filter(target => target.path === path || target.moveTo === path);
      const addresses = new Set(candidates.map(target => JSON.stringify([target.before, target.after])));
      if (!explicit && addresses.size > 1) continue;
      const target = explicit ?? candidates[0] ?? { path, before: fileReference(path, files.directory, context),
        after: fileReference(moveTo ?? path, files.directory, context) };
      for (const hunk of section.hunks) if (!observations.has(hunk)) observations.set(hunk, observation(target));
    }
  };
  const targetsByOperation = new Map(files.targets.map(target => [target.operationIndex, target]));
  material.plan.compoundRequest?.units.forEach((unit, index) => append(unit, targetsByOperation.get(index)));
  for (const unit of [...material.plan.units, ...material.inline.flatMap(plan => plan.units)]) append(unit);
  return { plan: { ...material.plan, units: [...material.plan.units, ...material.inline.flatMap(plan => plan.units)] }, observations };
}
