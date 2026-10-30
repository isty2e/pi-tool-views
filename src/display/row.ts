import { Box, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { toJson } from "../json.ts";
import type { CallSource, ChildSource } from "../host/source.ts";
import type { EffectiveDeclaration, FamilyProjection, Json, RequestView, ResultPart, ResultView, SuppliedToolResult } from "../presentation.ts";
import type { DiffPresentation } from "../diff/model.ts";
import { buildOperationPresentation } from "../operations.ts";
import type { OperationPresentation } from "../operations.ts";
import type { Settings } from "../settings/model.ts";
import { applicationText, clipRows, compactTarget, isolateStyles, previewJson, safeText, sourceLines, wrap } from "./text.ts";
import { titleFacts } from "./title.ts";
import { operationTitle, queryObservationLines } from "./operations.ts";
import { outlineLines } from "./outline.ts";
import { structuredLines } from "./structured.ts";
import { locationLines } from "./locations.ts";
import { rankedSearchLines } from "./ranked-search.ts";
import { structuralRequestLines } from "./structural.ts";
import { markupLines } from "./markup.ts";
import { locationLabel } from "../location-label.ts";
import { coverageLabels, visibleResultParts } from "./result-visibility.ts";
import type { InspectionView } from "./inspection.ts";
import { SourcePaintCache } from "./source-cache.ts";

export type RenderContext = Omit<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2], "args" | "state"> & {
  readonly args: unknown;
  readonly state: Record<string, unknown>;
};
export interface LocalChoices {
  argsFull: boolean;
  resultFull: boolean;
  shellSource: boolean;
  codeSource: boolean;
}

export interface RowServices {
  readonly settings: () => Settings;
  readonly initialSettings: () => Settings;
  readonly choices: (key: string, fallback: LocalChoices) => LocalChoices;
  readonly compile: (declaration: EffectiveDeclaration | undefined) => FamilyProjection;
  readonly compare: (request: RequestView, result: ResultView | undefined) => DiffPresentation;
  readonly renderDiff: (plan: DiffPresentation, width: number, settings: Settings, theme: Theme, captionedPath?: string, operationCard?: boolean, hideReportedHeading?: boolean) => string[];
  readonly home: string;
  readonly now: () => number;
}

export interface NestedSnapshot {
  readonly identity: string;
  readonly arguments: Json;
  readonly complete: boolean;
  readonly declaration?: EffectiveDeclaration;
  readonly result?: SuppliedToolResult;
}

export interface CompositionParts {
  readonly header: Component;
  readonly source: Component;
  readonly result: Component;
  readonly bottom: Component;
  admitNested(snapshot: NestedSnapshot): boolean;
  withdraw(): void;
}

export const compositionParts = Symbol.for("pi-tool-views.composition.v1");

type Part = "call" | "result" | "header" | "source" | "result-body" | "edge";
interface Button { readonly x: number; readonly y: number; readonly width: number; readonly action: () => void }
interface Rendered { readonly lines: string[]; readonly buttons: Button[]; readonly native?: { readonly component: Component; readonly y: number } }
interface OperationLines { readonly lines: string[]; readonly resultRows: number; readonly omitted: number }
interface Facts {
  readonly args: Json | undefined;
  readonly request: RequestView;
  readonly result: SuppliedToolResult | undefined;
  readonly resultView: ResultView | undefined;
  readonly plan: DiffPresentation;
  readonly operations: OperationPresentation;
}

export class ToolViewRow {
  readonly name: string;
  readonly id: string;
  private readonly services: RowServices;
  private readonly native: ToolRenderers | undefined;
  readonly callComponent: RowComponent;
  readonly resultComponent: RowComponent;
  readonly parts: CompositionParts;
  live = false;
  sourceKey: string | undefined;
  private source: CallSource | undefined;
  private childSource: ChildSource | undefined;
  private childIdentity: string | undefined;
  private childQuarantined = false;
  private nested: NestedSnapshot | undefined;
  private nestedIdentity: string | undefined;
  private withdrawn = false;
  private args: unknown;
  private rawResult: SuppliedToolResult | undefined;
  private context: RenderContext;
  private theme: Theme;
  private choices: LocalChoices;
  private readonly inlineDiffPlans = new WeakMap<Extract<ResultPart, { kind: "diff" }>, DiffPresentation>();
  private dirty = true;
  private facts: Facts | undefined;
  private fullArguments: { readonly args: Json; readonly text: string } | undefined;
  private readonly sourcePaint = new SourcePaintCache();
  private bodyCache: { readonly facts: Facts; readonly width: number; readonly key: string; readonly theme: Theme; readonly lines: string[] } | undefined;
  private diffCache: ({ readonly facts: Facts; readonly width: number; readonly key: string; readonly theme: Theme } & OperationLines) | undefined;
  private inspectionCache: { readonly facts: Facts; readonly width: number; readonly key: string; readonly theme: Theme; readonly lines: readonly string[] } | undefined;
  private nativeCall: Component | undefined;
  private nativeResult: Component | undefined;
  private nativeCallPrevious: Component | undefined;
  private nativeResultPrevious: Component | undefined;
  private startedAt: number | undefined;
  private endedAt: number | undefined;
  private retired = false;

