import { toJson } from "../json.ts";
import type { EffectiveDeclaration, FamilyProjection, Json, RequestView, ResultPart, ResultView } from "../presentation.ts";
import type { DiffPresentation } from "../diff/model.ts";
import type { CallSource } from "./source.ts";
import { prepareRequestedChanges } from "../diff/requested.ts";
import type { PreparedRequestedChanges } from "../diff/requested.ts";
import type { PresentationOptions } from "../diff/compose.ts";

export interface PreparationEngine {
  readonly compile: (declaration: EffectiveDeclaration | undefined) => FamilyProjection;
  readonly compare: (request: RequestView, result: ResultView | undefined, options?: PresentationOptions) => DiffPresentation;
}

export interface PreparedRequest {
  readonly args: Json | undefined;
  readonly projection: FamilyProjection;
  readonly request: RequestView;
  readonly changes?: PreparedRequestedChanges;
}

export interface CommittedPresentation extends PreparedRequest {
  readonly resultView: ResultView;
  readonly plan: DiffPresentation;
  readonly inline: ReadonlyMap<ResultPart, DiffPresentation>;
}

/** Share source-frame preparation until a host transition invalidates it. */
export class CallPreparations {
  private readonly engine: PreparationEngine;
  private requests = new WeakMap<CallSource, WeakRef<PreparedRequest>>();
  private frames = new WeakMap<CallSource, WeakRef<CommittedPresentation>>();

  constructor(engine: PreparationEngine) { this.engine = engine; }

  request(source: CallSource): PreparedRequest {
    const frame = this.frames.get(source)?.deref();
    if (frame) return frame;
    let prepared = this.requests.get(source)?.deref();
    if (!prepared) {
      prepared = this.prepare(source.declaration, source.call.arguments, source.eligible);
      this.requests.set(source, new WeakRef(prepared));
    }
    return prepared;
  }

  committed(source: CallSource): CommittedPresentation | undefined {
    if (!source.result) return undefined;
    let frame = this.frames.get(source)?.deref();
    if (!frame) {
      const request = this.request(source);
      const resultView = request.projection.result(source.result, request.request);
      const inline = new Map<ResultPart, DiffPresentation>();
      for (const part of resultView.parts) {
        if (part.kind !== "diff" || part.placement !== "inline") continue;
        const { placement: _placement, ...detached } = part;
        inline.set(part, this.engine.compare({ kind: "uninterpreted" }, { parts: [detached] }));
      }
      frame = { ...request, resultView, plan: this.engine.compare(request.request, resultView, request.changes ? { prepared: request.changes } : {}), inline };
      this.frames.set(source, new WeakRef(frame));
    }
    return frame;
  }

  reset(): void { this.requests = new WeakMap(); this.frames = new WeakMap(); }

  invalidate(source: CallSource): void { this.requests.delete(source); this.frames.delete(source); }

  execution(source: CallSource, input: unknown): PreparedRequest {
    return this.prepare(source.declaration, input, source.eligible, this.request(source).projection);
  }

  prepare(declaration: EffectiveDeclaration | undefined, input: unknown, eligible = true, compiled?: FamilyProjection): PreparedRequest {
    const args = toJson(input);
    const projection = compiled ?? this.engine.compile(declaration);
    const request: RequestView = eligible && args !== undefined ? projection.request(args) : { kind: "uninterpreted" };
    const changes = prepareRequestedChanges(request);
    return { args, projection, request, ...(changes ? { changes } : {}) };
  }
}
