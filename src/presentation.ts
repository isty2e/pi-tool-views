export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export type SuppliedContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly data: string; readonly mimeType: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "other"; readonly value: Json };

export interface SuppliedToolResult {
  readonly content: readonly SuppliedContent[];
  readonly details?: Json;
  readonly structuredContent?: Json;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface EffectiveDeclaration {
  readonly description: string;
  readonly input:
    | { readonly kind: "json"; readonly schema: Json }
    | { readonly kind: "freeform"; readonly grammar?: { readonly syntax: string; readonly definition: string } };
  readonly sampling?: Json;
  readonly outputSchema?: Json;
}

export interface SourceText {
  readonly text: string;
  readonly language?: string;
  readonly firstLine1?: number;
  readonly lineIdentifiers?: readonly string[];
}
export interface SourceSelection {
  readonly path: string;
  readonly symbol?: { readonly kind?: string; readonly name?: string };
  readonly range?: { readonly firstLine1?: number; readonly lastLine1?: number };
  readonly partial?: true;
  readonly enclosingRange?: { readonly firstLine1: number; readonly lastLine1: number };
}

export interface PositionRequest {
  readonly path: string;
  readonly line1: number;
  readonly anchor:
    | { readonly kind: "line-start" }
    | { readonly kind: "character"; readonly character1: number }
    | { readonly kind: "symbol-on-line"; readonly symbol: string };
  readonly end?: { readonly line1?: number; readonly character1?: number };
}

export type ApplyIntent = "preview" | "apply";
export type SourceRequest =
  | { readonly kind: "source.lines"; readonly path: string; readonly firstLine1?: number; readonly lineLimit?: number; readonly lineEncoding?: "number-hash" | "anchor" | "plain" }
  | { readonly kind: "source.symbol"; readonly path: string; readonly symbol: string; readonly kindFilter?: string }
  | { readonly kind: "source.enclosing"; readonly path: string; readonly line1: number; readonly maxLines?: number };
export interface RequestedReplacement { readonly path: string; readonly oldText: string; readonly newText: string }
interface RequestedLocation {
  readonly kind: "located";
  readonly path: string;
  readonly anchor: { readonly token: string; readonly line1?: number };
  readonly end?: { readonly token: string; readonly line1?: number };
}
export type RequestedLocatedEdit = RequestedLocation & (
  | { readonly operation: "delete" }
  | { readonly operation: "replace" | "insert-before" | "insert-after"; readonly newText: string; readonly newLines?: never }
  | { readonly operation: "replace" | "insert-before" | "insert-after"; readonly newLines: readonly string[]; readonly newText?: never }
);
export type RequestedEdit = RequestedReplacement | RequestedLocatedEdit
  | { readonly kind: "match"; readonly path: string; readonly oldText: string; readonly newText: string; readonly all: boolean; readonly fuzzy: boolean;
      readonly range?: { readonly start: string; readonly end: string } }
  | { readonly kind: "symbol"; readonly path: string; readonly symbol: string; readonly newText: string }
  | { readonly kind: "transfer"; readonly path: string; readonly operation: "copy" | "move";
      readonly source: { readonly path?: string; readonly start: string; readonly end: string };
      readonly destination: { readonly path?: string; readonly anchor: string; readonly direction: "before" | "after" };
      readonly contextPath?: string };
export interface AstConstraints {
  readonly nodeKind?: string;
  readonly insideKind?: string;
  readonly contains?: { readonly relation: "child" | "descendant"; readonly kind: string };
  readonly follows?: string;
  readonly precedes?: string;
}
export type AstSelector =
  | { readonly kind: "pattern"; readonly pattern: string; readonly selector?: string }
  | { readonly kind: "rule"; readonly rule: string }
  | { readonly kind: "structural"; readonly constraints: AstConstraints; readonly pattern?: string };
export type FileChangeRequest =
  | { readonly kind: "change.write"; readonly path: string; readonly content: string }
  | { readonly kind: "change.replacements"; readonly requestedEdits: readonly RequestedEdit[] }
  | { readonly kind: "change.patch"; readonly text: string; readonly format: "codex" | "unified" | "unconfirmed" }
  | { readonly kind: "change.structural"; readonly language: string; readonly pattern: string; readonly rewrite: string; readonly paths?: readonly string[]; readonly constraints: AstConstraints; readonly intent: ApplyIntent }
  | { readonly kind: "change.rename-symbol"; readonly target: PositionRequest; readonly newName: string; readonly intent: ApplyIntent }
  | { readonly kind: "change.rename-file"; readonly path: string; readonly newPath: string; readonly intent: ApplyIntent };
export type RelativeWait = { readonly milliseconds: number };
export type PollWait = RelativeWait | { readonly untilUtc: string };
export type StdinRepresentation = { readonly encoding: "utf8" | "c-escaped-utf8" | "base64"; readonly text: string };
export type ShellRequest =
  | { readonly kind: "shell.launch"; readonly command: string; readonly cwd?: string; readonly shell?: string; readonly login?: boolean; readonly pty?: boolean; readonly processTimeoutMs?: number; readonly wait?: RelativeWait }
  | { readonly kind: "session.poll"; readonly sessionId: number; readonly wait?: PollWait }
  | { readonly kind: "session.send"; readonly sessionId: number; readonly input: StdinRepresentation; readonly wait?: RelativeWait };
export type ProgramRequest =
  | { readonly kind: "program.javascript"; readonly source: string }
  | { readonly kind: "program.typescript"; readonly source: string; readonly strings?: Readonly<Record<string, string>> };
export type ExcludeInput = { readonly kind: "text"; readonly text: string } | { readonly kind: "list"; readonly entries: readonly string[] };
export interface SearchScope {
  readonly root?: string;
  readonly paths?: readonly string[];
  readonly pathExpression?: string;
  readonly includeGlob?: string;
  readonly exclude?: ExcludeInput;
}
export type SearchRequest =
  | { readonly kind: "search.list"; readonly root?: string; readonly limit?: number }
  | { readonly kind: "search.files"; readonly query: string; readonly dialect: "glob" | "fuzzy-glob"; readonly scope: SearchScope; readonly limit?: number; readonly cursor?: string }
  | { readonly kind: "search.text"; readonly query: string; readonly dialect: "regex" | "literal" | "auto"; readonly caseMode: "sensitive" | "insensitive" | "smart"; readonly scope: SearchScope; readonly contextLines?: number; readonly limit?: number; readonly cursor?: string }
  | { readonly kind: "search.literal-any"; readonly patterns: readonly string[]; readonly scope: SearchScope; readonly contextLines?: number; readonly limit?: number; readonly cursor?: string }
  | { readonly kind: "search.symbols"; readonly query: string; readonly paths?: readonly string[]; readonly language?: string; readonly limit?: number }
  | { readonly kind: "search.ast"; readonly language: string; readonly selector: AstSelector; readonly paths?: readonly string[]; readonly skip?: number; readonly maxMatches?: number };
export type StoredSelection =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "index"; readonly index0: number }
  | { readonly kind: "both"; readonly value: string; readonly index0: number };
