import type { ChangedLinePair, DiffBlock, DiffCell, DiffHunk, DiffSection } from "./model.ts";
import type { RequestView } from "../presentation.ts";
import { locationLabel } from "../location-label.ts";

interface PatchLine {
  readonly text: string;
}

interface RowRecord {
  readonly kind: "context" | "remove" | "add";
  readonly text: string;
  readonly oldLine1?: number;
  readonly newLine1?: number;
  readonly newLabel?: string;
  lineEnding?: "";
}

export interface ParsedPatch {
  readonly sections: readonly DiffSection[];
  readonly scopeConflict?: true;
}

function patchLines(text: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    lines.push({ text: text.slice(start, index) });
    if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
    start = index + 1;
  }

  if (start < text.length) lines.push({ text: text.slice(start) });
  return lines;
}

function decodePath(header: string, prefix: "a/" | "b/"): string | undefined {
  const withoutTimestamp = header.split("\t", 1)[0];
  if (withoutTimestamp === undefined || withoutTimestamp.length === 0 || withoutTimestamp.startsWith('"')) return undefined;
  if (withoutTimestamp === "/dev/null") return withoutTimestamp;
  return withoutTimestamp.startsWith(prefix) ? withoutTimestamp.slice(prefix.length) : withoutTimestamp;
}

function cell(record: RowRecord, side: "old" | "new"): DiffCell {
  return {
    text: record.text,
    ...(side === "old" && record.oldLine1 === undefined ? {} : side === "old" ? { line1: record.oldLine1 } : {}),
    ...(side === "new" && record.newLine1 === undefined ? {} : side === "new" ? { line1: record.newLine1 } : {}),
    ...(side === "new" && record.newLabel !== undefined ? { locationLabel: record.newLabel } : {}),
    ...(record.lineEnding === undefined ? {} : { lineEnding: record.lineEnding }),
    emphasis: [],
  };
}

function makeHunk(records: readonly RowRecord[], anchor?: string): DiffHunk | undefined {
  const blocks: DiffBlock[] = [];
  let removed: RowRecord[] = [];
  let added: RowRecord[] = [];

  const flushChanged = (): void => {
    if (removed.length === 0 && added.length === 0) return;
    const pairs = [];
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      const before = removed[index];
      const after = added[index];
      pairs.push(before === undefined
        ? { after: cell(after!, "new") }
        : after === undefined
          ? { before: cell(before, "old") }
          : { before: cell(before, "old"), after: cell(after, "new") });
    }
    blocks.push({ kind: "change", pairs: pairs as [ChangedLinePair, ...ChangedLinePair[]] });
    removed = [];
    added = [];
  };

  for (const record of records) {
    if (record.kind === "context") {
      flushChanged();
      blocks.push({
        kind: "context",
        text: record.text,
        ...(record.oldLine1 === undefined ? {} : { oldLine1: record.oldLine1 }),
        ...(record.newLine1 === undefined ? {} : { newLine1: record.newLine1 }),
        ...(record.newLabel === undefined ? {} : { newLabel: record.newLabel }),
        ...(record.lineEnding === undefined ? {} : { lineEnding: record.lineEnding }),
      });
    } else if (record.kind === "remove") removed.push(record);
    else added.push(record);
  }

  flushChanged();
  if (blocks.length === 0) return undefined;
  return { ...(anchor === undefined || anchor.length === 0 ? {} : { anchor }), blocks: blocks as [DiffBlock, ...DiffBlock[]] };
}

function setNoNewline(records: RowRecord[]): boolean {
  const last = records.at(-1);
  if (last === undefined || last.lineEnding === "") return false;
  last.lineEnding = "";
  return true;
}

function parseRange(value: string): { readonly start: number; readonly count: number } | undefined {
  const match = /^(\d+)(?:,(\d+))?$/.exec(value);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(count) &&
    (count === 0 || start + count - 1 <= Number.MAX_SAFE_INTEGER)
    ? { start, count }
    : undefined;
}

const unifiedHunk = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(?: ?(.*))?$/;

