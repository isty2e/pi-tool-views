import type { RequestView, ResultPart, ResultView, SuppliedToolResult } from "../presentation.ts";

interface CodeFooter {
  readonly offset: number;
  readonly suffix: string;
  readonly failed: boolean;
  readonly truncated: boolean;
  readonly parts: readonly ResultPart[];
  readonly bytes: number;
}
export interface CodeEnvelope extends CodeFooter { readonly index: number }

export function codeFooter(text: string): CodeFooter | undefined {
  const footer = /\n\nresult (ok|error)\n((?:diag severity=[^\n]*\n)*)usage tokens=(\d+) elapsed-ms=(\d+) bytes=(\d+) truncated=(true|false)\n?$/.exec(text);
  if (!footer || ![footer[3], footer[4], footer[5]].every(value => Number.isSafeInteger(Number(value)))) return undefined;

  const parts: ResultPart[] = footer[1] === "ok" ? [{ kind: "text", text: "\n\nresult ok\n", role: "receipt" }]
    : [{ kind: "notice", text: "result error", severity: "error", origin: "producer" }];
  for (const text of footer[2]!.split("\n").filter(Boolean)) {
    const severity = /^diag severity=(\w+)/.exec(text)?.[1];
    parts.push({ kind: "notice", text: text + "\n", origin: "producer", severity: severity === "error" || severity === "fatal" ? "error"
      : severity === "info" || severity === "hint" ? "info" : "warning" });
  }

  const suffix = text.slice(footer.index);
  const usage = suffix.slice(suffix.lastIndexOf("usage tokens="));
  parts.push({ kind: "text", text: usage, role: "usage" });
  if (footer[6] === "true") parts.push({ kind: "coverage", reason: "truncated", producerText: usage });
  return { offset: footer.index, suffix, failed: footer[1] === "error", truncated: footer[6] === "true", parts, bytes: Number(footer[5]) };
}

export function codeEnvelope(result: SuppliedToolResult, request: RequestView | undefined): CodeEnvelope | undefined {
  if (!request || !(request.kind.startsWith("code.") || request.kind === "search.ast" || request.kind === "search.symbols"
    || request.kind === "source.symbol" || request.kind === "source.enclosing" || request.kind === "change.structural")) return undefined;

  const texts = result.content.flatMap((item, index) => item.kind === "text" ? [{ text: item.text, index }] : []);
  const last = texts.at(-1);
  if (!last) return undefined;

  const footer = codeFooter(last.text);
  if (!footer) return undefined;
  const body = [...texts.slice(0, -1).map(item => item.text), last.text.slice(0, footer.offset)].join("\n");
  if (new TextEncoder().encode(body).length !== footer.bytes) return undefined;
  return { ...footer, index: last.index };
}

export function resultMetadata(view: ResultView, result: SuppliedToolResult, envelope: CodeEnvelope | undefined): ResultView {
  if (!envelope) return view;
  const usage = envelope.parts.find(part => part.kind === "text" && part.role === "usage");
  if (usage?.kind === "text" && view.parts.some(part => part.kind === "text" && part.role === "usage" && part.text === usage.text)) return view;

  const owner = view.parts.findLastIndex(part => (part.kind === "text" && !part.role && part.text.endsWith(envelope.suffix))
    || (part.kind === "original-content" && (!part.indexes || part.indexes.includes(envelope.index))));
  if (owner < 0) return view;

  const parts = view.parts.flatMap((part, partIndex): readonly ResultPart[] => {
    if (partIndex !== owner) return [part];
    if (part.kind === "text" && !part.role && part.text.endsWith(envelope.suffix)) {
      const prefix = part.text.slice(0, -envelope.suffix.length);
      return [...(prefix ? [{ kind: "text" as const, text: prefix }] : []), ...envelope.parts];
    }
    if (part.kind === "original-content") return (part.indexes ?? result.content.map((_, index) => index)).flatMap((index): readonly ResultPart[] => {
      if (index !== envelope.index) return [{ kind: "original-content", indexes: [index] }];
      const content = result.content[index];
      if (content?.kind !== "text") return [{ kind: "original-content", indexes: [index] }];
      const text = content.text.slice(0, envelope.offset);
      return [...(text ? [{ kind: "text" as const, text }] : []), ...envelope.parts];
    });
    return [part];
  });
  return { ...view, parts: parts as [ResultPart, ...ResultPart[]] };
}
