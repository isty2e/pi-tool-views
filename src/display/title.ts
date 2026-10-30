import type { RequestView, ResultView } from "../presentation.ts";
import type { OperationView } from "../operations.ts";

interface Action { readonly present: string; readonly past: string; readonly failure: string; readonly target?: string }

function action(request: RequestView): Action | undefined {
  if ("intent" in request && request.intent === "preview") {
    return { present: "Previewing changes", past: "Previewed changes", failure: "Preview failed",
      ...(request.kind === "change.structural" && request.paths?.length === 1 ? { target: request.paths[0]! } : {}) };
  }
  switch (request.kind) {
    case "source.lines":
      return { present: "Reading", past: "Read", failure: "Read failed", target: request.path };
    case "source.symbol": case "source.enclosing":
      return { present: "Reading", past: "Read", failure: "Read failed", target: request.path };
    case "change.write": return { present: "Writing", past: "Wrote", failure: "Write failed", target: request.path };
    case "change.replacements": {
      const paths = [...new Set(request.requestedEdits.map(edit => edit.path))];
      return { present: "Updating", past: "Updated", failure: "Update failed", ...(paths.includes("") || paths.length === 0 ? {}
        : paths.length === 1 ? { target: paths[0]! } : { target: `${paths.length} files` }) };
    }
    case "change.patch": return { present: "Applying patch", past: "Applied patch", failure: "Patch failed" };
    case "change.structural": return { present: "Rewriting code", past: "Processed rewrite", failure: "Rewrite failed",
      ...(request.paths?.length === 1 ? { target: request.paths[0]! } : request.paths?.length ? { target: `${request.paths.length} paths` } : {}) };
    case "change.rename-symbol": return { present: "Renaming", past: "Renamed", failure: "Rename failed", target: request.newName };
    case "change.rename-file": return { present: "Renaming", past: "Renamed", failure: "Rename failed", target: request.path };
    case "shell.launch": return { present: "Running", past: "Ran", failure: "Run failed", target: request.command };
    case "session.poll": return { present: "Polling", past: "Polled", failure: "Poll failed", target: `session ${request.sessionId}` };
    case "session.send": return { present: "Sending input", past: "Sent input", failure: "Input failed", target: `session ${request.sessionId}` };
    case "program.javascript": case "program.typescript": return { present: "Running code", past: "Ran code", failure: "Code failed" };
    case "search.list": return { present: "Listing", past: "Listed", failure: "List failed", ...(request.root ? { target: request.root } : {}) };
    case "search.literal-any": return { present: "Searching", past: "Searched", failure: "Search failed", target: request.patterns.join(" | ") };
    case "search.ast": return { present: "Searching code", past: "Searched code", failure: "Code search failed" };
    case "search.files": case "search.text": case "search.symbols":
      return { present: "Searching", past: "Searched", failure: "Search failed", target: request.query };
    case "image.view": return { present: "Viewing", past: "Viewed", failure: "Image failed", target: request.path };
    case "image.synthesize": return { present: "Creating image", past: "Image generation", failure: "Image failed", ...(request.prompt ? { target: request.prompt } : {}) };
    case "web.fetch": return { present: "Fetching", past: "Fetched", failure: "Fetch failed", target: request.targets.kind === "multiple" ? request.targets.urls.join(", ") : request.targets.url };
    case "web.search": return { present: "Searching web", past: "Searched web", failure: "Web search failed", target: request.input.kind === "multiple" ? request.input.queries.join(" | ") : request.input.query };
    case "web.source-check": return { present: "Checking sources", past: "Checked sources", failure: "Source check failed", target: request.claim };
    case "web.url-context": return { present: "Reading web context", past: "Read web context", failure: "Web context failed", target: request.query };
    case "web.stored-find": case "web.stored-slice": return { present: "Reading stored content", past: "Read stored content", failure: "Stored content failed", target: request.responseId };
    case "web.compound": return { present: "Browsing", past: "Browsed", failure: "Web request failed" };
    case "code.ast-dump": return { present: "Inspecting syntax", past: "Inspected syntax", failure: "Syntax inspection failed", target: request.language };
    case "code.ast-validate": return { present: "Checking syntax", past: "Checked syntax", failure: "Syntax check failed", target: request.language };
    case "code.diagnostics": case "code.workspace-diagnostics": return { present: "Checking diagnostics", past: "Diagnostics", failure: "Diagnostics failed" };
    case "code.navigation": return { present: "Navigating code", past: "Navigated code", failure: "Navigation failed", target: request.target.path };
    case "code.document-symbols": case "code.module-report": return { present: "Inspecting code", past: "Inspected code", failure: "Inspection failed", target: request.path };
    case "code.symbol-query": return { present: "Finding symbol", past: "Found symbol", failure: "Symbol lookup failed", target: request.query };
    case "code.project-report": return { present: "Inspecting project", past: "Inspected project", failure: "Inspection failed" };
    case "code.outline": return { present: "Reading outline", past: "Read outline", failure: "Outline failed", target: request.paths.join(", ") };
    case "code.capabilities": return { present: "Inspecting capabilities", past: "Inspected capabilities", failure: "Inspection failed" };
    case "code.actions": return { present: "Finding code actions", past: "Found code actions", failure: "Code actions failed", target: request.target.path };
    case "code.command": return { present: "Running code action", past: "Ran code action", failure: "Code action failed", target: request.command };
    case "code.hierarchy": return { present: "Inspecting call hierarchy", past: "Inspected call hierarchy", failure: "Call hierarchy failed" };
    case "uninterpreted": return undefined;
  }
}