export function parseUnified(text: string): ParsedPatch | undefined {
  const lines = patchLines(text);
  const sections: DiffSection[] = [];
  let index = 0;
  let pendingOldMode = false;
  let pendingNewMode = false;
  let pendingRenameFrom: string | undefined;
  let pendingRenameTo: string | undefined;
  let pendingGitPaths: { readonly oldPath: string; readonly newPath: string } | undefined;
  let pendingIndex: string | undefined;

  while (index < lines.length) {
    const line = lines[index]!.text;
    if (line.startsWith("Index: ")) {
      const path = line.slice(7);
      if (pendingIndex !== undefined || pendingGitPaths !== undefined || !path || path.startsWith('"') || path.includes("\t")
        || !/^={3,}$/.test(lines[index + 1]?.text ?? "")) return undefined;
      pendingIndex = path;
      index += 2;
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const gitHeader = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      if (gitHeader === null || pendingGitPaths !== undefined) return { sections: [], scopeConflict: true };
      pendingGitPaths = { oldPath: gitHeader[1]!, newPath: gitHeader[2]! };
      index += 1;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      pendingOldMode = true;
      index += 1;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      pendingNewMode = true;
      index += 1;
      continue;
    }
    if (line.startsWith("rename from ")) {
      pendingRenameFrom = line.slice("rename from ".length);
      index += 1;
      continue;
    }
    if (line.startsWith("rename to ")) {
      pendingRenameTo = line.slice("rename to ".length);
      index += 1;
      continue;
    }
    if (!line.startsWith("--- ")) return undefined;

    const oldPath = decodePath(line.slice(4), "a/");
    const plus = lines[index + 1]?.text;
    if (oldPath === undefined || plus === undefined || !plus.startsWith("+++ ")) return undefined;
    const newPath = decodePath(plus.slice(4), "b/");
    if (newPath === undefined) return undefined;
    if (oldPath === "/dev/null" && newPath === "/dev/null") return undefined;
    if (pendingIndex !== undefined && pendingIndex !== oldPath && pendingIndex !== newPath) return { sections: [], scopeConflict: true };
    pendingIndex = undefined;

    const currentGitPaths = pendingGitPaths;
    pendingGitPaths = undefined;
    if (currentGitPaths !== undefined &&
      ((oldPath !== "/dev/null" && oldPath !== currentGitPaths.oldPath) ||
        (newPath !== "/dev/null" && newPath !== currentGitPaths.newPath))) {
      return { sections: [], scopeConflict: true };
    }
    index += 2;

    let oldMode = pendingOldMode;
    let newMode = pendingNewMode;
    let renamedFrom = pendingRenameFrom;
    let renamedTo = pendingRenameTo;
    pendingOldMode = false;
    pendingNewMode = false;
    pendingRenameFrom = undefined;
    pendingRenameTo = undefined;
    const hunks: DiffHunk[] = [];

    while (index < lines.length) {
      const metadata = lines[index]!.text;
      if (metadata.startsWith("@@ ")) {
        const match = unifiedHunk.exec(metadata);
        if (match === null) return undefined;
        const oldRange = parseRange(match[1]!);
        const newRange = parseRange(match[2]!);
        if (oldRange === undefined || newRange === undefined) return undefined;
        if ((oldRange.count > 0 && oldRange.start < 1) || (newRange.count > 0 && newRange.start < 1)) return undefined;

        let oldLine1 = oldRange.start;
        let newLine1 = newRange.start;
        let oldRead = 0;
        let newRead = 0;
        const records: RowRecord[] = [];
        index += 1;

        while (true) {
          const body = lines[index]?.text;
          if (body === "\\ No newline at end of file") {
            if (!setNoNewline(records)) return undefined;
            index += 1;
            continue;
          }
          if (oldRead === oldRange.count && newRead === newRange.count) break;
          if (body === undefined) return undefined;

          const marker = body[0];
          const content = body.slice(1);
          if (marker === " " && oldRead < oldRange.count && newRead < newRange.count) {
            records.push({ kind: "context", text: content, oldLine1, newLine1 });
            oldRead += 1;
            newRead += 1;
            oldLine1 += 1;
            newLine1 += 1;
          } else if (marker === "-" && oldRead < oldRange.count) {
            records.push({ kind: "remove", text: content, oldLine1 });
            oldRead += 1;
            oldLine1 += 1;
          } else if (marker === "+" && newRead < newRange.count) {
            records.push({ kind: "add", text: content, newLine1 });
            newRead += 1;
            newLine1 += 1;
          } else return undefined;
          index += 1;
        }

        const hunk = makeHunk(records, match[3]);
        if (hunk === undefined) return undefined;
        hunks.push(hunk);
        continue;
      }

      if (metadata === "" && hunks.length > 0) {
        let next = index;
        while (lines[next]?.text === "") next++;
        const header = lines[next]?.text;
        if ((header?.startsWith("--- ") && lines[next + 1]?.text.startsWith("+++ ")) || header?.startsWith("diff --git ") || header?.startsWith("Index: ")) {
          index = next;
          break;
        }
        return undefined;
      }
      if (metadata.startsWith("--- ") || metadata.startsWith("diff --git ") || metadata.startsWith("Index: ")) break;

      if (metadata.startsWith("deleted file mode ")) oldMode = true;
      else if (metadata.startsWith("new file mode ")) newMode = true;
      else if (metadata.startsWith("rename from ")) renamedFrom = metadata.slice("rename from ".length);
      else if (metadata.startsWith("rename to ")) renamedTo = metadata.slice("rename to ".length);
      else return undefined;
      index += 1;
    }

    const sourcePath = oldPath === "/dev/null" ? newPath : oldPath;
    const destinationPath = newPath === "/dev/null" ? undefined : newPath;
    if ((renamedFrom !== undefined && renamedFrom !== sourcePath) ||
      (renamedTo !== undefined && renamedTo !== destinationPath)) return { sections: [], scopeConflict: true };
    if ((newMode && oldPath !== "/dev/null") || (oldMode && newPath !== "/dev/null") || (newMode && oldMode)) return undefined;
    const moved = renamedFrom !== undefined || renamedTo !== undefined ||
      (destinationPath !== undefined && sourcePath !== destinationPath && oldPath !== "/dev/null");
    const targetPath = renamedFrom ?? sourcePath;
    const moveTo = renamedTo ?? (moved ? destinationPath : undefined);
    const activity = moved ? "moved" : oldPath === "/dev/null" || newMode ? "added" : newPath === "/dev/null" || oldMode ? "deleted" : "updated";

    if (hunks.length === 0 && !moved && !newMode && !oldMode && oldPath !== "/dev/null" && newPath !== "/dev/null") return undefined;
    sections.push({
      kind: "hunks",
      target: { path: targetPath, ...(moveTo === undefined ? {} : { moveTo }) },
      activity,
      hunks,
    });
  }

  if (pendingGitPaths !== undefined || pendingIndex !== undefined) return { sections: [], scopeConflict: true };
  return sections.length === 0 ? undefined : { sections };
}

