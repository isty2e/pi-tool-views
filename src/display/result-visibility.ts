import type { ResultPart } from "../presentation.ts";

export function visibleResultParts(parts: readonly ResultPart[], hideReceipts: boolean): readonly ResultPart[] {
  const visible: ResultPart[] = [];
  const coverage = new Set<Extract<ResultPart, { kind: "coverage" }>["reason"]>();
  const append = (part: ResultPart) => {
    if (part.kind === "coverage") {
      if (coverage.has(part.reason)) return;
      coverage.add(part.reason);
    }
    visible.push(part);
  };

  for (const part of parts) {
    if (part.kind === "text") {
      if (part.role === "usage" || (part.role === "receipt" && hideReceipts)) continue;
      if (part.role === "continuation") { append({ kind: "coverage", reason: "continuation", producerText: part.text }); continue; }
    }
    if (part.kind === "edit-receipt" && hideReceipts) {
      const text = part.prefix + (part.prefix ? part.suffix : part.suffix.replace(/^(?:\r?\n){1,2}/, ""));
      if (text) append({ kind: "text", text });
      continue;
    }
    if (part.kind === "changes" && hideReceipts && part.application?.outcome === "reported-complete") {
      const { application: _application, ...changes } = part;
      append(changes);
    } else append(part);
  }

  return visible;
}

export const coverageLabels = {
  limit: "Result limit reached.",
  truncated: "Output truncated.",
  continuation: "Continuation available.",
} as const;