function locatedSourceTarget(request: RequestView, result: ResultView | undefined, failed: boolean): string | undefined {
  if (request.kind !== "source.symbol" && request.kind !== "source.enclosing") return undefined;
  const selection = result?.sourceSelection;
  if (!selection || selection.path !== request.path) return undefined;
  const label = selection.symbol ? [selection.symbol.kind, selection.symbol.name].filter(Boolean).join(" ") : undefined;
  const first = selection.range?.firstLine1, last = selection.range?.lastLine1;
  const validFirst = typeof first === "number" && Number.isSafeInteger(first) && first > 0;
  const validLast = typeof last === "number" && Number.isSafeInteger(last) && last > 0 && (!validFirst || last >= first);
  const hasBody = result.parts.some(part => part.kind === "source" && part.path === request.path);
  const reported = lineRange(validFirst ? first : undefined, validLast ? last : undefined);
  const range = reported && !failed && !hasBody ? `selected ${reported}` : reported;
  const outer = selection.enclosingRange;
  const validOuter = selection.partial && validFirst && validLast && outer && Number.isSafeInteger(outer.firstLine1)
    && Number.isSafeInteger(outer.lastLine1) && outer.firstLine1 > 0 && outer.firstLine1 <= first && last <= outer.lastLine1;
  const partial = selection.partial ? validOuter ? `partial of L${outer.firstLine1}–${outer.lastLine1}` : "partial" : undefined;
  const requestedSymbol = failed && request.kind === "source.symbol"
    && (selection.symbol?.name !== request.symbol || (request.kindFilter && selection.symbol.kind !== request.kindFilter))
    ? `requested ${[request.kindFilter, request.symbol].filter(value => value?.trim()).join(" ")}` : undefined;
  const requestedLine = failed && request.kind === "source.enclosing" && !range
    && Number.isSafeInteger(request.line1) && request.line1 > 0 ? `requested L${request.line1}` : undefined;
  const description = [label, requestedSymbol, range, requestedLine, partial].filter(Boolean).join("; ");
  return description ? `${request.path} (${description})` : request.path;
}