const codexHeader = /^\*\*\* (Update|Add|Delete) File: (.+)$/;

export function parseRequestedPatch(request: Extract<RequestView, { readonly kind: "change.patch" }>): ParsedPatch | undefined {
  if (request.format === "codex") return parseCodex(request.text);
  if (request.format === "unified") return parseUnified(request.text);
  return parseUnified(request.text) ?? parseCodex(request.text);
}

export function parseCodex(text: string): ParsedPatch | undefined {
  const lines = patchLines(text);
  if (lines[0]?.text !== "*** Begin Patch" || lines.at(-1)?.text !== "*** End Patch") return undefined;

  const sections: DiffSection[] = [];
  let index = 1;
  const end = lines.length - 1;

  while (index < end) {
    const header = lines[index]!.text;
    const match = codexHeader.exec(header);
    if (match === null) return undefined;
    const action = match[1]!;
    const path = match[2]!;
    if (path.length === 0) return undefined;
    index += 1;

    let moveTo: string | undefined;
    if (action === "Update" && lines[index]?.text.startsWith("*** Move to: ")) {
      moveTo = lines[index]!.text.slice("*** Move to: ".length);
      if (moveTo.length === 0) return undefined;
      index += 1;
    }

    const hunks: DiffHunk[] = [];
    if (action === "Update") {
      while (index < end && lines[index]!.text.startsWith("@@")) {
        const hunkHeader = lines[index]!.text;
        const anchor = hunkHeader === "@@" ? undefined : hunkHeader.slice(2).replace(/\s@@$/, "").trim();
        if (hunkHeader !== "@@" && !hunkHeader.endsWith("@@") && !/^@@ .+/.test(hunkHeader)) return undefined;
        index += 1;
        const records: RowRecord[] = [];

        while (index < end && !lines[index]!.text.startsWith("@@") && codexHeader.exec(lines[index]!.text) === null) {
          const body = lines[index]!.text;
          if (body === "*** End of File" || body === "\\ No newline at end of file") {
            if (!setNoNewline(records)) return undefined;
            index += 1;
            continue;
          }

          const marker = body[0];
          if (marker === " ") records.push({ kind: "context", text: body.slice(1) });
          else if (marker === "-") records.push({ kind: "remove", text: body.slice(1) });
          else if (marker === "+") records.push({ kind: "add", text: body.slice(1) });
          else return undefined;
          index += 1;
        }

        const hunk = makeHunk(records, anchor);
        if (hunk === undefined) return undefined;
        hunks.push(hunk);
      }

      if (hunks.length === 0 && moveTo === undefined) return undefined;
    } else {
      const expected = action === "Add" ? "+" : "-";
      const records: RowRecord[] = [];
      while (index < end && codexHeader.exec(lines[index]!.text) === null) {
        const body = lines[index]!.text;
        if (body === "*** End of File" || body === "\\ No newline at end of file") {
          if (!setNoNewline(records)) return undefined;
          index += 1;
          continue;
        }
        if (body[0] !== expected) return undefined;
        records.push({ kind: expected === "+" ? "add" : "remove", text: body.slice(1) });
        index += 1;
      }

      const hunk = makeHunk(records);
      if (hunk !== undefined) hunks.push(hunk);
    }

    sections.push({
      kind: "hunks",
      target: { path, ...(moveTo === undefined ? {} : { moveTo }) },
      activity: action === "Add" ? "added" : action === "Delete" ? "deleted" : moveTo === undefined ? "updated" : "moved",
      hunks,
    });
  }

  return sections.length === 0 ? undefined : { sections };
}

