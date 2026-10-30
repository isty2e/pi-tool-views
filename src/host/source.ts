import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { effectiveDeclaration, suppliedResult } from "./result.ts";
import { toJson } from "../json.ts";
import type { EffectiveDeclaration, Json, SuppliedToolResult } from "../presentation.ts";

export interface SessionReader {
  getSessionId(): string;
  getLeafId(): string | null;
  getEntry(id: string): SessionEntry | undefined;
  getBranch(): SessionEntry[];
}

export interface CallSource {
  readonly key: string;
  readonly entryId: string;
  readonly ordinal: number;
  readonly call: ToolCall;
  readonly eligible: boolean;
  readonly declaration: EffectiveDeclaration | undefined;
  readonly declarations?: ReadonlyMap<string, EffectiveDeclaration | undefined>;
  readonly result: SuppliedToolResult | undefined;
  readonly resultEntryId: string | undefined;
}

export interface ChildSource {
  readonly key: string;
  readonly parentKey: string;
  readonly rootParentId: string;
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly arguments: Json | undefined;
  readonly declaration: EffectiveDeclaration | undefined;
  readonly settled: boolean;
  readonly isError?: boolean;
}

interface Occurrence {
  readonly anchor: string | null;
  calls: readonly { readonly ordinal: number; readonly id: string; readonly name: string; readonly args: unknown }[];
  entryId: string | undefined;
}

export interface RowIdentity {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

function callsOf(message: AssistantMessage): Occurrence["calls"] {
  return message.content.flatMap((part, ordinal) => part.type === "toolCall"
    ? [{ ordinal, id: part.id, name: part.name, args: part.arguments }]
    : []);
}

function assistant(entry: SessionEntry | undefined): entry is SessionMessageEntry & { message: AssistantMessage } {
  return entry?.type === "message" && entry.message.role === "assistant";
}

export class SourceIndex {
  private session = "";
  private leaf: string | null = null;
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private calls = new Map<string, CallSource>();
  private references = new WeakMap<object, string[]>();
  private currentCalls: string[] = [];
  private activeChildren = new Map<string, ChildSource | undefined>();
  private storedChildren = new Map<string, ChildSource[]>();
  private storedChildIdsByParent = new Map<string, Set<string>>();
  private childParentIds = new Set<string>();
  private recordedParentIds = new Set<string>();
  private incompleteParents = new Set<string>();
  private currentConflicts = new Set<string>();
  private declarations = new Map<string, EffectiveDeclaration | undefined>();
  private declarationsDirty = true;
  private occurrence: Occurrence | undefined;
  revision = 0;
  generation = 0;

  refresh(reader: SessionReader, force = false): boolean {
    const session = reader.getSessionId();
    const leaf = reader.getLeafId();
    const sameSession = session === this.session;
    if (typeof session !== "string" || (leaf !== null && typeof leaf !== "string")) {
      throw new Error("Synchronous session source lookup is unavailable.");
    }
    if (!force && session === this.session && leaf === this.leaf) return false;

    let appended: SessionEntry[] = [];
    let parent = leaf;
    const visited = new Set<string>();
    if (session === this.session) {
      while (parent !== this.leaf && parent !== null && !visited.has(parent)) {
        visited.add(parent);
        const entry = reader.getEntry(parent);
        if (!entry) break;
        appended.push(entry);
        parent = entry.parentId;
      }
    }

    const extendsBranch = !force && session === this.session && parent === this.leaf;
    if (!extendsBranch) {
      const oldCalls = this.calls, oldEntries = this.byId, oldChildren = this.activeChildren, oldOccurrence = this.occurrence;
      this.entries = reader.getBranch();
      this.byId = new Map(this.entries.map(entry => [entry.id, entry]));
      this.session = session;
      this.occurrence = undefined;
      this.calls = new Map();
      this.references = new WeakMap();
      this.currentCalls = [];
      this.declarations = new Map();
      this.storedChildren = new Map();
      this.storedChildIdsByParent = new Map();
      this.childParentIds = new Set();
      this.recordedParentIds = new Set();
      this.incompleteParents = new Set();
      this.currentConflicts = new Set();
      this.activeChildren = new Map();
      this.declarationsDirty = true;
      this.generation++;
      appended = this.entries;
      this.leaf = leaf;
      this.indexSources(appended);
      if (force && sameSession) for (const [id, child] of oldChildren) {
        if (!child) { this.activeChildren.set(id, undefined); continue; }
        const oldParent = oldCalls.get(child.parentKey), parent = this.calls.get(child.parentKey);
        const oldResult = oldParent?.resultEntryId ? oldEntries.get(oldParent.resultEntryId) : undefined;
        const result = parent?.resultEntryId ? this.byId.get(parent.resultEntryId) : undefined;
        if (oldParent && parent && oldParent.call === parent.call && oldResult === result) {
          this.activeChildren.set(id, child);
          this.childParentIds.add(parent.call.id);
        }
      }
      if (force && sameSession && oldOccurrence?.entryId && oldOccurrence.calls.every(call => {
        const key = this.key(oldOccurrence.entryId!, call.ordinal);
        return oldCalls.get(key)?.call === this.calls.get(key)?.call && this.calls.has(key);
      })) this.occurrence = oldOccurrence;
      this.revision++;
      return true;
    } else {
      appended = appended.reverse();
      this.entries.push(...appended);
      for (const entry of appended) this.byId.set(entry.id, entry);
    }

    this.leaf = leaf;
    this.indexSources(appended);
    this.revision++;
    return true;
  }

