import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { ToolViewRow } from "../display/row.ts";
import type { LocalChoices, RenderContext, RowServices } from "../display/row.ts";
import { SettingsStore } from "../settings/store.ts";
import { defaults } from "../settings/model.ts";
import { SettingsMenu } from "../settings/menu.ts";
import { InspectionMenu } from "../display/inspection.ts";
import { SourceIndex } from "./source.ts";
import { suppliedResult } from "./result.ts";
import { CallPreparations } from "./prepared.ts";
import type { PreparedRequest } from "./prepared.ts";
import type { CallSource, ChildSource } from "./source.ts";
import { FileObservations } from "./file-observations.ts";
import { prepareFiles } from "./file-targets.ts";
import { observedMaterial } from "./observed-material.ts";
import { observeDiffContext } from "../diff/observed-context.ts";
import type { ObservedHunks } from "../diff/observed-context.ts";
import { settingsChoices } from "../settings/model.ts";

export type PresentationEngine = Pick<RowServices, "compile" | "compare" | "renderDiff">;
interface RowRecord {
  readonly row: ToolViewRow;
  resultContent: unknown;
  resultDetails: unknown;
  resultError: boolean | undefined;
  resultDuration: number | undefined;
  resultPartial: boolean | undefined;
  resultStale: boolean;
}
type CaptureBinding =
  | { readonly kind: "direct"; readonly source: CallSource; readonly id: string; readonly name: string; readonly key: string }
  | { readonly kind: "child"; readonly source: ChildSource; readonly parent: CallSource; readonly parentId: string; readonly id: string; readonly name: string; readonly key: string };
interface RetainedObservation { readonly rows: readonly WeakRef<ToolViewRow>[]; readonly observed: WeakRef<ObservedHunks>; readonly bytes: number }

export class ToolViewsRuntime {
  private readonly pi: ExtensionAPI;
  private readonly engine: PresentationEngine;
  private readonly source = new SourceIndex();
  private readonly preparations: CallPreparations;
  private readonly observations: FileObservations;
  private readonly captures = new Map<string, CaptureBinding>();
  private readonly scheduledCaptures = new Map<string, number>();
  private readonly retainedObservations = new Map<number, RetainedObservation>();
  private readonly observationIds = new WeakMap<ObservedHunks, number>();
  private observationCounter = 0;
  private observationBytes = 0;
  private observationEpoch = 0;
  private enrichment = Promise.resolve();
  private readonly localChoices = new Map<string, LocalChoices>();
  private rows = new WeakMap<object, RowRecord>();
  private readonly activeRows = new Set<WeakRef<RowRecord>>();
  private readonly stops: (() => void)[] = [];
  private store: SettingsStore | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private rowCounter = 0;
  private directStart: { readonly id: string; readonly name: string } | undefined;
  private nestedRevalidate = false;
  private lastDiagnostic: string | undefined;
  private stopped = false;

  constructor(pi: ExtensionAPI, engine: PresentationEngine, observations = new FileObservations()) {
    this.pi = pi;
    this.engine = engine;
    this.preparations = new CallPreparations(engine);
    this.observations = observations;
  }

