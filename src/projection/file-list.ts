import type { EffectiveDeclaration, RequestView, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { hasPhrase, object } from "./schema.ts";
import { searchContinuation } from "./search-text.ts";

export function fileListParts(result: SuppliedToolResult, declaration: EffectiveDeclaration,
  request: RequestView | undefined): readonly ResultPart[] | undefined {
  if (result.isError || (request?.kind !== "search.files" && request?.kind !== "search.list")
    || result.content.length !== 1 || result.content[0]?.kind !== "text") return undefined;
  const details = object(result.details);
  if (object(details?.truncation)?.truncated === true) return undefined;
  const grouped = typeof details?.totalMatched === "number" && Number.isSafeInteger(details.totalMatched) && details.totalMatched >= 0
    && typeof details?.totalFiles === "number" && Number.isSafeInteger(details.totalFiles) && details.totalFiles >= 0;
  const directory = request.kind === "search.list" && hasPhrase(declaration.description, "list directory contents")
    && hasPhrase(declaration.description, "suffix for directories");
  const native = request.kind === "search.files" && hasPhrase(declaration.description, "returns matching file paths relative to the search directory");
  if (!grouped && !native && !directory) return undefined;
  const text = result.content[0].text;
  if (!text || text === "(empty directory)" || text === "No files found matching pattern") return undefined;
  const [body, ...trailer] = text.split(/\r?\n\r?\n/);
  if (!body || trailer.length > 1) return undefined;
  const entries: Extract<ResultPart, { kind: "file-list" }>["entries"][number][] = [];
  for (const line of body.replace(/\r?\n$/, "").split(/\r?\n/)) {
    if (!line) return undefined;
    const annotated = grouped ? /^(.*?)(?: {2}(\[[^\r\n]+\]))?$/.exec(line) : undefined;
    const path = annotated?.[1] ?? line;
    entries.push({ path: directory && path.endsWith("/") ? path.slice(0, -1) : path,
      ...(directory && path.endsWith("/") ? { directory: true } : {}), ...(annotated?.[2] ? { annotation: annotated[2] } : {}) });
  }
  const suffix = trailer.length ? text.slice(body.length) : "";
  let continuation: ResultPart | undefined;
  if (suffix) {
    continuation = searchContinuation(suffix, details);
    const cap = /^\s*\[(\d+) (results|entries) limit reached\. Use limit=(\d+) for more\]\s*$/.exec(suffix);
    const count = directory ? details?.entryLimitReached : details?.resultLimitReached;
    if (cap && Number(cap[1]) === count && Number(cap[3]) === Number(cap[1]) * 2) {
      continuation = { kind: "coverage", reason: "limit", producerText: suffix };
    }
    if (continuation.kind !== "coverage") return undefined;
  }
  return [{ kind: "file-list", entries }, ...(continuation ? [continuation] : [])];
}