  constructor(name: string, id: string, args: unknown, context: RenderContext,
    theme: Theme, services: RowServices, native: ToolRenderers | undefined,
    fallbackKey: string) {
    this.name = name;
    this.id = id;
    this.services = services;
    this.native = native;
    this.args = args;
    this.context = context;
    this.theme = theme;
    const initial = services.initialSettings();
    this.choices = services.choices(fallbackKey, {
      argsFull: false, resultFull: false, shellSource: initial.shellSourceInitiallyVisible,
      codeSource: initial.codeInitiallyVisible,
    });
    this.callComponent = new RowComponent(this, "call");
    this.resultComponent = new RowComponent(this, "result");
    this.parts = {
      header: new RowComponent(this, "header"), source: new RowComponent(this, "source"),
      result: new RowComponent(this, "result-body"), bottom: new RowComponent(this, "edge"),
      admitNested: snapshot => {
        if (this.retired) return false;
        if (this.nestedIdentity !== undefined && this.nestedIdentity !== snapshot.identity) {
          this.parts.withdraw();
          return false;
        }
        this.nestedIdentity = snapshot.identity;
        this.nested = snapshot;
        this.childSource = undefined;
        this.childIdentity = undefined;
        this.withdrawn = false;
        this.source = undefined;
        this.sourceKey = undefined;
        this.choices = services.choices(JSON.stringify(["nested", snapshot.identity]), this.choices);
        this.markDirty();
        this.invalidate();
        return true;
      },
      withdraw: () => {
        this.nested = undefined;
        this.childSource = undefined;
        this.withdrawn = true;
        this.rawResult = undefined;
        this.facts = undefined;
        this.fullArguments = undefined;
        this.sourcePaint.clear();
        this.bodyCache = undefined;
        this.diffCache = undefined;
        this.inspectionCache = undefined;
        this.nativeCall = undefined;
        this.nativeResult = undefined;
        this.nativeCallPrevious = undefined;
        this.nativeResultPrevious = undefined;
        this.markDirty();
        this.invalidate();
      },
    };
  }

  get identity() { return { id: this.id, name: this.name, args: this.args }; }
  get acceptsInput(): boolean { return !this.retired && !this.withdrawn; }
  get running(): boolean { return this.acceptsInput && this.context.executionStarted && this.context.isPartial && this.endedAt === undefined; }

  capture(args: unknown, context: RenderContext, theme: Theme, result?: SuppliedToolResult): void {
    const old = this.context;
    if (this.theme !== theme || old.expanded !== context.expanded || old.outputPad !== context.outputPad) {
      this.nativeCall = undefined;
      this.nativeResult = undefined;
    }
    if (args !== this.args || old.argsComplete !== context.argsComplete || old.executionStarted !== context.executionStarted
      || old.isPartial !== context.isPartial || old.isError !== context.isError || old.durationMs !== context.durationMs) this.dirty = true;
    this.args = args;
    this.context = context;
    this.theme = theme;
    if (result !== undefined && !this.childQuarantined) {
      this.rawResult = result;
      this.dirty = true;
    }
    if (context.executionStarted && this.startedAt === undefined) this.startedAt = this.services.now();
    if (!context.isPartial && this.endedAt === undefined) this.endedAt = this.services.now();
  }

  bind(source: CallSource | undefined): boolean {
    if (this.source === source) return false;
    this.source = source;
    this.sourceKey = source?.key;
    if (source?.result && this.endedAt === undefined) this.endedAt = this.services.now();
    if (source) this.choices = this.services.choices(source.key, this.choices);
    this.markDirty();
    return true;
  }

  get childBound(): boolean { return this.childIdentity !== undefined; }
  get childPaused(): boolean { return this.childQuarantined; }
  get childParentId(): string | undefined { return this.childSource?.rootParentId; }
  get childParentKey(): string | undefined { return this.childSource?.parentKey; }

  demoteChild(): boolean {
    const child = this.childSource;
    if (!child || (child.arguments === undefined && child.declaration === undefined)) return false;
    this.childSource = { ...child, arguments: undefined, declaration: undefined };
    this.markDirty();
    return true;
  }

  quarantineChild(): void {
    if (!this.childSource) return;
    this.childQuarantined = true;
    this.rawResult = undefined;
    this.markDirty();
  }

  releaseChild(): boolean {
    if (!this.childQuarantined) return false;
    this.childQuarantined = false;
    this.markDirty();
    return !this.withdrawn;
  }