  install(): void {
    this.pi.registerToolRenderer((name, next) => {
      const native = next();
      if (native && !native.renderCall && !native.renderResult && this.store?.effective.diffMode === "native") return native;
      return {
        renderShell: "self",
        renderCall: (args: unknown, theme: Theme, context: RenderContext) => {
          const record = this.record(name, args, context, theme, native);
          record.row.capture(args, context, theme);
          this.associate(record.row);
          return record.row.callComponent;
        },
        renderResult: (result, _options, theme: Theme, context: RenderContext) => {
          const record = this.record(name, context.args, context, theme, native);
          const recheckCall = record.resultStale || record.resultPartial !== context.isPartial
            || record.resultError !== context.isError || record.resultDuration !== context.durationMs;
          const changed = record.resultStale || record.resultContent !== result.content || record.resultDetails !== result.details
            || record.resultError !== context.isError || record.resultDuration !== context.durationMs;
          record.row.capture(context.args, context, theme, changed ? suppliedResult(result, context.isError, context.durationMs) : undefined);
          record.resultContent = result.content;
          record.resultDetails = result.details;
          record.resultError = context.isError;
          record.resultDuration = context.durationMs;
          record.resultPartial = context.isPartial;
          record.resultStale = record.row.childPaused;
          this.associate(record.row);
          if (recheckCall && !record.row.childPaused) queueMicrotask(() => record.row.invalidate());
          return record.row.resultComponent;
        },
      };
    });

    const commandName = "tool-views";
    const subcommands = [
      { value: "inspect", description: "Inspect full tool arguments, source and results" },
      { value: "help", description: "Show command usage" },
    ] as const;
    const usage = [
      `/${commandName} — Preview settings`,
      ...subcommands.map(command => `/${commandName} ${command.value} — ${command.description}`),
    ].join("\n");

    this.pi.registerCommand(commandName, {
      description: `Preview settings; subcommands: ${subcommands.map(command => command.value).join(", ")}`,
      getArgumentCompletions: argumentPrefix => {
        const prefix = argumentPrefix.trimStart();
        return subcommands.filter(command => command.value.startsWith(prefix))
          .map(({ value, description }) => ({ value, label: value, description }));
      },
      handler: async (args, ctx) => {
        if (!ctx.hasUI) return;
        const argument = args.trim();
        const subcommand = subcommands.find(command => command.value === argument);
        if (argument && !subcommand) {
          ctx.ui.notify(`Unknown /${commandName} subcommand.\n${usage}`, "warning");
          return;
        }
        if (subcommand?.value === "help") {
          ctx.ui.notify(usage, "info");
          return;
        }

        this.ensure(ctx);
        if (!this.store) return;
        if (subcommand?.value === "inspect") {
          const records = new Map<string | ToolViewRow, RowRecord>();
          this.each(record => { if (record.row.acceptsInput) records.set(record.row.sourceKey ?? record.row, record); });
          const items = [...records.values()].map((record, index) => ({
            label: `${index + 1}. ${record.row.name}`,
            lines: (view: Parameters<ToolViewRow["inspectionLines"]>[0], width: number) => record.row.inspectionLines(view, width),
          }));
          await ctx.ui.custom<void>((tui, theme, _keys, done) => new InspectionMenu(items, theme,
            () => tui.requestRender(), () => done(), () => tui.terminal?.rows ?? 24));
          return;
        }
        const store = this.store;
        await ctx.ui.custom<void>((tui, theme, _keys, done) => new SettingsMenu(store, theme, () => tui.requestRender(), () => done(),
          () => tui.terminal?.rows ?? 24, () => this.lastDiagnostic));
      },
    });

    this.stops.push(this.pi.on("session_start", (_event, ctx) => {
      this.retire();
      this.ensure(ctx);
      this.refresh(ctx);
    }));
    this.stops.push(this.pi.on("message_start", (event, ctx) => {
      this.ensure(ctx);
      if (event.message.role !== "assistant") return;
      this.refresh(ctx);
      this.directStart = undefined;
      this.source.start(event.message);
    }));
    this.stops.push(this.pi.on("message_update", (event, ctx) => {
      this.ensure(ctx);
      if (event.message.role !== "assistant") return;
      this.source.observe(event.message);
      this.each(record => { if (this.source.observed(record.row.identity)) { record.row.live = true; record.row.markDirty(); } });
    }));
    this.stops.push(this.pi.on("message_end", (event, ctx) => {
      this.ensure(ctx);
      if (event.message.role === "assistant") this.source.observe(event.message);
      else if (event.message.role === "toolResult" && this.source.hasChildParent(event.message.toolCallId)) {
        const parentId = event.message.toolCallId;
        if (this.source.hasRecordedParent(parentId)) {
          this.nestedRevalidate = true;
          this.each(record => {
            if (record.row.childParentId === parentId) {
              record.resultStale = true;
              record.row.quarantineChild();
            }
          });
          this.refresh(ctx, true);
          this.reconcile();
        }
      }
    }));
    this.stops.push(this.pi.on("tool_execution_start", (event, ctx) => {
      this.ensure(ctx);
      if (event.parentToolCallId) {
        this.refresh(ctx);
        this.source.commitOccurrence();
        this.source.startChild(event.parentToolCallId, event.toolCallId, event.toolName, event.args);
        this.each(record => { if (this.associate(record.row)) record.row.invalidate(); });
        return;
      }
      this.directStart = { id: event.toolCallId, name: event.toolName };
      this.refresh(ctx);
      this.source.commitOccurrence();
      this.each(record => {
        if (this.associate(record.row)) record.row.invalidate();
      });
    }));
    this.stops.push(this.pi.on("tool_execution_update", (event, ctx) => {
      this.ensure(ctx);
      if (event.parentToolCallId && !this.source.updateChild(event.parentToolCallId, event.toolCallId, event.toolName)) {
        this.each(record => {
          if (record.row.id === event.toolCallId && this.associate(record.row)) record.row.invalidate();
        });
        return;
      }
      this.each(record => {
        if (record.row.id === event.toolCallId && record.row.name === event.toolName
          && (event.parentToolCallId ? record.row.childBound : record.row.running)) {
          record.resultStale = true;
          if (event.parentToolCallId) record.row.invalidateChildResult();
          record.row.markDirty();
        }
      });
    }));
    this.stops.push(this.pi.on("tool_call", async (event, ctx) => {
      this.refresh(ctx);
      this.source.commitOccurrence();
      if (!event.parentToolCallId) this.recheckPreparation(event.toolCallId, event.toolName, event.input);
      const binding = this.captureBinding(event.toolCallId, event.toolName, event.input, event.parentToolCallId);
      if (!binding) return;
      const prepared = this.executionPreparation(binding, event.input);
      if (!prepared.changes?.targets.some(target => target?.path)) return;
      this.captures.set(binding.key, binding);
      await this.observations.preflight(binding.key, prepareFiles(prepared, ctx.cwd));
      if (this.observations.directory(binding.key) === undefined && this.captures.get(binding.key) === binding) this.captures.delete(binding.key);
    }));
    this.stops.push(this.pi.on("tool_result", async event => {
      if (!event.parentToolCallId) this.recheckPreparation(event.toolCallId, event.toolName, event.input);
      const binding = this.activeCapture(event.toolCallId, event.toolName, event.parentToolCallId);
      if (!binding || !this.validCapture(binding)) return;
      const directory = this.observations.directory(binding.key);
      if (directory === undefined) return;
      await this.observations.executed(binding.key, prepareFiles(this.executionPreparation(binding, event.input), directory));
    }));
    this.stops.push(this.pi.on("tool_execution_end", (event, ctx) => {
      const binding = this.activeCapture(event.toolCallId, event.toolName, event.parentToolCallId);
      if (binding) {
        this.observations.finish(binding.key);
        if (this.observations.directory(binding.key) === undefined) this.captures.delete(binding.key);
      }
      if (!event.parentToolCallId) return;
      this.ensure(ctx);
      this.source.endChild(event.parentToolCallId, event.toolCallId, event.toolName, event.isError);
      this.each(record => {
        if (record.row.id === event.toolCallId) {
          const changed = this.associate(record.row);
          if (record.row.name !== event.toolName && !changed) return;
          record.resultStale = true;
          record.row.invalidateChildResult();
          record.row.markDirty();
          record.row.invalidate();
        }
      });
    }));
    this.stops.push(this.pi.on("turn_end", (_event, ctx) => {
      this.observations.completeTurn();
      this.refresh(ctx, this.nestedRevalidate);
      this.source.finish();
      this.source.finishChildren();
      this.nestedRevalidate = false;
      this.reconcile();
      this.each(record => { if (record.row.releaseChild()) record.row.invalidate(); });
      this.scheduleObservations();
    }));
    this.stops.push(this.pi.on("agent_end", (_event, ctx) => {
      this.observations.completeTurn();
      this.refresh(ctx, this.nestedRevalidate);
      this.source.finish();
      this.source.finishChildren();
      this.nestedRevalidate = false;
      this.reconcile();
      this.each(record => { if (record.row.releaseChild()) record.row.invalidate(); });
      this.scheduleObservations();
      this.directStart = undefined;
      this.stopTimer();
    }));
    this.stops.push(this.pi.on("agent_start", (_event, ctx) => {
      this.ensure(ctx);
      this.stopTimer();
      this.timer = setInterval(() => this.each(record => { if (record.row.running) record.row.invalidate(); }), 200);
      this.timer.unref();
    }));
    this.stops.push(this.pi.on("session_compact", (_event, ctx) => { this.refresh(ctx); this.reconcile(); }));
    this.stops.push(this.pi.on("session_tree", (_event, ctx) => { this.refresh(ctx); this.reconcile(); }));
    this.stops.push(this.pi.on("session_shutdown", () => this.dispose()));
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.retire();
    for (const stop of this.stops) stop();
    this.stops.length = 0;
  }