function positiveLine(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function lineRange(first?: number, last?: number): string | undefined {
  const start = positiveLine(first) ? first : undefined;
  const end = positiveLine(last) && (start === undefined || last >= start) ? last : undefined;
  return start === undefined && end === undefined ? undefined : `L${start ?? ""}–${end ?? ""}`;
}

function requestedSourceTarget(request: RequestView): string | undefined {
  if (request.kind === "source.symbol") {
    const target = [request.kindFilter, request.symbol].filter(value => value?.trim()).join(" ");
    return target ? `${request.path} (${target})` : request.path;
  }
  if (request.kind === "source.enclosing") {
    return Number.isSafeInteger(request.line1) && request.line1 > 0 ? `${request.path} (L${request.line1})` : request.path;
  }
  if (request.kind === "source.lines") {
    const first = request.firstLine1, limit = request.lineLimit;
    const validFirst = typeof first === "number" && Number.isSafeInteger(first) && first > 0;
    const validLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0;
    if (validFirst && validLimit) {
      const end = first + limit - 1;
      return Number.isSafeInteger(end) ? `${request.path} (requested ${lineRange(first, end)})` : `${request.path} (requested ${lineRange(first)}; up to ${limit} lines)`;
    }
    if (validFirst) return `${request.path} (requested ${lineRange(first)})`;
    return validLimit ? `${request.path} (requested up to ${limit} lines)` : request.path;
  }
  return undefined;
}

function returnedSourceTarget(request: RequestView, result: ResultView | undefined): string | undefined {
  if (request.kind !== "source.lines") return undefined;
  const selection = result?.sourceSelection;
  const reported = selection?.path === request.path ? lineRange(selection.range?.firstLine1, selection.range?.lastLine1) : undefined;
  if (reported) return `${request.path} (${reported})`;
  const sources = result?.parts.filter(part => part.kind === "source") ?? [];
  if (sources.length !== 1 || sources[0]?.kind !== "source" || sources[0].path !== request.path) return undefined;
  const { text, firstLine1: start } = sources[0].source;
  if (!positiveLine(start) || !text) return undefined;
  const count = text.split(/\r\n|\r|\n/).length;
  const range = lineRange(start, start + count - 1);
  return range ? `${request.path} (${range})` : undefined;
}

export interface TitleFacts {
  readonly label: string;
  readonly target?: string;
  readonly detail?: string;
  readonly state: "pending" | "running" | "complete" | "error" | "partial" | "active";
  readonly warning?: true;
}

export function titleFacts(toolName: string, request: RequestView, result: ResultView | undefined,
  started: boolean, complete: boolean, isError: boolean, actualName: boolean, commandPreview: boolean,
  operations: readonly OperationView[] = []): TitleFacts {
  const processFailed = result?.process?.state === "exited" && result.process.exitCode !== undefined && result.process.exitCode !== 0;
  const applications = result?.parts.flatMap(part => part.kind === "changes" && part.application ? [part.application] : []) ?? [];
  const calls = applications.filter(application => application.scope.kind === "call");
  const callOutcome = calls.length === 1 ? calls[0]?.outcome : undefined;
  const coverage = result?.targetCoverage;
  const partialCoverage = complete && coverage !== undefined && coverage.completedTargets < coverage.attemptedTargets;
  const partial = callOutcome === "reported-partial" || partialCoverage;
  const reportedFailure = callOutcome === "reported-failure" || result?.reportedFailure === true;
  const warning = calls.length > 1 || applications.some(application => application.scope.kind === "file" && application.outcome !== "reported-complete");
  const failed = isError || processFailed || reportedFailure;
  const active = result?.process?.state === "active";
  const state = failed ? "error" : partial ? "partial" : active ? "active" : complete ? "complete" : started ? "running" : "pending";
  const words = action(request);
  let label = actualName ? toolName : failed ? words?.failure ?? `Call failed: ${toolName}`
    : partialCoverage ? coverage.kind === "fetch" ? `Fetched ${coverage.completedTargets}/${coverage.attemptedTargets} targets`
      : `Checked ${coverage.completedTargets}/${coverage.attemptedTargets} diagnostic targets`
      : partial ? "Partial patch result" : active ? "Started"
      : complete && coverage?.kind === "diagnostics" && coverage.attemptedTargets > 0 ? "Checked diagnostics"
      : complete ? words?.past ?? `Called ${toolName}`
      : started ? words?.present ?? `Calling ${toolName}` : words ? `Preparing ${words.failure.replace(/ failed$/, "").toLowerCase()}` : `Preparing ${toolName}`;
  if (active && request.kind !== "shell.launch") label = actualName ? toolName : "Process still running";
  if (warning && !actualName && !failed && !partial) label = complete && !active ? "Returned with scoped reports" : `${label} (scoped reports)`;
  let target = request.kind === "shell.launch" && !commandPreview ? undefined
    : locatedSourceTarget(request, result, failed) ?? returnedSourceTarget(request, result)
      ?? (failed || (!complete && request.kind === "source.lines") ? requestedSourceTarget(request) : undefined) ?? words?.target;
  let detail: string | undefined;
  if (operations.length > 1) {
    const first = operations[0]!;
    const path = first.kind === "edit" ? first.path : undefined;
    const commonFile = path && operations.every(item => item.kind === "edit" && item.path === path
      && (item.moveTo === undefined || item.moveTo === path));
    const count = `${operations.length} operations`;
    if (commonFile) {
      target = path;
      detail = count;
    } else if (request.kind !== "web.source-check") target = count;
  }
  return { label, state, ...(warning ? { warning: true } : {}), ...(target !== undefined ? { target } : {}),
    ...(detail ? { detail } : {}) };
}