export interface StoredSelectors { readonly query?: StoredSelection; readonly url?: StoredSelection }
export type QueryInput =
  | { readonly kind: "single"; readonly query: string }
  | { readonly kind: "multiple"; readonly queries: readonly string[] }
  | { readonly kind: "both"; readonly query: string; readonly queries: readonly string[] };
export type UrlInput =
  | { readonly kind: "single"; readonly url: string }
  | { readonly kind: "multiple"; readonly urls: readonly string[] }
  | { readonly kind: "both"; readonly url: string; readonly urls: readonly string[] };
export type WebAction =
  | { readonly kind: "search" | "image-search"; readonly query: string; readonly recencyDays?: number; readonly domains?: readonly string[] }
  | { readonly kind: "open"; readonly reference: string; readonly line?: number }
  | { readonly kind: "click"; readonly reference: string; readonly linkId: number }
  | { readonly kind: "find"; readonly reference: string; readonly pattern: string }
  | { readonly kind: "lookup"; readonly section: "finance" | "sports" | "weather" | "time" | "screenshot"; readonly suppliedArguments: Json };
export type WebRequest =
  | { readonly kind: "web.search"; readonly input: QueryInput; readonly contextUrls?: readonly string[] }
  | { readonly kind: "web.source-check"; readonly claim: string; readonly queries?: readonly string[] }
  | { readonly kind: "web.url-context"; readonly query: string; readonly urls: readonly string[] }
  | { readonly kind: "web.fetch"; readonly targets: UrlInput; readonly mode?: "readable" | "raw" | "answer"; readonly prompt?: string }
  | { readonly kind: "web.stored-slice"; readonly responseId: string; readonly selectors: StoredSelectors; readonly offsetUtf16?: number; readonly limitUtf16?: number }
  | { readonly kind: "web.stored-find"; readonly responseId: string; readonly selectors: StoredSelectors; readonly needles: readonly string[]; readonly mode: "exact" | "case-insensitive" | "fuzzy" }
  | { readonly kind: "web.compound"; readonly actions: readonly WebAction[] };