function numberedRecord(line: string, hashWidth?: number): RowRecord | undefined {
  if (hashWidth !== undefined) {
    const labelled = /^([+ ])\s*(\d+)#([a-z0-9]+):(.*)$/i.exec(line);
    if (labelled) {
      const line1 = Number(labelled[2]);
      if (!Number.isSafeInteger(line1) || line1 < 1 || labelled[3]!.length !== hashWidth) return undefined;
      return { kind: labelled[1] === "+" ? "add" : "context", text: labelled[4]!, newLine1: line1,
        newLabel: locationLabel(line1, labelled[3]!) };
    }
    const removed = new RegExp(`^-\\s*(\\d+) {${hashWidth + 2}}(.*)$`).exec(line);
    if (!removed) return undefined;
    const line1 = Number(removed[1]);
    return Number.isSafeInteger(line1) && line1 > 0 ? { kind: "remove", text: removed[2]!, oldLine1: line1 } : undefined;
  }
  const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
  if (match === null) return undefined;
  const line1 = Number(match[2]);
  if (!Number.isSafeInteger(line1) || line1 < 1) return undefined;
  const kind = match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context";
  return {
    kind,
    text: match[3]!,
    ...(kind === "remove" ? { oldLine1: line1 } : kind === "add" ? { newLine1: line1 } : { oldLine1: line1, newLine1: line1 }),
  };
}

function oldContextPositions(records: readonly RowRecord[]): readonly RowRecord[] {
  let consumed = 0;
  let start: number | undefined;
  for (const record of records) {
    if (record.kind === "add") continue;
    if (record.oldLine1 !== undefined) {
      const candidate = record.oldLine1 - consumed;
      if (!Number.isSafeInteger(candidate) || candidate < 1 || (start !== undefined && start !== candidate)) return records;
      start = candidate;
    }
    consumed++;
  }
  if (start === undefined || !Number.isSafeInteger(start + consumed)) return records;
  let offset = 0;
  return records.map(record => {
    if (record.kind === "add") return record;
    const line1 = start + offset++;
    return record.kind === "context" && record.oldLine1 === undefined ? { ...record, oldLine1: line1 } : record;
  });
}

