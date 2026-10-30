import type { EffectiveDeclaration, FileMatchRow, JsonObject, RequestView, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { hasPhrase, object } from "./schema.ts";

type MatchLine = Extract<FileMatchRow, { kind: "line" }>;
type LocatedRow = { readonly path: string; readonly row: MatchLine };

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function prefixedRow(line: string, native: boolean): LocatedRow | undefined {
  if (/unable to read|error reading|failed to read/i.test(line)) return undefined;
  const candidates: LocatedRow[] = [];
  for (let index = 1; index < line.length - 1; index++) {
    const delimiter = line[index];
    if (delimiter !== ":" && delimiter !== "-") continue;
    const match = (delimiter === ":" ? /^(\d+):/ : /^(\d+)-/).exec(line.slice(index + 1));
    if (!match || !positive(Number(match[1]))) continue;
    const body = line.slice(index + 1 + match[0].length);
    candidates.push({ path: line.slice(0, index), row: { kind: "line", line1: Number(match[1]),
      text: native && body.startsWith(" ") ? body.slice(1) : body, role: delimiter === ":" ? "match" : "context" } });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function groupedRow(line: string): MatchLine | undefined {
  const match = /^ (\d+)([:-]) (.*)$/.exec(line);
  return match && positive(Number(match[1])) ? { kind: "line", line1: Number(match[1]), text: match[3]!,
    role: match[2] === ":" ? "match" : "context" } : undefined;
}

function hashRow(line: string, context: boolean): MatchLine | undefined {
  const match = /^(\d+)#([a-z0-9]{2,4}):(.*)$/i.exec(line);
  return match && positive(Number(match[1])) ? { kind: "line", line1: Number(match[1]), identifier: match[2]!,
    text: match[3]!, role: context ? "unreported" : "match" } : undefined;
}

function coalesceRows(input: readonly FileMatchRow[]): [FileMatchRow, ...FileMatchRow[]] {
  const rows: FileMatchRow[] = [];
  let seen = new Map<string, number>();
  let last: number | undefined;
  for (const row of input) {
    if (row.kind === "gap") {
      rows.push(row);
      seen = new Map();
      last = undefined;
      continue;
    }
    if (row.line1 !== undefined && last !== undefined && row.line1 > last + 1) {
      rows.push({ kind: "gap", text: "…" });
      seen = new Map();
    }
    const key = row.line1 === undefined ? undefined : JSON.stringify([row.line1, row.text, row.identifier]);
    const prior = key === undefined ? undefined : seen.get(key);
    if (prior === undefined) {
      if (key !== undefined) seen.set(key, rows.length);
      rows.push(row);
    } else if (row.role === "match") rows[prior] = row;
    last = row.line1 === undefined ? undefined : Math.max(last ?? row.line1, row.line1);
  }
  return rows as [FileMatchRow, ...FileMatchRow[]];
}

export function searchContinuation(text: string, details: JsonObject | undefined): ResultPart {
  const count = details?.matchLimitReached;
  const expected: string[] = [];
  if (typeof count === "number" && positive(count)) expected.push(`${count} matches limit reached. Use limit=${count * 2} for more, or refine pattern`);
  const bytes = /(?:^|\. )([\d.]+ ?[kKmMgG]?[bB] limit reached)(?=\. |\]$)/.exec(text.trim().slice(1));
  if (object(details?.truncation)?.truncated === true && bytes) expected.push(bytes[1]!);
  const lines = /Some lines truncated to ([1-9]\d*) chars\. Use read tool to see full lines/.exec(text);
  if (details?.linesTruncated === true && lines && positive(Number(lines[1]))) expected.push(lines[0]);
  const native = expected.length > 0 && text.trim() === `[${expected.join(". ")}]`;
  const paged = /^\s*\[(?:Continue with cursor="[^"\r\n]+"|\d+\+ matches \(refine patterns\)\. More available\. cursor="[^"\r\n]+" to continue|\d+ more matches available\. cursor="[^"\r\n]+" to continue)\]\s*$/.test(text);
  if (native
    || (paged && nonnegative(details?.totalMatched) && nonnegative(details?.totalFiles))) {
    return { kind: "coverage", reason: native ? bytes || lines ? "truncated" : "limit" : "continuation", producerText: text };
  }
  return { kind: "text", text };
}

function parseSearchText(text: string, declaration: EffectiveDeclaration, details: JsonObject | undefined,
  request: RequestView | undefined): readonly ResultPart[] | undefined {
  const grouped = nonnegative(details?.totalMatched) && nonnegative(details?.totalFiles);
  const hash = hasPhrase(declaration.description, "line#hash:content")
    && nonnegative(details?.matches) && nonnegative(details?.files) && typeof details?.truncated === "boolean";
  const native = hasPhrase(declaration.description, "returns matching lines with file paths and line numbers");
  const context = request?.kind !== "search.text" && request?.kind !== "search.literal-any" || (request.contextLines ?? 0) !== 0;
  const tokens = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter(token => token[0]);
  const parts: ResultPart[] = [];
  let path: string | undefined, annotation: string | undefined;
  let rows: FileMatchRow[] = [], raw = "";
  let found = false;
  const flushRows = () => {
    if (path !== undefined && rows.length) {
      parts.push({ kind: "file-matches", groups: [{ path, ...(annotation ? { annotation } : {}), rows: coalesceRows(rows) }] });
      found = true;
    }
    path = undefined;
    annotation = undefined;
    rows = [];
  };
  const flushRaw = () => {
    if (raw) parts.push(searchContinuation(raw, details));
    raw = "";
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]![0], line = token.replace(/\r\n$|[\r\n]$/, "");
    const next = tokens[index + 1]?.[0].replace(/\r\n$|[\r\n]$/, "");
    if ((grouped && next !== undefined && groupedRow(next)) || (hash && next !== undefined && hashRow(next, context))) {
      const heading = hash ? /^(.+):$/.exec(line) : /^(\S.*?)(?: {2}(\[[^\r\n]+\]))?$/.exec(line);
      if (heading && !(grouped && groupedRow(line)) && !(hash && hashRow(line, context))) {
        flushRows();
        flushRaw();
        path = heading[1]!;
        annotation = heading[2];
        continue;
      }
    }
    const local = path !== undefined ? hash ? hashRow(line, context) : grouped ? groupedRow(line) : undefined : undefined;
    if (local) { rows.push(local); continue; }
    if (hash && path !== undefined && /^\s+\.\.\.$/.test(line)) { rows.push({ kind: "gap", text: line }); continue; }
    if (hash && line === "---" && rows.length) { flushRows(); continue; }
    const prefixed = prefixedRow(line, native);
    if (prefixed) {
      flushRaw();
      if (path !== prefixed.path) flushRows();
      path = prefixed.path;
      rows.push(prefixed.row);
      continue;
    }
    flushRows();
    const summary = hash && /^(\d+) match(?:es)? in (\d+) files?\.(?: \(truncated at \d+\))?$/.exec(line);
    if (summary && Number(summary[1]) === details?.matches && Number(summary[2]) === details?.files) {
      flushRaw();
      parts.push({ kind: "text", text: token });
      if (details?.truncated === true) parts.push({ kind: "coverage", reason: "limit" });
    } else raw += token;
  }
  flushRows();
  flushRaw();
  return found ? parts : undefined;
}

export function searchTextParts(result: SuppliedToolResult, declaration: EffectiveDeclaration,
  request: RequestView | undefined): readonly ResultPart[] | undefined {
  if (result.isError) return undefined;
  const details = object(result.details);
  let found = false;
  const parts = result.content.flatMap((content, index): readonly ResultPart[] => {
    const parsed = content.kind === "text" ? parseSearchText(content.text, declaration, details, request) : undefined;
    if (parsed) { found = true; return parsed; }
    return [{ kind: "original-content", indexes: [index] }];
  });
  return found ? parts : undefined;
}