export type NavigationOperation = "definition" | "typeDefinition" | "declaration" | "references" | "hover" | "signatureHelp" | "implementation";
export type CodeRequest =
  | { readonly kind: "code.navigation"; readonly operation: NavigationOperation; readonly target: PositionRequest }
  | { readonly kind: "code.document-symbols"; readonly path: string }
  | { readonly kind: "code.symbol-query"; readonly operation: "findSymbol" | "workspaceSymbol"; readonly query: string; readonly path?: string }
  | { readonly kind: "code.hierarchy"; readonly operation: "prepareCallHierarchy"; readonly target: PositionRequest }
  | { readonly kind: "code.hierarchy"; readonly operation: "incomingCalls" | "outgoingCalls"; readonly target: { readonly kind: "provided-item"; readonly item: Json } }
  | { readonly kind: "code.actions"; readonly target: PositionRequest }
  | { readonly kind: "code.command"; readonly command: string; readonly arguments?: readonly Json[]; readonly intent: ApplyIntent }
  | { readonly kind: "code.diagnostics"; readonly source?: "session" | "lsp"; readonly scope?: "paths" | "workspace"; readonly mode?: "delta" | "all" | "full"; readonly path?: string; readonly paths?: readonly string[] }
  | { readonly kind: "code.workspace-diagnostics"; readonly path?: string }
  | { readonly kind: "code.capabilities"; readonly path?: string }
  | { readonly kind: "code.module-report"; readonly path: string }
  | { readonly kind: "code.project-report" }
  | { readonly kind: "code.outline"; readonly paths: readonly string[]; readonly language?: string }
  | { readonly kind: "code.ast-validate"; readonly language: string; readonly selector: AstSelector }
  | { readonly kind: "code.ast-dump"; readonly language: string; readonly source: string };
export type ImageRequest =
  | { readonly kind: "image.view"; readonly path: string }
  | { readonly kind: "image.synthesize"; readonly prompt?: string; readonly referenceRequests: readonly ({ readonly kind: "path"; readonly path: string } | { readonly kind: "recent"; readonly count: number })[] };
export type RequestView = SourceRequest | FileChangeRequest | ShellRequest | ProgramRequest | SearchRequest | WebRequest | CodeRequest | ImageRequest | { readonly kind: "uninterpreted" };

export type ResourceReference = { readonly kind: "file"; readonly path: string } | { readonly kind: "uri"; readonly uri: string };
export interface ReportedLocation { readonly target: ResourceReference; readonly line: number; readonly indexBase: 0 | 1; readonly character?: number; readonly characterUnit: "utf16" | "unreported"; readonly endExclusive?: { readonly line: number; readonly character?: number } }
export type OutlineEntry =
  | { readonly kind: "symbol"; readonly name?: string; readonly symbolKind?: string; readonly signature?: string; readonly detail?: string; readonly containerName?: string; readonly range?: { readonly firstLine1: number; readonly lastLine1?: number }; readonly children: readonly OutlineEntry[]; readonly exported?: boolean; readonly imported?: boolean; readonly public?: boolean; readonly extra?: JsonObject }
  | { readonly kind: "uninterpreted"; readonly value: Json };