  private ensure(ctx: ExtensionContext): void {
    if (!this.store) {
      this.store = new SettingsStore(join(getAgentDir(), "tool-views.json"), join(ctx.cwd, ".pi", "tool-views.json"));
      this.store.subscribe(() => this.each(record => record.row.invalidate()));
    }
  }

  private record(name: string, args: unknown, context: RenderContext, theme: Theme, native: ToolRenderers | undefined): RowRecord {
    const state = context.state;
    const existing = state && typeof state === "object" ? this.rows.get(state) : undefined;
    if (existing) return existing;
    const settings = () => this.store?.effective ?? defaults;
    const row = new ToolViewRow(name, context.toolCallId, args, context, theme, {
      ...this.engine, settings, initialSettings: () => this.store?.committed ?? defaults,
      prepared: source => this.preparations.request(source),
      committed: source => this.preparations.committed(source),
      choices: (key, fallback) => {
        if (key.startsWith("unbound-")) return fallback;
        let choice = this.localChoices.get(key);
        if (!choice) { choice = { ...fallback }; this.localChoices.set(key, choice); }
        return choice;
      },
      home: homedir(), now: () => Date.now(),
    }, native, `unbound-${++this.rowCounter}`);
    const record: RowRecord = { row, resultContent: undefined, resultDetails: undefined,
      resultError: undefined, resultDuration: undefined, resultPartial: undefined, resultStale: true };
    if (state && typeof state === "object") this.rows.set(state, record);
    this.activeRows.add(new WeakRef(record));
    row.live = this.source.observed(row.identity) || (this.directStart?.id === row.id && this.directStart.name === row.name);
    return record;
  }