  bindChild(source: ChildSource | undefined): boolean {
    if (this.childSource === source) return false;
    if (this.childIdentity !== undefined && source?.key !== this.childIdentity) {
      this.childSource = undefined;
      this.sourceKey = undefined;
      this.rawResult = undefined;
      this.withdrawn = true;
      this.markDirty();
      return true;
    }
    if (!source || this.withdrawn) return false;
    this.childIdentity = source.key;
    this.childSource = source;
    this.source = undefined;
    this.sourceKey = source.key;
    this.choices = this.services.choices(source.key, this.choices);
    this.markDirty();
    return true;
  }

  markDirty(): void { this.dirty = true; }
  invalidateChildResult(): void {
    if (!this.childSource) return;
    this.rawResult = undefined;
    this.markDirty();
  }
  invalidate(): void { if (!this.retired) this.context.invalidate(); }
  retire(): void {
    this.retired = true;
    this.source = undefined;
    this.childSource = undefined;
    this.nested = undefined;
    this.facts = undefined;
    this.fullArguments = undefined;
    this.sourcePaint.clear();
    this.bodyCache = undefined;
    this.diffCache = undefined;
    this.inspectionCache = undefined;
    this.args = undefined;
    this.rawResult = undefined;
    this.nativeCall = undefined;
    this.nativeResult = undefined;
    this.nativeCallPrevious = undefined;
    this.nativeResultPrevious = undefined;
    this.context = { ...this.context, args: undefined, state: {}, lastComponent: undefined, invalidate() {} };
  }