export type FileMatchRow = { readonly kind: "line"; readonly text: string; readonly line1?: number; readonly identifier?: string; readonly role: "match" | "context" | "unreported" } | { readonly kind: "gap"; readonly text: string };
export interface FileMatchGroup { readonly path: string; readonly annotation?: string; readonly rows: readonly [FileMatchRow, ...FileMatchRow[]] }
export type ProcessObservation = { readonly state: "active"; readonly sessionId?: number } | { readonly state: "exited"; readonly exitCode?: number; readonly signal?: string };
export interface ReportedChange { readonly path: string; readonly activity: "added" | "updated" | "deleted" | "moved"; readonly moveTo?: string }
export type ApplicationOutcome = "reported-complete" | "reported-partial" | "reported-failure";
export type ChangeScope = { readonly kind: "call" } | { readonly kind: "file"; readonly path: string; readonly moveTo?: string };
export interface ScopedApplicationReport { readonly scope: ChangeScope; readonly outcome: ApplicationOutcome }
export interface QueryObservation {
  readonly query: string;
  readonly answer?: string;
  readonly error?: string;
  readonly sources?: readonly { readonly title?: string; readonly url: string; readonly snippet?: string }[];
}
export type DiffRepresentations = { readonly numbered?: string; readonly unified?: string; readonly codex?: string } & ({ readonly numbered: string } | { readonly unified: string } | { readonly codex: string });
export interface DiffLineIdentifier { readonly path: string; readonly side: "before" | "after"; readonly line1: number; readonly identifier: string }
export type ResultPart =
  | { readonly kind: "original-content"; readonly indexes?: readonly [number, ...number[]] }
  | { readonly kind: "text"; readonly text: string; readonly role?: "continuation" | "receipt" | "usage" }
  | { readonly kind: "coverage"; readonly reason: "limit" | "truncated" | "continuation"; readonly producerText?: string }
  | { readonly kind: "edit-receipt"; readonly path: string; readonly prefix: string; readonly separator: string; readonly summary: string; readonly suffix: string }
  | { readonly kind: "markup"; readonly format: "plaintext" | "markdown"; readonly text: string }
  | { readonly kind: "source"; readonly source: SourceText; readonly path?: string }
  | { readonly kind: "diff"; readonly representations: DiffRepresentations; readonly origin: "preview" | "reported"; readonly path?: string; readonly moveTo?: string; readonly ambiguousAssociation?: true; readonly placement?: "inline"; readonly lineIdentifiers?: readonly DiffLineIdentifier[] }
  | { readonly kind: "changes"; readonly changes: readonly ReportedChange[]; readonly application?: ScopedApplicationReport }
  | { readonly kind: "locations"; readonly items: readonly ReportedLocation[] }
  | { readonly kind: "file-list"; readonly entries: readonly { readonly path: string; readonly directory?: true; readonly annotation?: string }[] }
  | { readonly kind: "ranked-files"; readonly query: string; readonly items: readonly { readonly path: string; readonly score: number; readonly hits: number; readonly firstLine1: number; readonly lastLine1: number; readonly extra?: JsonObject }[]; readonly coverage: { readonly files: number; readonly truncated: boolean; readonly extra?: JsonObject }; readonly extra?: JsonObject }
  | { readonly kind: "code-outline"; readonly path: string; readonly language?: string; readonly section?: string; readonly items: readonly OutlineEntry[]; readonly extra?: JsonObject }
  | { readonly kind: "structured-data"; readonly value: Json }
  | { readonly kind: "file-matches"; readonly groups: readonly [FileMatchGroup, ...FileMatchGroup[]] }
  | { readonly kind: "query-results"; readonly items: readonly QueryObservation[]; readonly responseId?: string; readonly fetchId?: string }
  | { readonly kind: "notice"; readonly severity: "error" | "warning" | "info"; readonly text: string; readonly origin: "producer" | "host" };
export interface ContentCaptureObservation { readonly producerTruncated?: boolean; readonly omittedBytes?: number; readonly fullOutputPath?: string; readonly logPath?: string }
export interface TargetCoverageObservation { readonly kind: "fetch" | "diagnostics"; readonly completedTargets: number; readonly attemptedTargets: number }
export interface ResultView { readonly parts: readonly [ResultPart, ...ResultPart[]]; readonly process?: ProcessObservation; readonly reportedFailure?: true; readonly contentCapture?: ContentCaptureObservation; readonly targetCoverage?: TargetCoverageObservation; readonly sourceSelection?: SourceSelection; readonly completeEditReceipt?: true }

export interface FamilyProjection {
  request(args: Json): RequestView;
  result(result: SuppliedToolResult, request?: RequestView): ResultView;
}
