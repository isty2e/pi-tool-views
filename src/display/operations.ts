import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OperationView } from "../operations.ts";
import type { QueryObservation } from "../presentation.ts";
import { wrap } from "./text.ts";

export function operationTitle(operation: OperationView): { readonly label: string; readonly target?: string } {
  if (operation.kind === "edit") {
    const label = { added: "Add", updated: "Edit", deleted: "Delete", moved: "Move" }[operation.activity];
    return { label, ...(operation.path ? { target: operation.path + (operation.moveTo ? ` → ${operation.moveTo}` : "") } : {}) };
  }
  if (operation.kind === "fetch") return { label: "Fetch", target: operation.url };
  const action = operation.action;
  switch (action.kind) {
    case "search": return { label: "Search", target: action.query };
    case "image-search": return { label: "Search images", target: action.query };
    case "open": return { label: "Open", target: action.reference + (action.line !== undefined ? ` (L${action.line})` : "") };
    case "find": return { label: "Find", target: `${action.pattern} · ${action.reference}` };
    case "click": return { label: "Open link", target: `${action.reference} · ${action.linkId}` };
    case "lookup": return { label: { finance: "Finance", sports: "Sports", weather: "Weather", time: "Time", screenshot: "Screenshot" }[action.section] };
  }
}

export function queryObservationLines(observation: QueryObservation, width: number, theme: Theme): string[] {
  return [
    ...(observation.answer ? wrap(observation.answer, width) : []),
    ...(observation.error ? wrap(observation.error, width).map(line => theme.fg("error", line)) : []),
    ...(observation.sources?.flatMap(source => [
      ...wrap(source.title ? `${source.title} · ${source.url}` : source.url, width),
      ...(source.snippet ? wrap(source.snippet, width) : []),
    ]) ?? []),
  ];
}