  render(part: Part, width: number): Rendered {
    if (this.retired || this.withdrawn || this.childQuarantined) return { lines: [], buttons: [] };
    this.refreshPaintTheme();
    width = Math.max(1, Math.floor(width));
    const facts = this.interpret();
    const settings = this.services.settings();
    const output: Rendered = { lines: [], buttons: [] };
    const theme = this.theme;
    const line = (text: string) => output.lines.push(truncateToWidth(text.replace(/\n/g, " "), width));
    const button = (text: string, action: () => void) => {
      const label = truncateToWidth(`[${text}]`, width);
      output.buttons.push({ x: 0, y: output.lines.length, width: visibleWidth(label), action });
      line(theme.fg("accent", label));
    };
    const rule = () => line(theme.fg("dim", "─".repeat(width)));
    const hasImage = facts.result?.content.some(content => content.kind === "image" || content.kind === "unavailable") ?? false;
    const bottom = () => { if (!hasImage && (settings.horizontalRules === "bottom" || settings.horizontalRules === "both")) rule(); };
    const knownDiff = facts.plan.units.length > 0;
    const complete = this.resultSettled(facts.result);
    const title = titleFacts(this.name, facts.request, facts.resultView, this.childSource !== undefined || this.context.executionStarted, complete,
      facts.result?.isError ?? this.context.isError, settings.titleMode === "tool", settings.commandPreview, facts.operations.items);
    let nativeMode = settings.diffMode === "native" && knownDiff && !!this.native?.renderCall;
    const nativeCall = nativeMode ? this.nativeComponent("call", facts) : undefined;
    if (!nativeCall) nativeMode = false;

    if (part === "call" || part === "header") {
      if (settings.horizontalRules === "top" || settings.horizontalRules === "both") rule();
      if (nativeMode) {
        const component = nativeCall;
        if (component) {
          const y = output.lines.length;
          output.lines.push(...component.render(width));
          Object.assign(output, { native: { component, y } });
        }
      } else {
        const color = title.state === "error" ? "error" : title.state === "partial" || title.warning ? "warning"
          : title.state === "complete" ? "success" : title.state === "pending" ? "muted" : "accent";
        const icon = title.state === "error" ? "×" : title.state === "partial" || title.warning ? "!" : title.state === "complete" ? "✓" : "•";
        const timing = settings.showDuration ? this.duration() : "";
        const label = theme.fg(color, `${icon} ${safeText(title.label, false)}`);
        const available = Math.max(1, width - visibleWidth(label) - visibleWidth(timing) - 2);
        const target = title.target ? compactTarget(title.target, available, this.services.home) : "";
        const detail = title.detail && visibleWidth(target) + visibleWidth(title.detail) + 3 <= available
          ? theme.fg("dim", ` · ${title.detail}`) : "";
        line(label + (target ? ` ${target}` : "") + detail + (timing ? ` ${theme.fg("dim", timing)}` : ""));
        if (facts.request.kind === "uninterpreted") {
          const previewed = facts.args === undefined ? { text: "[Arguments unavailable]", clipped: false }
            : previewJson(facts.args, Math.max(8, width * 2));
          if (this.choices.argsFull && facts.args !== undefined && this.fullArguments?.args !== facts.args) {
            this.fullArguments = { args: facts.args, text: JSON.stringify(facts.args, null, 2) };
          }
          const argsText = this.choices.argsFull ? this.fullArguments?.text ?? previewed.text : previewed.text;
          if (this.choices.argsFull) {
            output.lines.push(...this.sourcePaint.paint("arguments", { text: argsText, language: "json" }, undefined, width, false, theme));
            button("Collapse arguments", () => this.toggle("argsFull"));
          } else {
            line(theme.fg("muted", truncateToWidth(safeText(argsText), width)));
            if (previewed.clipped || visibleWidth(argsText) > width || argsText.includes("\n")) button("Show full arguments", () => this.toggle("argsFull"));
          }
        }
      }
      if (knownDiff && settings.diffMode === "native" && !this.native?.renderCall) line(theme.fg("muted", "Native view unavailable; showing supplied changes."));
    }

    if ((part === "call" || part === "source") && !nativeMode) {
      const request = facts.request;
      if (request.kind === "shell.launch" || request.kind === "program.javascript" || request.kind === "program.typescript") {
        const shell = request.kind === "shell.launch";
        const visible = shell ? this.choices.shellSource : this.choices.codeSource;
        button(`${visible ? "Hide" : "Show"} ${shell ? "command" : "source"}`, () => this.toggle(shell ? "shellSource" : "codeSource"));
        if (visible) output.lines.push(...this.sourcePaint.paint("source", { text: shell ? request.command : request.source,
          language: shell ? "bash" : request.kind === "program.javascript" ? "javascript" : "typescript", firstLine1: 1 },
        undefined, width, settings.lineNumbers, theme));
      } else if (request.kind === "change.write" && !knownDiff) {
        output.lines.push(...this.sourcePaint.paint("source", { text: request.content, firstLine1: 1 }, request.path, width, settings.lineNumbers, theme));
      } else if (request.kind === "code.ast-dump") {
        output.lines.push(...this.sourcePaint.paint("source", { text: request.source, language: request.language }, undefined, width, settings.lineNumbers, theme));
      } else if (request.kind === "change.structural" || request.kind === "search.ast") {
        output.lines.push(...structuralRequestLines(request, width, theme));
      }
      if (knownDiff || facts.operations.items.length) {
        const key = `${settings.diffMode}:${settings.diffContext}:${settings.diffEmphasisGap}:${settings.lineNumbers}:${settings.diffRowBackground}:${settings.resultRows}:${this.choices.resultFull}`;
        if (this.diffCache?.facts !== facts || this.diffCache.width !== width || this.diffCache.key !== key || this.diffCache.theme !== theme) {
          this.diffCache = { facts, width, key, theme, ...(facts.operations.items.length
            ? this.operationLines(facts, width, settings, this.choices.resultFull)
            : { lines: this.services.renderDiff(facts.plan, width, settings, theme, title.target), resultRows: 0, omitted: 0 }) };
        }
        output.lines.push(...this.diffCache.lines);
        if (this.diffCache.omitted) button("Show full results", () => this.toggle("resultFull"));
        else if (this.choices.resultFull && settings.resultRows !== null && this.diffCache.resultRows > settings.resultRows) {
          button("Collapse results", () => this.toggle("resultFull"));
        }
      }
    }

    if (part === "result" || part === "result-body") {
      const component = nativeMode && this.native?.renderResult ? this.nativeComponent("result", facts) : undefined;
      if (component) {
        output.lines.push(...component.render(width));
        Object.assign(output, { native: { component, y: 0 } });
      } else if (facts.result) {
        const body = this.resultLines(facts, width, settings, nativeMode, part === "result");
        const clipped = clipRows(body, this.choices.resultFull ? null : settings.resultRows,
          facts.request.kind === "shell.launch" || facts.request.kind === "session.poll" || facts.request.kind === "session.send" ? settings.shellWindow : "head");
        if (part === "result" && !nativeMode && clipped.lines.length
          && (facts.request.kind === "change.structural" || facts.request.kind === "search.ast")) output.lines.push("");
        if (facts.operations.items.length && clipped.lines.length && !nativeMode) {
          if (part === "result") {
            const key = `${settings.diffMode}:${settings.diffContext}:${settings.diffEmphasisGap}:${settings.lineNumbers}:${settings.diffRowBackground}:${settings.resultRows}:${this.choices.resultFull}`;
            const preceding = this.diffCache?.facts === facts && this.diffCache.width === width && this.diffCache.key === key && this.diffCache.theme === theme
              ? this.diffCache : this.operationLines(facts, width, settings, this.choices.resultFull);
            const hasButton = preceding.omitted > 0 || (this.choices.resultFull && settings.resultRows !== null && preceding.resultRows > settings.resultRows);
            if (hasButton || (preceding.lines.length && stripTerminalSequences(preceding.lines.at(-1)!).trim())) output.lines.push("");
          }
          line(theme.fg("dim", "Result"));
        }
        output.lines.push(...clipped.lines);
        if ((facts.operations.collapsedReported || facts.operations.collapsedInline) && !nativeMode) {
          button(this.choices.resultFull ? "Hide reported changes" : "Show reported changes", () => this.toggle("resultFull"));
        } else if (this.choices.resultFull && settings.resultRows !== null && body.length > settings.resultRows) {
          button("Collapse result", () => this.toggle("resultFull"));
        } else if (clipped.omitted) button(`Show full result (${body.length} rows)`, () => this.toggle("resultFull"));
      }
    }

    if (part === "edge") {
      if (settings.horizontalRules === "bottom" || settings.horizontalRules === "both") rule();
    } else if (part === "result" || (part === "call" && facts.result === undefined)) bottom();
    if (settings.backdrop && output.lines.length) {
      const color = title.state === "error" ? "toolErrorBg" : title.state === "complete" ? "toolSuccessBg" : "toolPendingBg";
      output.lines.splice(0, output.lines.length, ...output.lines.map(text => theme.bg(color,
        text.replace(/\x1b\[(?:0|49)m/g, sequence => sequence + (typeof theme.getBgAnsi === "function" ? theme.getBgAnsi(color) : "\x1b[49m"))
        + " ".repeat(Math.max(0, width - visibleWidth(text))))));
    }
    return output;
  }

  inspectionLines(view: InspectionView, width: number): readonly string[] {
    if (!this.acceptsInput) return ["This card is no longer active."];
    this.refreshPaintTheme();
    const facts = this.interpret();
    const settings = this.services.settings();
    const key = `${view}:${settings.diffMode}:${settings.diffContext}:${settings.diffEmphasisGap}:${settings.lineNumbers}:${settings.diffRowBackground}`;
    if (this.inspectionCache?.facts === facts && this.inspectionCache.width === width
      && this.inspectionCache.key === key && this.inspectionCache.theme === this.theme) return this.inspectionCache.lines;

    let lines: readonly string[];
    if (view === "arguments") {
      if (facts.args !== undefined && this.fullArguments?.args !== facts.args) {
        this.fullArguments = { args: facts.args, text: JSON.stringify(facts.args, null, 2) };
      }
      lines = this.fullArguments ? this.sourcePaint.paint("arguments", { text: this.fullArguments.text, language: "json" }, undefined, width, false, this.theme)
        : ["Arguments are unavailable."];
    } else if (view === "result") {
      const result = facts.result;
      lines = result ? this.partLines({ kind: "original-content" }, result, width, settings).map(isolateStyles) : [];
      if (result) {
        const imageData = new Set(result.content.flatMap(content => content.kind === "image" && content.data ? [content.data] : []));
        for (const [label, value] of [["Details", result.details], ["Structured content", result.structuredContent]] as const) {
          if (value === undefined) continue;
          const text = JSON.stringify(value, (_key: string, entry: unknown) => typeof entry === "string" && imageData.has(entry)
            ? "[Native image data remains in the transcript]" : entry, 2);
          lines = [...lines, this.theme.fg("dim", label), ...sourceLines({ text, language: "json" }, undefined, width, false, this.theme)];
        }
      }
      if (facts.result?.content.some(content => content.kind === "image")) lines = [...lines, "[Native images remain in the transcript]"];
      if (!lines.length) lines = [facts.result ? "No text was supplied in this result." : "No result has been supplied."];
    } else if (facts.operations.items.length) {
      const operations = this.operationLines(facts, width, settings, true).lines;
      const remainder = [...this.services.renderDiff(facts.operations.collapsedReported ?? facts.operations.remainder, width, settings, this.theme, undefined, false, true),
        ...facts.operations.remainder.context.flatMap(part => part.kind === "diff" && facts.result ? this.partLines(part, facts.result, width, settings) : [])];
      const separator = operations.length && stripTerminalSequences(operations.at(-1)!).trim() ? [""] : [];
      lines = remainder.length ? [...operations, ...separator, this.theme.fg("dim", "Result"), ...remainder] : operations;
    } else if (facts.plan.units.length) {
      lines = this.services.renderDiff(facts.plan, width, settings, this.theme);
    } else {
      const request = facts.request;
      if (request.kind === "shell.launch" || request.kind === "program.javascript" || request.kind === "program.typescript") {
        lines = this.sourcePaint.paint("source", { text: request.kind === "shell.launch" ? request.command : request.source,
          language: request.kind === "shell.launch" ? "bash" : request.kind === "program.javascript" ? "javascript" : "typescript", firstLine1: 1 },
        undefined, width, settings.lineNumbers, this.theme);
      } else if (request.kind === "change.write") {
        lines = this.sourcePaint.paint("source", { text: request.content, firstLine1: 1 }, request.path, width, settings.lineNumbers, this.theme);
      } else if (request.kind === "code.ast-dump") {
        lines = this.sourcePaint.paint("source", { text: request.source, language: request.language }, undefined, width, settings.lineNumbers, this.theme);
      } else lines = ["No source or diff was interpreted. Full supplied values are available in arguments and result."];
    }
    this.inspectionCache = { facts, width, key, theme: this.theme, lines };
    return lines;
  }

  private refreshPaintTheme(): void {
    if (!this.sourcePaint.observeTheme(this.theme)) return;
    this.bodyCache = undefined;
    this.diffCache = undefined;
    this.inspectionCache = undefined;
  }

  private suppliedArguments(): unknown {
    if (this.nested) return this.nested.arguments;
    if (this.childSource) return this.childSource.arguments === undefined ? this.args : this.childSource.arguments;
    if (this.source) return this.source.call.arguments;
    return this.args;
  }

  private resultSettled(result: SuppliedToolResult | undefined): boolean {
    if (!result) return false;
    if (this.childSource) return this.childSource.settled && this.childSource.isError === result.isError;
    return !this.context.isPartial || !!this.source?.result || !!this.nested?.result;
  }

  private interpret(): Facts {
    if (!this.dirty && this.facts) return this.facts;
    const source = this.source;
    const nested = this.nested;
    const admitted = !this.withdrawn && (nested ? nested.complete : this.childSource ? this.childSource.arguments !== undefined : source?.eligible === true);
    const args = toJson(this.suppliedArguments());
    if (args === undefined) this.fullArguments = undefined;
    const declaration = nested?.declaration ?? this.childSource?.declaration ?? source?.declaration;
    const projection = this.services.compile(declaration);
    const request: RequestView = admitted && args !== undefined ? projection.request(args) : { kind: "uninterpreted" };
    const result = this.withdrawn ? undefined : nested ? nested.result : source?.result ?? this.rawResult;
    const resultView = result ? projection.result(result, request) : undefined;
    const plan = this.services.compare(request, resultView);
    const complete = this.resultSettled(result);
    this.facts = { args, request, result, resultView, plan, operations: buildOperationPresentation(request, plan, {}, complete) };
    this.dirty = false;
    this.nativeCall = undefined;
    this.nativeResult = undefined;
    return this.facts;
  }

  private duration(): string {
    const supplied = this.source?.result?.durationMs ?? this.nested?.result?.durationMs ?? this.context.durationMs;
    const elapsed = supplied ?? (this.startedAt !== undefined ? (this.endedAt ?? this.services.now()) - this.startedAt : undefined);
    if (elapsed === undefined || !Number.isFinite(elapsed)) return "";
    return elapsed < 1000 ? `${Math.max(0, Math.round(elapsed))}ms` : `${(elapsed / 1000).toFixed(1)}s`;
  }

  private toggle(key: "argsFull" | "resultFull" | "shellSource" | "codeSource"): void {
    this.choices[key] = !this.choices[key];
    this.invalidate();
  }

  private operationLines(facts: Facts, width: number, settings: Settings, full: boolean): OperationLines {
    let remaining = full ? null : settings.resultRows;
    let resultRows = 0;
    let omitted = 0;
    const lines = facts.operations.items.flatMap((operation, index) => {
      const title = operationTitle(operation);
      const label = this.theme.bold(this.theme.fg("text", title.label));
      const completed = this.resultSettled(facts.result);
      const preview = operation.kind === "edit" && completed && operation.diff.units.some(unit => unit.origin !== "reported") ? " · preview" : "";
      const available = Math.max(1, width - visibleWidth(label) - visibleWidth(preview) - 1);
      const heading = truncateToWidth(label + (title.target ? ` ${compactTarget(title.target, available, this.services.home)}` : "") + preview, width);
      let body: readonly string[] = [];
      if (operation.kind === "edit") body = this.services.renderDiff(operation.diff, width, settings, this.theme, operation.path, true);
      else if (operation.kind === "web" && operation.observation) {
        const observed = queryObservationLines(operation.observation, width, this.theme);
        resultRows += observed.length;
        const clipped = clipRows(observed, remaining, "head");
        body = clipped.lines;
        omitted += clipped.omitted;
        if (remaining !== null) remaining = Math.max(0, remaining - clipped.lines.length);
      }
      return [...(index ? [""] : []), heading, ...body];
    });
    return { lines, resultRows, omitted };
  }

  private resultLines(facts: Facts, width: number, settings: Settings, nativeMode: boolean, combined: boolean): string[] {
    const settled = this.resultSettled(facts.result);
    const key = `${settings.diffMode}:${settings.diffContext}:${settings.diffEmphasisGap}:${settings.lineNumbers}:${settings.diffRowBackground}:${nativeMode}:${combined}:${this.context.isPartial}:${settled}:${this.choices.resultFull}`;

    if (this.bodyCache?.facts === facts && this.bodyCache.width === width && this.bodyCache.key === key && this.bodyCache.theme === this.theme) {
      return this.bodyCache.lines;
    }
    const result = facts.result;
    if (!result) return [];
    const hideReceipts = settled && !result.isError && !facts.resultView?.reportedFailure
      && facts.plan.applicationReports.every(report => report.outcome === "reported-complete");
    const parts = visibleResultParts(facts.operations.remainder.context, hideReceipts);
    const resultDiff = (nativeMode || this.choices.resultFull) && facts.operations.collapsedReported
      ? facts.operations.collapsedReported : facts.operations.remainder;
    const lines = facts.operations.items.length
      ? this.services.renderDiff(resultDiff, width, settings, this.theme, undefined, false, true) : [];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const previous = parts[index - 1];
      if (part.kind === "diff" && part.placement === "inline" && facts.operations.collapsedInline && !nativeMode && !this.choices.resultFull) {
        if (previous?.kind === "text" && previous.text.endsWith("\n") && lines.at(-1) === "") lines.pop();
        continue;
      }
      let rendered: string[];
      if (part.kind === "text") {
        const paint = (fragment: Extract<ResultPart, { kind: "text" }>) => fragment.role
          ? this.theme.fg("muted", safeText(fragment.text)) : safeText(fragment.text);
        let text = paint(part), last = part.text;
        while (parts[index + 1]?.kind === "text") {
          const next = parts[++index] as Extract<ResultPart, { kind: "text" }>;
          text += (/[\r\n]$/.test(last) || /^[\r\n]/.test(next.text) ? "" : "\n") + paint(next);
          last = next.text;
        }
        rendered = wrap(text, width);
      } else rendered = this.partLines(part, result, width, settings);

      if (previous === undefined && lines.length && rendered.length && stripTerminalSequences(lines.at(-1)!).trim()
        && stripTerminalSequences(rendered[0]!).trim()) lines.push("");
      if ((part.kind === "source" || part.kind === "diff" || part.kind === "locations" || part.kind === "ranked-files" || part.kind === "code-outline" || part.kind === "structured-data" || part.kind === "file-matches" || part.kind === "file-list")
        && previous?.kind === "text" && previous.text.endsWith("\n") && stripTerminalSequences(lines.at(-1) ?? "") === "") lines.pop();
      if (part.kind === "text" && part.text.startsWith("\n") && previous?.kind === "source" && stripTerminalSequences(rendered[0] ?? "") === "") rendered.shift();
      lines.push(...rendered);
    }
    for (const report of facts.plan.applicationReports) {
      if (hideReceipts && report.outcome === "reported-complete") continue;
      lines.push(...wrap(applicationText(report), width));
    }
    if (!lines.length && parts.length && !result.content.length && result.details !== undefined) {
      lines.push(...sourceLines({ text: JSON.stringify(result.details, null, 2), language: "json" }, undefined, width, false, this.theme));
    }
    const capture = facts.resultView?.contentCapture;
    if ((capture?.producerTruncated || (capture?.omittedBytes ?? 0) > 0) && !parts.some(part => part.kind === "coverage" && part.reason === "truncated"))
      lines.push(...wrap(coverageLabels.truncated, width).map(text => this.theme.fg("muted", text)));
    if (capture?.fullOutputPath) lines.push(...wrap(`Full output: ${capture.fullOutputPath}`, width));
    if (capture?.logPath) lines.push(...wrap(`Log: ${capture.logPath}`, width));
    this.bodyCache = { facts, width, key, theme: this.theme, lines };
    return lines;
  }

