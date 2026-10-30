import type { QueryObservation, ReportedChange, RequestView, WebAction } from "./presentation.ts";
import type { DiffPresentation, DiffViewUnit } from "./diff/model.ts";
import { compoundRequestUnits } from "./diff/compose.ts";
import type { ComparisonOptions } from "./diff/compare.ts";

export type OperationView =
  | { readonly kind: "edit"; readonly activity: ReportedChange["activity"]; readonly path?: string; readonly moveTo?: string; readonly diff: DiffPresentation }
  | { readonly kind: "web"; readonly action: WebAction; readonly observation?: QueryObservation }
  | { readonly kind: "fetch"; readonly url: string };

export interface OperationPresentation {
  readonly items: readonly OperationView[];
  readonly remainder: DiffPresentation;
  readonly collapsedReported?: DiffPresentation;
  readonly collapsedInline?: true;
}

function requestedEdits(request: RequestView, plan: DiffPresentation, options: ComparisonOptions): OperationView[] {
  if (request.kind === "change.replacements" && request.requestedEdits.length < 2) return [];
  return compoundRequestUnits(request, plan, options).map(unit => {
    const section = unit.sections[0]!;
    const path = section.target?.path;
    const moveTo = section.target?.moveTo;
    return { kind: "edit", activity: section.activity ?? "updated", ...(path ? { path } : {}),
      ...(moveTo ? { moveTo } : {}), diff: { units: [unit], applicationReports: [], context: [] } };
  });
}

function requestedWeb(request: RequestView): OperationView[] {
  if (request.kind === "web.compound") return request.actions.map(action => ({ kind: "web", action }));
  if (request.kind === "web.search" && request.input.kind === "multiple") {
    return request.input.queries.map(query => ({ kind: "web", action: { kind: "search", query } }));
  }
  if (request.kind === "web.source-check") {
    return request.queries?.map(query => ({ kind: "web", action: { kind: "search", query } })) ?? [];
  }
  if (request.kind === "web.fetch" && request.targets.kind === "multiple") {
    return request.targets.urls.map(url => ({ kind: "fetch", url }));
  }
  return [];
}

function counts(values: readonly (string | undefined)[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const value of values) if (value !== undefined) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function buildOperationPresentation(request: RequestView, plan: DiffPresentation, options: ComparisonOptions = {}, resultComplete = true): OperationPresentation {
  const items = request.kind === "change.patch" || request.kind === "change.replacements"
    ? requestedEdits(request, plan, options) : requestedWeb(request);
  if (items.length < 2) return { items: [], remainder: plan };

  if (resultComplete && plan.reportedCoversRequest) return {
    items,
    remainder: { units: [], applicationReports: plan.applicationReports, context: plan.context },
    collapsedReported: { units: plan.units, applicationReports: [], context: [] },
  };

  if (resultComplete && plan.inlineCoversRequest) return {
    items,
    remainder: { units: [], applicationReports: plan.applicationReports, context: plan.context },
    collapsedInline: true,
  };

  const pathCounts = counts(items.flatMap(item => item.kind === "edit" ? [...new Set([item.path, item.moveTo])] : []));
  const reported = plan.units.filter(unit => unit.origin !== "request");
  const reportedCounts = counts(reported.map(unit => unit.scope.kind === "file" ? unit.scope.path : undefined));
  const allocated = new Set<DiffViewUnit>();
  const byPath = new Map(reported.flatMap(unit => unit.scope.kind === "file" ? [[unit.scope.path, unit] as const] : []));

  const queryOf = (item: OperationView) => item.kind === "web" && (item.action.kind === "search" || item.action.kind === "image-search")
    ? item.action.query : undefined;
  const queryCounts = counts(items.map(queryOf));
  const observations = plan.context.flatMap(part => part.kind === "query-results" ? part.items : []);
  const observationCounts = counts(observations.map(observation => observation.query));
  const byQuery = new Map(observations.map(observation => [observation.query, observation]));
  const assignedQueries = new Set<QueryObservation>();

  const associated = items.map((item): OperationView => {
    if (item.kind === "edit" && item.path && pathCounts.get(item.path) === 1
      && (!item.moveTo || pathCounts.get(item.moveTo) === 1) && reportedCounts.get(item.path) === 1) {
      const unit = byPath.get(item.path)!;
      const paths = unit.sections.map(section => section.target?.path ?? item.path);
      const destinations = unit.sections.map(section => section.target?.moveTo ?? (unit.scope.kind === "file" ? unit.scope.moveTo : undefined));
      if (!unit.ambiguousAssociation && paths.every(path => path === item.path) && destinations.every(destination => destination === item.moveTo)) {
        allocated.add(unit);
        return { ...item, diff: { ...item.diff, units: [unit] } };
      }
    }
    const query = queryOf(item);
    if (item.kind === "web" && item.action.kind === "search" && query !== undefined
      && queryCounts.get(query) === 1 && observationCounts.get(query) === 1) {
      const observation = byQuery.get(query)!;
      assignedQueries.add(observation);
      return { ...item, observation };
    }
    return item;
  });

  return { items: associated, remainder: { ...plan,
    units: reported.filter(unit => !allocated.has(unit)),
    context: plan.context.flatMap<DiffPresentation["context"][number]>(part => {
      if (part.kind !== "query-results") return [part];
      const remaining = part.items.filter(item => !assignedQueries.has(item));
      return remaining.length || part.responseId || part.fetchId ? [{ ...part, items: remaining }] : [];
    }),
  } };
}
