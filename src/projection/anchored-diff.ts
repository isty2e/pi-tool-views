import { parseUnified } from "../diff/formats.ts";
import type { DiffLineIdentifier, ResultPart, SuppliedToolResult } from "../presentation.ts";
import { object } from "./schema.ts";

export function anchoredDiffIdentifiers(result: SuppliedToolResult, part: Extract<ResultPart, { kind: "diff" }>): readonly DiffLineIdentifier[] {
  const details = object(result.details), metrics = object(details?.metrics);
  const numbered = part.representations.numbered, unified = part.representations.unified;
  if (result.isError || part.origin !== "reported" || typeof numbered !== "string" || !unified
    || details?.diff !== numbered || metrics?.classification !== "applied") return [];
  const parsed = parseUnified(unified);
  if (!parsed || parsed.scopeConflict) return [];

  const candidates = new Map<string, number[]>();
  const add = (path: string, side: "before" | "after", text: string, line1: number | undefined) => {
    if (line1 === undefined) return;
    const key = JSON.stringify([path, side, text]);
    const lines = candidates.get(key);
    if (lines) lines.push(line1);
    else candidates.set(key, [line1]);
  };
  for (const section of parsed.sections) {
    const path = section.target?.path;
    if (!path || section.kind !== "hunks") continue;
    for (const hunk of section.hunks) for (const block of hunk.blocks) {
      if (block.kind === "context") add(path, "after", block.text, block.newLine1);
      else if (block.kind === "change") for (const pair of block.pairs) {
        if (pair.before) add(path, "before", pair.before.text, pair.before.line1);
        if (pair.after) add(path, "after", pair.after.text, pair.after.line1);
      }
    }
  }

  const locations = new Map<string, DiffLineIdentifier | undefined>();
  const paths = new Set(parsed.sections.flatMap(section => section.target?.path ? [section.target.path] : []));
  let path: string | undefined = paths.size === 1 ? [...paths][0] : undefined;
  for (const row of numbered.split("\n")) {
    const header = /^--- (.+) ---$/.exec(row);
    if (header) { path = header[1]; continue; }
    const match = /^([ +\-])([a-z]{5})│(.*)$/.exec(row);
    if (!path || !match) continue;
    const side = match[1] === "-" ? "before" : "after";
    const lines = candidates.get(JSON.stringify([path, side, match[3]]));
    if (lines?.length === 1) {
      const location: DiffLineIdentifier = { path, side, line1: lines[0]!, identifier: match[2]! };
      const key = JSON.stringify([path, side, location.line1]);
      const previous = locations.get(key);
      if (!locations.has(key)) locations.set(key, location);
      else if (previous?.identifier !== location.identifier) locations.set(key, undefined);
    }
  }
  return [...locations.values()].filter((location): location is DiffLineIdentifier => location !== undefined);
}