  private partLines(part: ResultPart, result: SuppliedToolResult, width: number, settings: Settings): string[] {
    switch (part.kind) {
      case "diff": {
        let plan = this.inlineDiffPlans.get(part);
        if (!plan) {
          const { placement: _placement, ...detached } = part;
          plan = this.services.compare({ kind: "uninterpreted" }, { parts: [detached] });
          this.inlineDiffPlans.set(part, plan);
        }
        return this.services.renderDiff(plan, width, settings, this.theme, undefined, false, true);
      }
      case "original-content": return (part.indexes ?? result.content.map((_, index) => index)).flatMap(index => {
        const content = result.content[index];
        if (content?.kind === "unavailable") return wrap("[Content block unavailable to the renderer]", width).map(line => this.theme.fg("muted", line));
        return !content || content.kind === "image" ? [] : content.kind === "text" ? wrap(content.text, width)
          : sourceLines({ text: JSON.stringify(content.value, null, 2), language: "json" }, undefined, width, false, this.theme);
      });
      case "edit-receipt": return wrap(part.prefix + part.separator + this.theme.fg("muted", safeText(part.summary)) + part.suffix, width);
      case "text": return wrap(part.text, width).map(text => part.role ? this.theme.fg("muted", text) : text);
      case "coverage": return wrap(coverageLabels[part.reason], width).map(text => this.theme.fg("muted", text));
      case "markup": return markupLines(part, width, this.theme);
      case "source": return sourceLines(part.source, part.path, width, settings.lineNumbers, this.theme);
      case "notice": return wrap(part.text, width).map(text => this.theme.fg(part.severity === "error" ? "error" : part.severity === "warning" ? "warning" : "muted", text));
      case "changes": return [...part.changes.flatMap(change => wrap(`${change.activity}: ${change.path}${change.moveTo ? ` → ${change.moveTo}` : ""}`, width)),
        ...(part.application ? wrap(applicationText(part.application), width) : [])];
      case "locations": return locationLines(part.items, width, this.theme, this.services.home);
      case "ranked-files": return rankedSearchLines(part, width, this.theme, this.services.home);
      case "code-outline": return outlineLines(part, width, this.theme, this.services.home);
      case "structured-data": return structuredLines(part.value, width);
      case "file-list": return part.entries.flatMap(entry => wrap(entry.path + (entry.directory ? "/" : "")
        + (entry.annotation ? `  ${entry.annotation}` : ""), width));
      case "file-matches": return part.groups.flatMap(group => {
        const labelWidth = group.rows.reduce((max, entry) => entry.kind === "line" && entry.line1 !== undefined
          ? Math.max(max, visibleWidth(locationLabel(entry.line1, entry.identifier))) : max, 0);
        return [...wrap(this.theme.bold(group.path) + (group.annotation ? `  ${group.annotation}` : ""), width),
          ...group.rows.flatMap(row => {
            if (row.kind === "gap") return wrap(row.text, width).map(text => this.theme.fg("muted", text));
            const gutter = width > 2 ? 2 : 0;
            const marker = row.role === "match" ? this.theme.bold("›") : " ";
            return sourceLines({ text: row.text,
              ...(row.line1 !== undefined ? { firstLine1: row.line1 } : {}),
              ...(row.identifier !== undefined ? { lineIdentifiers: [row.identifier] } : {}) },
              group.path, Math.max(1, width - gutter), settings.lineNumbers, this.theme, labelWidth)
              .map((text, index) => gutter ? `${index === 0 ? marker : " "} ${text}` : text);
          })];
      });
      case "query-results": return [...part.items.flatMap(item => [
        ...wrap(`Search ${item.query}`, width), ...queryObservationLines(item, width, this.theme),
      ]), ...(part.responseId ? wrap(`Stored search: ${part.responseId}`, width) : []),
      ...(part.fetchId ? wrap(`Stored content: ${part.fetchId}`, width) : [])];
    }
  }

