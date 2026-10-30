import type { RequestView, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { object } from "./schema.ts";

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function anchoredRead(result: SuppliedToolResult, request: RequestView | undefined): readonly ResultPart[] | undefined {
  if (result.isError || request?.kind !== "source.lines" || !request.lineEncoding || request.lineEncoding === "plain"
    || result.content.length !== 1 || result.content[0]?.kind !== "text") return undefined;
  const details = object(result.details);
  if (object(details?.truncation)?.truncated === true) return undefined;
  const text = result.content[0].text;
  if (request.lineEncoding === "anchor") {
    const first = details?.offset;
    const metrics = object(details?.metrics);
    if (!positive(first) || metrics?.truncated !== false) return undefined;
    const footer = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)\. Use offset=([a-z]{5}) to continue\.\]$/.exec(text);
    const body = footer ? text.slice(0, footer.index) : text;
    const rows = body.split("\n").map(line => /^([a-z]{5})│(.*)$/.exec(line));
    if (!rows.length || rows.some(row => !row)) return undefined;
    const last = first + rows.length - 1;
    if (!Number.isSafeInteger(last) || (footer && (Number(footer[1]) !== first || Number(footer[2]) !== last
      || !positive(Number(footer[3])) || Number(footer[3]) <= last || footer[4] !== rows.at(-1)![1]
      || details?.nextOffset !== last + 1))) return undefined;
    if (!footer && details?.nextOffset !== undefined) return undefined;
    if (metrics?.next_offset !== undefined && metrics.next_offset !== details?.nextOffset) return undefined;
    return [{ kind: "source", path: request.path, source: { text: rows.map(row => row![2]).join("\n"),
      firstLine1: first, lineIdentifiers: rows.map(row => row![1]!) } }];
  }

  const footer = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\]$/.exec(text);
  const body = footer ? text.slice(0, footer.index) : text;
  const rows = body.split("\n").map(line => /^(\d+)#([a-z0-9]{2,4}):(.*)$/i.exec(line));
  if (!rows.length || rows.some(row => !row)) return undefined;
  const first = Number(rows[0]![1]), last = first + rows.length - 1;
  if (!positive(first) || !positive(last) || rows.some((row, index) => Number(row![1]) !== first + index)
    || (request.firstLine1 !== undefined && request.firstLine1 !== first)
    || (request.lineLimit !== undefined && (!positive(request.lineLimit) || rows.length > request.lineLimit))
    || (details?.nextOffset !== undefined && details.nextOffset !== last + 1)
    || (footer && (Number(footer[1]) !== first || Number(footer[2]) !== last || !positive(Number(footer[3]))
      || Number(footer[3]) <= last || Number(footer[4]) !== last + 1))) return undefined;
  return [{ kind: "source", path: request.path, source: { text: rows.map(row => row![3]).join("\n"),
    firstLine1: first, lineIdentifiers: rows.map(row => row![2]!) } },
    ...(footer ? [{ kind: "notice" as const, text: text.slice(footer.index), severity: "info" as const, origin: "producer" as const }] : [])];
}