  private associate(row: ToolViewRow): boolean {
    const bound = row.sourceKey ? this.source.source(row.sourceKey) : undefined;
    const direct = bound ?? this.source.associate(row.identity, row.live);
    const child = this.source.associateChild(row.id, row.name);
    if (direct && child) return row.childBound ? row.bindChild(undefined) : row.bind(undefined);
    if (!child && row.childBound && this.source.parentIncomplete(row.childParentKey)) return row.demoteChild();
    if (child || row.childBound) return row.bindChild(child);
    return row.bind(direct);
  }

  private refresh(ctx: ExtensionContext, force = false): void {
    this.ensure(ctx);
    try {
      const generation = this.source.generation;
      this.source.refresh(ctx.sessionManager, force);
      this.lastDiagnostic = undefined;
      if (generation !== this.source.generation) {
        this.resetObservations();
        this.preparations.reset();
        this.each(record => {
          record.row.live = false;
          this.associate(record.row);
          record.row.invalidate();
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Session source lookup is unavailable.";
      if (this.lastDiagnostic !== message) this.lastDiagnostic = message;
      this.source.reset();
      this.preparations.reset();
      this.resetObservations();
      this.each(record => {
        record.row.live = false;
        if (record.row.childBound ? record.row.bindChild(undefined) : record.row.bind(undefined)) record.row.invalidate();
      });
    }
  }

  private reconcile(): void {
    this.each(record => {
      if (this.associate(record.row)) record.row.invalidate();
    });
  }

  private recheckPreparation(id: string, name: string, args: unknown): void {
    const source = this.source.associate({ id, name, args }, true);
    if (!source) return;
    this.preparations.invalidate(source);
    this.each(record => {
      if (record.row.sourceKey === source.key) {
        record.row.markDirty();
      }
    });
  }

  private captureBinding(id: string, name: string, args: unknown, parentId?: string): CaptureBinding | undefined {
    if (parentId) {
      const child = this.source.associateChild(id, name);
      const parent = child && this.source.source(child.parentKey);
      return child && child.arguments !== undefined && parent?.eligible ? { kind: "child", source: child, parent, parentId, id, name, key: child.key } : undefined;
    }
    const source = this.source.associate({ id, name, args }, true);
    return source?.eligible ? { kind: "direct", source, id, name, key: source.key } : undefined;
  }

  private activeCapture(id: string, name: string, parentId?: string): CaptureBinding | undefined {
    const matches = [...this.captures.values()].filter(binding => binding.id === id && binding.name === name
      && (binding.kind === "child" ? binding.parentId === parentId : parentId === undefined));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private validCapture(binding: CaptureBinding): boolean {
    if (binding.kind === "direct") return this.source.source(binding.key)?.call === binding.source.call;
    return this.source.source(binding.source.parentKey)?.call === binding.parent.call
      && this.source.associateChild(binding.id, binding.name)?.key === binding.key;
  }

  private executionPreparation(binding: CaptureBinding, input: unknown): PreparedRequest {
    return binding.kind === "direct" ? this.preparations.execution(binding.source, input)
      : this.preparations.prepare(binding.source.declaration, input);
  }

  private scheduleObservations(): void {
    for (const key of this.observations.keys()) {
      const epoch = this.observationEpoch;
      if (this.scheduledCaptures.get(key) === epoch) continue;
      this.scheduledCaptures.set(key, epoch);
      this.enrichment = this.enrichment.then(() => new Promise<void>(done => setTimeout(done, 0)))
        .then(() => this.enrichObservation(key, epoch)).catch(() => {}).finally(() => {
          if (this.scheduledCaptures.get(key) === epoch) this.scheduledCaptures.delete(key);
        });
    }
  }

  private async enrichObservation(key: string, epoch: number): Promise<void> {
    if (epoch !== this.observationEpoch) return;
    const binding = this.captures.get(key);
    const directory = this.observations.directory(key);
    if (!binding || directory === undefined || !this.validCapture(binding)) {
      this.observations.discard(key);
      this.captures.delete(key);
      return;
    }
    let prepared: PreparedRequest;
    if (binding.kind === "direct") {
      const source = this.source.source(key);
      if (!source) { this.observations.discard(key); this.captures.delete(key); return; }
      prepared = this.preparations.request(source);
    } else {
      const source = this.source.associateChild(binding.id, binding.name);
      if (!source) { this.observations.discard(key); this.captures.delete(key); return; }
      prepared = this.preparations.prepare(source.declaration, source.arguments);
    }
    const files = prepareFiles(prepared, directory);
    const captured = this.observations.take(key, files);
    if (!captured) { this.captures.delete(key); return; }
    const current = () => epoch === this.observationEpoch && this.captures.get(key) === binding && this.validCapture(binding);
    try {
      const rows: ToolViewRow[] = [];
      this.each(record => { if (record.row.sourceKey === key) rows.push(record.row); });
      const ready = new Map<object, ObservedHunks>();
      for (const row of rows) {
        const material = row.observationMaterial();
        if (!material || JSON.stringify(material.request) !== JSON.stringify(prepared.request) || !current()) continue;
        let observed = ready.get(material.plan);
        if (!observed) {
          const matching = observedMaterial(material, files, captured);
          const preset = Math.max(...settingsChoices("diffContext").filter((value): value is number => typeof value === "number"));
          observed = await observeDiffContext(matching.plan, matching.observations, Math.min(1000, Math.max(preset, this.store?.effective.diffContext ?? defaults.diffContext)), current);
          ready.set(material.plan, observed);
        }
        if (current() && row.publishObservations(material, observed)) this.retainObservation(row, observed);
      }
    } finally { captured.release(); if (this.captures.get(key) === binding) this.captures.delete(key); }
  }

  private retainObservation(row: ToolViewRow, observed: ObservedHunks): void {
    let key = this.observationIds.get(observed);
    if (key === undefined) { key = ++this.observationCounter; this.observationIds.set(observed, key); }
    const prior = this.retainedObservations.get(key);
    if (prior) {
      this.retainedObservations.set(key, { ...prior, rows: [...prior.rows, new WeakRef(row)], bytes: prior.bytes + 32 });
      this.observationBytes += 32;
      this.pruneObservations();
      return;
    }
    const cells = new Set([...observed.values()].flatMap(hunk => hunk.blocks.flatMap(block => block.kind === "observed-context"
      ? [block.before, block.after].filter(cell => cell !== undefined) : [])));
    const overhead = [...observed.values()].reduce((total, hunk) => total + 128 + hunk.blocks.reduce((size, block) => size
      + (block.kind === "change" ? 64 + block.pairs.length * 192 : 128), 0), 160);
    const bytes = [...cells].reduce((total, cell) => total + 80 + cell.text.length * 2, overhead);
    this.retainedObservations.set(key, { rows: [new WeakRef(row)], observed: new WeakRef(observed), bytes });
    this.observationBytes += bytes;
    this.pruneObservations();
  }

  private pruneObservations(): void {
    for (const [oldKey, entry] of this.retainedObservations) {
      const retained = entry.observed.deref();
      if (retained && this.observationBytes <= 16 * 1024 * 1024) continue;
      for (const ref of entry.rows) if (retained) ref.deref()?.clearObservations(retained);
      this.observationBytes -= entry.bytes;
      this.retainedObservations.delete(oldKey);
    }
  }

  private resetObservations(): void {
    this.observationEpoch++;
    this.observations.reset();
    this.captures.clear();
    this.retainedObservations.clear();
    this.observationBytes = 0;
  }

  private each(visit: (record: RowRecord) => void): void {
    for (const ref of this.activeRows) {
      const record = ref.deref();
      if (!record) this.activeRows.delete(ref);
      else visit(record);
    }
  }

  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private retire(): void {
    this.stopTimer();
    this.each(record => record.row.retire());
    this.activeRows.clear();
    this.rows = new WeakMap();
    this.localChoices.clear();
    this.source.reset();
    this.preparations.reset();
    this.resetObservations();
    this.store?.dispose();
    this.store = undefined;
    this.directStart = undefined;
    this.nestedRevalidate = false;
  }

}