  private nativeComponent(slot: "call" | "result", facts: Facts): Component | undefined {
    const cached = slot === "call" ? this.nativeCall : this.nativeResult;
    if (cached) return cached;
    const args = this.suppliedArguments();
    const previous = slot === "call" ? this.nativeCallPrevious : this.nativeResultPrevious;
    const context = { ...this.context, args, lastComponent: previous,
      ...(facts.result ? { isError: facts.result.isError, durationMs: facts.result.durationMs ?? this.context.durationMs } : {}) };
    try {
      const component = slot === "call" ? this.native?.renderCall?.(args, this.theme, context)
        : facts.result ? this.native?.renderResult?.({
          content: facts.result.content.flatMap<TextContent | ImageContent>(content => content.kind === "text" ? [{ type: "text" as const, text: content.text }]
            : content.kind === "image" ? [{ type: "image" as const, data: content.data, mimeType: content.mimeType }] : []),
          details: facts.result.details,
        }, { expanded: this.context.expanded, isPartial: this.context.isPartial }, this.theme, context) : undefined;
      if (!component) return undefined;
      if (slot === "call") this.nativeCallPrevious = component;
      else this.nativeResultPrevious = component;
      if (this.native?.renderShell !== "self") {
        const box = new Box(this.context.outputPad ?? 1, 1, text => this.theme.bg(facts.result?.isError ? "toolErrorBg" : facts.result ? "toolSuccessBg" : "toolPendingBg", text));
        box.addChild(component);
        if (slot === "call") this.nativeCall = box;
        else this.nativeResult = box;
        return box;
      }
      if (slot === "call") this.nativeCall = component;
      else this.nativeResult = component;
      return component;
    } catch { return undefined; }
  }
}

export class RowComponent implements Component {
  private readonly row: ToolViewRow;
  private readonly part: Part;
  private rendered: Rendered = { lines: [], buttons: [] };
  constructor(row: ToolViewRow, part: Part) { this.row = row; this.part = part; }
  get [compositionParts](): CompositionParts { return this.row.parts; }
  render(width: number): string[] { this.rendered = this.row.render(this.part, width); return this.rendered.lines; }
  invalidate(): void {}
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.row.acceptsInput) return undefined;
    if (event.button !== "left") return undefined;
    const button = this.rendered.buttons.find(button => event.y === button.y && event.x >= button.x && event.x < button.x + button.width);
    if (button) {
      if (event.type === "click") button.action();
      return { handled: true };
    }
    const native = this.rendered.native;
    if (native && event.y >= native.y) return native.component.handleMouse?.({ ...event, y: event.y - native.y });
    return undefined;
  }
}
