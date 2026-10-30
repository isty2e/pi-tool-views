import type { ChangeScope, ReportedChange, RequestView, ResultPart, ScopedApplicationReport, SourceText } from "../presentation.ts";
export type { ScopedApplicationReport } from "../presentation.ts";

export type DiffOrigin = "request" | "producer-preview" | "reported";
export type DiffScope = ChangeScope;
export interface ChangedSpan { readonly startUtf16: number; readonly endUtf16: number }
export interface DiffCell { readonly text: string; readonly line1?: number; readonly locationLabel?: string; readonly lineEnding?: "\n" | "\r\n" | "\r" | ""; readonly emphasis: readonly ChangedSpan[] }
export type ChangedLinePair = { readonly before: DiffCell; readonly after?: DiffCell } | { readonly before?: DiffCell; readonly after: DiffCell };
export type DiffBlock =
  | { readonly kind: "instruction"; readonly text: string }
  | { readonly kind: "context"; readonly text: string; readonly oldLine1?: number; readonly newLine1?: number; readonly newLabel?: string; readonly lineEnding?: "\n" | "\r\n" | "\r" | "" }
  | { readonly kind: "change"; readonly pairs: readonly [ChangedLinePair, ...ChangedLinePair[]] }
  | { readonly kind: "located-change"; readonly operation: "replace" | "delete" | "insert-before" | "insert-after"; readonly locationLabel: string; readonly beforeLine1?: number; readonly after: readonly DiffCell[] }
  | { readonly kind: "gap"; readonly label?: string };
export interface DiffHunk { readonly anchor?: string; readonly blocks: readonly [DiffBlock, ...DiffBlock[]] }
export type DiffSection = { readonly target?: { readonly path: string; readonly moveTo?: string }; readonly activity?: ReportedChange["activity"] } & (
  | { readonly kind: "hunks"; readonly hunks: readonly DiffHunk[] }
  | { readonly kind: "raw"; readonly sources: readonly [SourceText, ...SourceText[]] }
);
export interface DiffViewUnit { readonly scope: DiffScope; readonly origin: DiffOrigin; readonly coarseComparison?: true; readonly ambiguousAssociation?: true; readonly sections: readonly [DiffSection, ...DiffSection[]] }
export interface CompoundRequestDiff {
  readonly request: RequestView;
  readonly comparison: { readonly maxComparisonTokens: number; readonly maxEditLength: number; readonly timeoutMs: number };
  /** Ordered occurrence previews; empty when the request is not compound. */
  readonly units: readonly DiffViewUnit[];
}
export interface DiffPresentation { readonly units: readonly DiffViewUnit[]; readonly applicationReports: readonly ScopedApplicationReport[]; readonly context: readonly ResultPart[]; readonly requestNotes?: readonly string[]; readonly reportedCoversRequest?: true; readonly inlineCoversRequest?: true; readonly compoundRequest?: CompoundRequestDiff }
