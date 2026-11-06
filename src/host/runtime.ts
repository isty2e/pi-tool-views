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

export class ToolViewsRuntime {
  private readonly pi: ExtensionAPI;
  private readonly engine: PresentationEngine;
  private readonly source = new SourceIndex();
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

  constructor(pi: ExtensionAPI, engine: PresentationEngine) { this.pi = pi; this.engine = engine; }

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
    this.stops.push(this.pi.on("tool_execution_end", (event, ctx) => {
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
      this.refresh(ctx, this.nestedRevalidate);
      this.source.finish();
      this.source.finishChildren();
      this.nestedRevalidate = false;
      this.reconcile();
      this.each(record => { if (record.row.releaseChild()) record.row.invalidate(); });
    }));
    this.stops.push(this.pi.on("agent_end", (_event, ctx) => {
      this.refresh(ctx, this.nestedRevalidate);
      this.source.finish();
      this.source.finishChildren();
      this.nestedRevalidate = false;
      this.reconcile();
      this.each(record => { if (record.row.releaseChild()) record.row.invalidate(); });
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
    this.store?.dispose();
    this.store = undefined;
    this.directStart = undefined;
    this.nestedRevalidate = false;
  }

}