export function parseNumbered(text: string): ParsedPatch | undefined {
  const lines = patchLines(text);
  if (lines.length === 0) return undefined;
  const labelled = lines.flatMap(line => {
    const match = /^[+ ]\s*\d+#([a-z0-9]+):/i.exec(line.text);
    return match ? [match[1]!] : [];
  });
  const hashWidth = labelled.length ? labelled[0]!.length : undefined;
  if (hashWidth !== undefined && (hashWidth < 2 || hashWidth > 4 || labelled.some(value => value.length !== hashWidth))) return undefined;
  const records: RowRecord[] = [];
  const sections: DiffSection[] = [];
  const blocks: DiffBlock[] = [];
  let oldLast: number | undefined;
  let newLast: number | undefined;
  let hasChange = false;

  const flushRows = (): void => {
    if (records.length === 0) return;
    const hunk = makeHunk(hashWidth === undefined ? records : oldContextPositions(records));
    if (hunk !== undefined) blocks.push(...hunk.blocks);
    records.length = 0;
  };

  const flushSection = (): void => {
    flushRows();
    if (blocks.length > 0) {
      sections.push({ kind: "hunks", hunks: [{ blocks: [...blocks] as [DiffBlock, ...DiffBlock[]] }] });
      blocks.length = 0;
    }
    oldLast = undefined;
    newLast = undefined;
  };

  for (const line of lines) {
    if (/^\s+\.\.\.$/.test(line.text)) {
      flushRows();
      blocks.push({ kind: "gap" });
      oldLast = undefined;
      newLast = undefined;
      continue;
    }

    const row = numberedRecord(line.text, hashWidth);
    if (row === undefined) return undefined;
    if (row.kind !== "context") hasChange = true;

    const oldNumber = row.oldLine1;
    const newNumber = row.newLine1;
    const restarted = (oldNumber !== undefined && oldLast !== undefined && oldNumber <= oldLast)
      || (newNumber !== undefined && newLast !== undefined && newNumber <= newLast);
    if (restarted) flushSection();

    const continuingChangedRun = hashWidth === undefined && row.kind !== "context" && records.length > 0 && records.at(-1)?.kind !== "context";
    const hasNumberGap = !continuingChangedRun && ((oldNumber !== undefined && oldLast !== undefined && oldNumber > oldLast + 1) ||
      (newNumber !== undefined && newLast !== undefined && newNumber > newLast + 1));

    if (hasNumberGap && !(records.length === 0 && blocks.at(-1)?.kind === "gap")) {
      flushRows();
      blocks.push({ kind: "gap" });
      oldLast = undefined;
      newLast = undefined;
    }

    if (oldNumber !== undefined) oldLast = oldNumber;
    else if (row.kind === "context" && oldLast !== undefined) oldLast++;
    if (newNumber !== undefined) newLast = newNumber;
    records.push(row);
  }

  flushSection();
  if (!hasChange || sections.length === 0) return undefined;
  return { sections };
}

/** Locate complete unified diff fragments without consuming surrounding result text. */
export function embeddedUnifiedSpans(text: string): readonly { readonly start: number; readonly end: number }[] {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter(match => match[0].length > 0)
    .map(match => ({ text: match[0].replace(/\r\n$|[\r\n]$/, ""), start: match.index!, end: match.index! + match[0].length }));
  const spans: { start: number; end: number }[] = [];
  let index = 0;

  while (index + 2 < lines.length) {
    if (!lines[index]!.text.startsWith("--- ") || !lines[index + 1]!.text.startsWith("+++ ")
      || !unifiedHunk.test(lines[index + 2]!.text)) {
      index++;
      continue;
    }

    const start = index;
    let cursor = index;
    let valid = true;
    do {
      cursor += 2;
      while (cursor < lines.length && lines[cursor]!.text.startsWith("@@ ")) {
        const header = unifiedHunk.exec(lines[cursor]!.text);
        const oldRange = header ? parseRange(header[1]!) : undefined;
        const newRange = header ? parseRange(header[2]!) : undefined;
        if (!oldRange || !newRange) { valid = false; break; }
        cursor++;
        let oldRead = 0;
        let newRead = 0;
        while (oldRead < oldRange.count || newRead < newRange.count) {
          const marker = lines[cursor]?.text[0];
          if (marker === " " && oldRead < oldRange.count && newRead < newRange.count) { oldRead++; newRead++; }
          else if (marker === "-" && oldRead < oldRange.count) oldRead++;
          else if (marker === "+" && newRead < newRange.count) newRead++;
          else if (lines[cursor]?.text === "\\ No newline at end of file") { cursor++; continue; }
          else { valid = false; break; }
          cursor++;
        }
        if (!valid) break;
        if (lines[cursor]?.text === "\\ No newline at end of file") cursor++;
      }
      if (!valid) break;
    } while (lines[cursor]?.text.startsWith("--- ") && lines[cursor + 1]?.text.startsWith("+++ ")
      && unifiedHunk.test(lines[cursor + 2]?.text ?? ""));

    const end = lines[cursor - 1]?.end;
    if (valid && end !== undefined) {
      const parsed = parseUnified(text.slice(lines[start]!.start, end));
      if (parsed && !parsed.scopeConflict) spans.push({ start: lines[start]!.start, end });
    }
    index = Math.max(start + 1, cursor);
  }
  return spans;
}