  start(message: AssistantMessage): void {
    this.occurrence = { anchor: this.leaf, calls: callsOf(message), entryId: undefined };
  }

  observe(message: AssistantMessage): void {
    if (!this.occurrence) this.start(message);
    else this.occurrence.calls = callsOf(message);
  }

  commitOccurrence(): void {
    const occurrence = this.occurrence;
    if (!occurrence || occurrence.entryId) return;
    const suffix: SessionEntry[] = [];
    let current = this.leaf;
    while (current !== occurrence.anchor && current !== null) {
      const entry = this.byId.get(current);
      if (!entry) return;
      suffix.push(entry);
      current = entry.parentId;
    }
    if (current !== occurrence.anchor) return;

    const candidates = suffix.filter(assistant).filter(entry => occurrence.calls.length > 0 && occurrence.calls.every(slot => {
      const part = entry.message.content[slot.ordinal];
      return part?.type === "toolCall" && part.id === slot.id && part.name === slot.name;
    }));
    if (candidates.length === 1) occurrence.entryId = candidates[0]?.id;
  }

  source(key: string): CallSource | undefined {
    return this.calls.get(key);
  }

  observed(row: RowIdentity): boolean {
    return this.occurrence?.calls.some(slot => slot.id === row.id && slot.name === row.name && slot.args === row.args) ?? false;
  }

  associate(row: RowIdentity, allowLive: boolean): CallSource | undefined {
    const occurrence = this.occurrence;
    if (allowLive && occurrence) {
      if (occurrence.entryId) {
        const slots = occurrence.calls.filter(slot => slot.id === row.id && slot.name === row.name);
        if (slots.length === 1) return this.calls.get(this.key(occurrence.entryId, slots[0]!.ordinal));
      }
      return undefined;
    }

    if (row.args === null || typeof row.args !== "object") return undefined;
    const matches = (this.references.get(row.args) ?? []).flatMap(key => {
      const source = this.calls.get(key);
      return source?.call.id === row.id && source.call.name === row.name ? [source] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  finish(): void {
    this.commitOccurrence();
  }

  reset(): void {
    this.session = "";
    this.leaf = null;
    this.entries = [];
    this.byId.clear();
    this.calls.clear();
    this.references = new WeakMap();
    this.currentCalls = [];
    this.activeChildren.clear();
    this.storedChildren.clear();
    this.storedChildIdsByParent.clear();
    this.childParentIds.clear();
    this.recordedParentIds.clear();
    this.incompleteParents.clear();
    this.currentConflicts.clear();
    this.declarations.clear();
    this.declarationsDirty = true;
    this.occurrence = undefined;
    this.generation++;
    this.revision++;
  }

  private key(entryId: string, ordinal: number): string {
    return JSON.stringify([this.session, entryId, ordinal]);
  }

  startChild(parentId: string, id: string, name: string, args: unknown): void {
    if (this.activeChildren.has(id)) { this.activeChildren.set(id, undefined); return; }
    const occurrence = this.occurrence;
    const roots = occurrence?.entryId ? occurrence.calls.filter(call => call.id === parentId)
      .map(call => this.calls.get(this.key(occurrence.entryId!, call.ordinal))).filter((call): call is CallSource => !!call) : [];
    const parentChild = this.activeChildren.get(parentId);
    const parent = roots.length === 1 && !parentChild ? roots[0] : roots.length === 0 && parentChild ? this.calls.get(parentChild.parentKey) : undefined;
    if (!parent) return;
    this.childParentIds.add(parent.call.id);
    let observed: Json | undefined;
    try { observed = toJson(args); } catch { observed = undefined; }
    this.activeChildren.set(id, { key: JSON.stringify([parent.key, "child", id, name]), parentKey: parent.key, rootParentId: parent.call.id, id, name, parentId,
      arguments: observed, declaration: this.currentConflicts.has(name) ? undefined : parent.declarations?.get(name), settled: false });
  }

  endChild(parentId: string, id: string, name: string, isError: boolean): void {
    const child = this.activeChildren.get(id);
    if (!child) return;
    if (child.parentId !== parentId || child.name !== name || child.settled) {
      this.activeChildren.set(id, undefined);
      return;
    }
    this.activeChildren.set(id, { ...child, settled: true, isError });
  }

  updateChild(parentId: string, id: string, name: string): boolean {
    const child = this.activeChildren.get(id);
    if (!child) return false;
    if (child.parentId !== parentId || child.name !== name || child.settled) {
      this.activeChildren.set(id, undefined);
      return false;
    }
    return true;
  }

  associateChild(id: string, name: string): ChildSource | undefined {
    if (this.activeChildren.has(id) && this.activeChildren.get(id) === undefined) return undefined;
    const live = this.activeChildren.get(id);
    const stored = this.storedChildren.get(id) ?? [];
    if (stored.length > 1 || (live && stored[0] && (live.key !== stored[0].key || live.name !== stored[0].name))) return undefined;
    const byKey = new Map<string, ChildSource>();
    if (live?.name === name && this.calls.get(live.parentKey)?.resultEntryId === undefined && this.calls.has(live.parentKey)) byKey.set(live.key, live);
    for (const child of stored) if (child.name === name) byKey.set(child.key, child);
    return byKey.size === 1 ? [...byKey.values()][0] : undefined;
  }

  finishChildren(): void { this.activeChildren.clear(); }

  hasChildParent(id: string): boolean { return this.childParentIds.has(id); }

  hasRecordedParent(id: string): boolean { return this.recordedParentIds.has(id); }

  parentIncomplete(key: string | undefined): boolean { return key !== undefined && this.incompleteParents.has(key); }

  private indexSources(added: readonly SessionEntry[]): void {
    const firstPosition = this.entries.length - added.length;
    for (const [offset, entry] of added.entries()) {
      const position = firstPosition + offset;
      if (assistant(entry)) {
        if (this.declarationsDirty) {
          const prefix = this.entries.slice(0, position);
          this.declarations = new Map(getCurrentTools(buildSessionProjection(prefix).messages)
            .map(tool => [tool.name, effectiveDeclaration(tool)]));
          this.declarationsDirty = false;
        }
        this.currentCalls = [];
        this.currentConflicts = new Set();
        for (const [ordinal, part] of entry.message.content.entries()) {
          if (part.type !== "toolCall") continue;
          const source: CallSource = {
            key: this.key(entry.id, ordinal), entryId: entry.id, ordinal, call: part,
            eligible: ["toolUse", "stop", "deferred"].includes(entry.message.stopReason)
              && part.argumentsError === undefined,
            declaration: this.declarations.get(part.name),
            declarations: this.declarations,
            result: undefined, resultEntryId: undefined,
          };
          this.currentCalls.push(source.key);
          this.calls.set(source.key, source);
          const args = part.arguments;
          if (args && typeof args === "object") {
            this.references.set(args, [...(this.references.get(args) ?? []), source.key]);
          }
        }
      } else if (entry.type === "message" && entry.message.role === "toolResult") {
        const message = entry.message;
        const candidates = this.currentCalls.flatMap(key => {
          const source = this.calls.get(key);
          return source?.call.id === message.toolCallId && source.call.name === message.toolName ? [source] : [];
        });
        if (candidates.length !== 1) continue;
        const previous = candidates[0]!;
        const source = { ...previous, result: suppliedResult(message, message.isError, message.durationMs), resultEntryId: entry.id };
        this.calls.set(source.key, source);
        for (const id of this.storedChildIdsByParent.get(source.key) ?? []) {
          const children = this.storedChildren.get(id) ?? [];
          const retained = children.filter(child => child.parentKey !== source.key);
          if (retained.length) this.storedChildren.set(id, retained);
          else this.storedChildren.delete(id);
        }
        this.storedChildIdsByParent.delete(source.key);
        const nested = message.nestedCalls;
        this.incompleteParents.delete(source.key);
        if (nested) {
          this.childParentIds.add(source.call.id);
          this.recordedParentIds.add(source.call.id);
          if (nested.complete === false) this.incompleteParents.add(source.key);
        }
        if (nested && Array.isArray(nested.calls)) for (const record of nested.calls) {
          if (typeof record.id !== "string" || typeof record.name !== "string") continue;
          this.childParentIds.add(source.call.id);
          this.recordedParentIds.add(source.call.id);
          const ids = this.storedChildIdsByParent.get(source.key) ?? new Set<string>();
          ids.add(record.id);
          this.storedChildIdsByParent.set(source.key, ids);
          let args: Json | undefined;
          try { args = toJson(record.arguments); } catch { args = undefined; }
          const child: ChildSource = { key: JSON.stringify([source.key, "child", record.id, record.name]), parentKey: source.key, rootParentId: source.call.id,
            id: record.id, name: record.name, arguments: args,
            declaration: this.currentConflicts.has(record.name) ? undefined : source.declarations?.get(record.name),
            settled: record.status === "ok" || record.status === "error",
            ...(record.status === "ok" || record.status === "error" ? { isError: record.status === "error" } : {}) };
          const existing = this.storedChildren.get(record.id) ?? [];
          existing.push(child);
          this.storedChildren.set(record.id, existing);
        }
      } else if (entry.type === "compaction" || entry.type === "context_edit"
        || (entry.type === "message" && entry.message.role === "system")) {
        if (entry.type === "message" && entry.message.role === "system") {
          for (const value of [...(entry.message.toolsAdded ?? []), ...(entry.message.toolsRemoved ?? [])]) {
            if (typeof value.name === "string") {
              this.currentConflicts.add(value.name);
            }
          }
        }
        this.declarationsDirty = true;
      }
    }
  }
}
