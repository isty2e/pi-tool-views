import { editReceipt } from "./edit-receipt.ts";
import { codeEnvelope, codeFooter, resultMetadata } from "./result-metadata.ts";
import { searchTextParts } from "./search-text.ts";
import { fileListParts } from "./file-list.ts";
import { anchoredRead } from "./anchored-read.ts";
import { anchoredDiffIdentifiers } from "./anchored-diff.ts";
import { anchorSectionRemainder } from "./anchored-lines.ts";
import type {
	ContentCaptureObservation,
	EffectiveDeclaration,
	TargetCoverageObservation,
	Json,
	JsonObject,
	ProcessObservation,
	QueryObservation,
	ReportedChange,
	RequestView,
	ResultPart,
	ResultView,
	SourceText,
	SourceSelection,
	SuppliedContent,
	SuppliedToolResult,
} from "../presentation.ts";
import type { ResultFamily } from "./request.ts";
import { embeddedUnifiedSpans } from "../diff/formats.ts";
import { structuredCodeParts } from "./structured-code.ts";
import { groupedSearchParts } from "./grouped-search.ts";
import { rankedSearchParts } from "./ranked-search.ts";
import { sourceOutlineParts } from "./source-outline.ts";
import { arrayItem, description, hasPhrase, hasType, object, propertyEntries, schemaProperty, stringAt, uniqueProperty } from "./schema.ts";

function originalContent(indexes?: readonly number[]): ResultPart {
	if (!indexes || indexes.length === 0) return { kind: "original-content" };
	const tuple = indexes as readonly [number, ...number[]];
	return { kind: "original-content", indexes: tuple };
}

function resultView(parts: readonly ResultPart[], extra: Pick<ResultView, "process" | "reportedFailure" | "contentCapture" | "targetCoverage" | "sourceSelection" | "completeEditReceipt"> = {}): ResultView {
	const nonempty = parts.length === 0 ? [originalContent()] : parts;
	return { parts: nonempty as readonly [ResultPart, ...ResultPart[]], ...extra };
}

function allText(content: readonly SuppliedContent[]): readonly string[] | undefined {
	if (content.length === 0 || !content.every((item) => item.kind === "text")) return undefined;
	return content.map((item) => item.kind === "text" ? item.text : "");
}

function schemaAllowsString(schema: Json | undefined): boolean {
	const root = object(schema);
	if (!root) return false;
	if (root.type === "string") return true;
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = root[key];
		if (Array.isArray(branches) && branches.some((entry) => schemaAllowsString(entry))) return true;
	}
	return false;
}

function nativeTextRead(declaration: EffectiveDeclaration): boolean {
	if (declaration.input.kind !== "json") return false;
	return hasPhrase(declaration.description, "read the contents of a file")
		&& propertyEntries(object(declaration.input.schema)).some(([_key, property]) => hasPhrase(description(property), "path to the file to read"));
}

function reportedSourceSelection(result: SuppliedToolResult, request: RequestView | undefined): SourceSelection | undefined {
	if (request?.kind !== "source.symbol" && request?.kind !== "source.enclosing") return undefined;
	const details = object(result.details);
	if (!details) return undefined;
	if (request.kind === "source.enclosing" && details.line !== undefined && details.line !== request.line1) return undefined;
	if (details.path !== undefined && details.path !== request.path) return undefined;
	const name = stringAt(details, "name"), kind = stringAt(details, "kind");
	const symbol = name?.trim() || kind?.trim() ? { ...(name?.trim() ? { name } : {}), ...(kind?.trim() ? { kind } : {}) } : undefined;
	const positive = (value: Json | undefined): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	const first = positive(details.startLine), end = positive(details.endLine);
	const outerStart = positive(details.enclosingStartLine), outerEnd = positive(details.enclosingEndLine);
	const corroboratedFailure = details.found === false && request.kind === "source.enclosing" && details.line === request.line1
		&& Boolean(name?.trim()) && Boolean(kind?.trim()) && first !== undefined && end !== undefined
		&& first <= request.line1 && request.line1 <= end && outerStart === first && outerEnd === end;
	if (!(details.found === true || (details.found === false && object(details.selection)) || corroboratedFailure)) return undefined;
	const last = first !== undefined && end !== undefined && end < first ? undefined : end;
	const range = first !== undefined || last !== undefined
		? { ...(first === undefined ? {} : { firstLine1: first }), ...(last === undefined ? {} : { lastLine1: last }) } : undefined;
	const partial = details.partial === true;
	const enclosingRange = partial && first !== undefined && last !== undefined && outerStart !== undefined && outerEnd !== undefined
		&& outerStart <= first && last <= outerEnd ? { firstLine1: outerStart, lastLine1: outerEnd } : undefined;
	const bounds = partial ? enclosingRange : first !== undefined && last !== undefined
		? { firstLine1: first, lastLine1: last } : undefined;
	if (request.kind === "source.enclosing" && bounds
		&& (request.line1 < bounds.firstLine1 || request.line1 > bounds.lastLine1)) return undefined;
	if (!symbol && !range && !partial) return undefined;
	return { path: request.path, ...(symbol ? { symbol } : {}), ...(range ? { range } : {}),
		...(partial ? { partial: true } : {}), ...(enclosingRange ? { enclosingRange } : {}) };
}

function locatedSourceResult(result: SuppliedToolResult, request: RequestView | undefined, selection: SourceSelection | undefined): ResultView | undefined {
	if (result.isError || (request?.kind !== "source.symbol" && request?.kind !== "source.enclosing")) return undefined;
	const details = object(result.details);
	if (!details || details.found !== true || details.truncated === true || object(details.truncation)?.truncated === true) return undefined;
	const start = selection?.range?.firstLine1, end = selection?.range?.lastLine1;
	const kind = selection?.symbol?.kind, name = selection?.symbol?.name;
	if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1
		|| typeof end !== "number" || !Number.isSafeInteger(end) || end < start || !kind || !name) return undefined;
	const texts = allText(result.content);
	if (!texts || texts.length !== 1) return undefined;
	const text = texts[0];
	if (text === undefined) return undefined;
	const lineCount = end - start + 1;
	if (!Number.isSafeInteger(lineCount) || lineCount > text.length + 1) return undefined;

	const basename = request.path.split(/[\\/]/).at(-1);
	const header = text.split("\n", 1)[0];
	const symbol = `${kind} ${name}`;
	if (!basename || !header || !(header.startsWith(`${symbol}  `) || header.startsWith(`${symbol} (`))
		|| !header.includes(`  ${basename}:${start}-${end}`)) return undefined;
	const footer = codeFooter(text);
	if (footer && (footer.failed || footer.truncated)) return undefined;
	if (!footer && /\n\nresult (?:ok|error)\n/.test(text)) return undefined;
	const sourceEnd = footer?.offset ?? text.length;
	let sourceStart = sourceEnd;
	for (let index = 0; index < lineCount; index++) {
		const newline = text.lastIndexOf("\n", sourceStart - 1);
		if (newline < 0) return undefined;
		sourceStart = newline;
	}
	sourceStart += 1;
	const prefix = text.slice(0, sourceStart);
	const gap = prefix.slice(header.length);
	if (gap !== "\n\n" && !(details.readRecorded === false && /^\n\nWarning: [^\n]+\n\n$/.test(gap))) return undefined;
	const source = text.slice(sourceStart, sourceEnd);
	const suffix = text.slice(sourceEnd);
	const partial = selection?.partial === true;
	const enclosingRange = selection?.enclosingRange;
	const ordinaryHeader = `${symbol}  ${basename}:${start}-${end}`;
	const partialHeader = enclosingRange ? `${ordinaryHeader} (partial of ${enclosingRange.firstLine1}-${enclosingRange.lastLine1})` : undefined;
	const redundant = header === ordinaryHeader || (partial && header === partialHeader);
	const retainedPrefix = redundant ? gap.slice(2) : prefix;
	return resultView([...(retainedPrefix ? [{ kind: "text" as const, text: retainedPrefix }] : []),
		{ kind: "source", path: request.path, source: { text: source, firstLine1: start } },
		...(suffix && footer ? footer.parts : [])]);
}

function sourceResult(
	result: SuppliedToolResult,
	declaration: EffectiveDeclaration,
	request: RequestView | undefined,
	selection: SourceSelection | undefined,
): ResultView | undefined {
	const located = locatedSourceResult(result, request, selection);
	if (located) return located;
	const anchored = anchoredRead(result, request);
	if (anchored) return resultView(anchored);
	if (request?.kind === "source.lines" && request.lineEncoding) return undefined;
	const native = nativeTextRead(declaration);
	if (result.isError || (!native && !schemaAllowsString(declaration.outputSchema))) return undefined;
	const texts = allText(result.content);
	if (!texts || texts.length !== 1) return undefined;
	const text = texts[0];
	if (text === undefined) return undefined;
	const truncation = object(object(result.details)?.truncation);
	const suppliedSource = truncation ? stringAt(truncation, "content") : undefined;
	if (suppliedSource !== undefined && text.startsWith(suppliedSource)) {
		const parts: ResultPart[] = suppliedSource ? [{ kind: "source", source: { text: suppliedSource } }] : [];
		const remainder = text.slice(suppliedSource.length);
		if (remainder) {
			const footer = native && truncation?.truncated === true
				? /^\n\n\[Showing lines (\d+)-(\d+) of (\d+)(?: \([\d.]+ ?[kKmMgG]?[bB] limit\))?\. Use offset=(\d+) to continue\.\]$/.exec(remainder) : null;
			const valid = footer && footer.slice(1).every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)
				&& Number(footer[1]) === (request?.kind === "source.lines" ? request.firstLine1 ?? 1 : 1)
				&& Number(footer[2]) >= Number(footer[1]) && Number(footer[3]) >= Number(footer[2])
				&& Number(footer[4]) === Number(footer[2]) + 1;
			parts.push(valid ? { kind: "coverage", reason: "truncated", producerText: remainder }
				: { kind: "notice", text: remainder, severity: "info", origin: "producer" });
		}
		return resultView(parts);
	}
	if (truncation?.truncated === true) return undefined;
	const footer = native ? /\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text) : null;
	if (footer) {
		if (request?.kind !== "source.lines") return undefined;
		const firstLine = request.firstLine1 ?? 1;
		const limit = request.lineLimit;
		const body = text.slice(0, footer.index);
		if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(firstLine) && firstLine > 0
			&& Number.isSafeInteger(Number(footer[1])) && Number(footer[1]) > 0
			&& Number.isSafeInteger(firstLine + limit) && Number(footer[2]) === firstLine + limit
			&& body.split("\n").length === limit) {
			return resultView([{ kind: "source", source: { text: body } },
				{ kind: "coverage", reason: "continuation", producerText: text.slice(footer.index) }]);
		}
		if (limit !== undefined && (!Number.isSafeInteger(limit) || text.split("\n").length > limit)) return undefined;
	}
	if (native && /\n\n\[(?:Showing lines |Line \d+ is )[^\n]*\]$/.test(text)) return undefined;
	const source: SourceText = { text };
	return resultView([{ kind: "source", source }]);
}

function textMatches(content: readonly SuppliedContent[], candidate: string): readonly number[] {
	const indexes: number[] = [];
	for (let index = 0; index < content.length; index++) {
		const item = content[index];
		if (item?.kind === "text" && item.text === candidate) indexes.push(index);
	}
	return indexes;
}

function hasAnyContent(content: readonly SuppliedContent[]): boolean {
	return content.length > 0;
}

function nonNegativeInteger(value: Json | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function captureFacts(
	family: ResultFamily,
	content: readonly SuppliedContent[],
	details: JsonObject | undefined,
): ContentCaptureObservation | undefined {
	if (!["shell", "search", "search-text", "source"].includes(family) || !hasAnyContent(content)) return undefined;
	if (details) {
		const candidate = details;
		const truncation = object(candidate.truncation);
		if (truncation && typeof truncation.truncated === "boolean") {
			return {
				producerTruncated: truncation.truncated,
				...(truncation.truncated === true && nonNegativeInteger(truncation.totalBytes) && nonNegativeInteger(truncation.outputBytes)
					&& truncation.totalBytes >= truncation.outputBytes ? { omittedBytes: truncation.totalBytes - truncation.outputBytes } : {}),
				...(typeof candidate.fullOutputPath === "string" ? { fullOutputPath: candidate.fullOutputPath } : {}),
			};
		}
		const output = stringAt(candidate, "output");
		const contentLinked = output !== undefined && textMatches(content, output).length > 0;
		const explicitlyContentScoped = typeof candidate.content_truncated === "boolean"
			|| typeof candidate.contentTruncated === "boolean";
		if (!contentLinked && !explicitlyContentScoped) return undefined;
		const fullOutputPath = stringAt(candidate, "full_output_path") ?? stringAt(candidate, "fullOutputPath");
		const logPath = stringAt(candidate, "log_path") ?? stringAt(candidate, "logPath");
		const capture: ContentCaptureObservation = {
			...((candidate.content_truncated === true || candidate.contentTruncated === true || (contentLinked && candidate.truncated === true))
				? { producerTruncated: true }
				: {}),
			...(nonNegativeInteger(candidate.omitted_bytes) ? { omittedBytes: candidate.omitted_bytes } : {}),
			...(nonNegativeInteger(candidate.omittedBytes) ? { omittedBytes: candidate.omittedBytes } : {}),
			...(fullOutputPath === undefined ? {} : { fullOutputPath }),
			...(logPath === undefined ? {} : { logPath }),
		};
		if (Object.keys(capture).length > 0) return capture;
	}
	return undefined;
}

function hasFailureMessage(candidate: JsonObject): boolean {
	return [candidate.failure_message, candidate.failureMessage].some(value => typeof value === "string" && value.trim().length > 0);
}

function reportedFailure(family: ResultFamily, objects: readonly JsonObject[]): true | undefined {
	if (family === "shell" && objects.some(hasFailureMessage)) return true;
	if ((family === "web" || family === "web-fetch") && objects.some(candidate => candidate.error === true
		|| (typeof candidate.error === "string" && candidate.error.trim().length > 0))) return true;
	return undefined;
}

function processObservation(objects: readonly JsonObject[]): ProcessObservation | undefined {
	const observations: ProcessObservation[] = [];
	for (const candidate of objects) {
		const state = stringAt(candidate, "status") ?? stringAt(candidate, "state");
		const sessionId = typeof candidate.session_id === "number"
			? candidate.session_id
			: typeof candidate.sessionId === "number" ? candidate.sessionId : undefined;
		const running = candidate.running;
		const exitCode = typeof candidate.exit_code === "number"
			? candidate.exit_code
			: typeof candidate.exitCode === "number" ? candidate.exitCode : undefined;
		const signal = stringAt(candidate, "signal");
		const failure = hasFailureMessage(candidate);
		const reportsExit = (state === "exited" && !failure) || exitCode !== undefined || signal !== undefined;
		const exitUnreported = (candidate.exit_code === undefined || candidate.exit_code === null)
			&& (candidate.exitCode === undefined || candidate.exitCode === null);
		const outputChunk = typeof candidate.chunkId === "string" && nonNegativeInteger(candidate.originalTokenCount)
			&& typeof candidate.wallTimeSeconds === "number" && Number.isFinite(candidate.wallTimeSeconds) && candidate.wallTimeSeconds >= 0;
		const activeSession = sessionId !== undefined && (typeof candidate.output === "string" || outputChunk)
			&& state === undefined && running !== false && exitUnreported && !reportsExit && !failure;
		if (state === "running" || state === "active" || running === true || activeSession) {
			if (reportsExit || (sessionId !== undefined && !Number.isFinite(sessionId))) return undefined;
			observations.push({ state: "active", ...(sessionId === undefined ? {} : { sessionId }) });
		} else if (reportsExit) {
			observations.push({
				state: "exited",
				...(exitCode === undefined ? {} : { exitCode }),
				...(signal === undefined ? {} : { signal }),
			});
		}
	}
	if (observations.length === 0) return undefined;
	const first = observations[0];
	if (!first) return undefined;
	for (const observation of observations.slice(1)) {
		if (observation.state !== first.state) return undefined;
		if (first.state === "active" && observation.state === "active"
			&& first.sessionId !== undefined && observation.sessionId !== undefined
			&& first.sessionId !== observation.sessionId) return undefined;
		if (first.state === "exited" && observation.state === "exited"
			&& ((first.exitCode !== undefined && observation.exitCode !== undefined && first.exitCode !== observation.exitCode)
				|| (first.signal !== undefined && observation.signal !== undefined && first.signal !== observation.signal))) return undefined;
	}
	if (first.state === "active") {
		const sessionId = observations.find((observation) => observation.state === "active" && observation.sessionId !== undefined);
		return sessionId?.state === "active" && sessionId.sessionId !== undefined ? { state: "active", sessionId: sessionId.sessionId } : first;
	}
	const exitCode = observations.find((observation) => observation.state === "exited" && observation.exitCode !== undefined);
	const signal = observations.find((observation) => observation.state === "exited" && observation.signal !== undefined);
	return {
		state: "exited",
			...(exitCode?.state === "exited" && exitCode.exitCode !== undefined ? { exitCode: exitCode.exitCode } : {}),
			...(signal?.state === "exited" && signal.signal !== undefined ? { signal: signal.signal } : {}),
	};
}

function processDetails(result: SuppliedToolResult): readonly JsonObject[] {
	const candidates = [object(result.structuredContent), object(result.details)].filter((candidate): candidate is JsonObject => candidate !== undefined);
	return candidates;
}

function patchRepresentation(value: string): "codex" | "unified" | undefined {
	if (value.startsWith("*** Begin Patch")) return "codex";
	if (value.startsWith("diff --git ") || value.startsWith("--- ") || value.startsWith("@@ ") || /^Index: [^\r\n]+\r?\n={3,}\r?\n--- [^\r\n]+\r?\n\+\+\+ /.test(value)) return "unified";
	return undefined;
}

function targetCoverageObservation(family: ResultFamily, objects: readonly JsonObject[], request: RequestView | undefined): TargetCoverageObservation | undefined {
	const kind = family === "web-fetch" ? "fetch"
		: family === "code" && (request?.kind === "code.diagnostics" || request?.kind === "code.workspace-diagnostics") ? "diagnostics" : undefined;
	if (!kind) return undefined;
	let observation: TargetCoverageObservation | undefined;
	for (const candidate of objects) {
		let completedTargets: Json | undefined;
		let attemptedTargets: Json | undefined;
		if (kind === "fetch") {
			if (!("successful" in candidate) || !("urlCount" in candidate)) continue;
			completedTargets = candidate.successful;
			attemptedTargets = candidate.urlCount;
		} else {
			const counts = object(candidate.outcomeCounts);
			if (!counts || !("filesChecked" in candidate)) continue;
			const outcomes = new Set(["clean", "findings", "unsupported", "unavailable", "failed", "too_large", "inconclusive"]);
			if (Object.entries(counts).some(([key, value]) => !outcomes.has(key) || !nonNegativeInteger(value))) return undefined;
			if (!nonNegativeInteger(counts.clean) || !nonNegativeInteger(counts.findings) || !nonNegativeInteger(candidate.filesChecked)) return undefined;
			if (Object.values(counts).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0) > candidate.filesChecked) return undefined;
			completedTargets = counts.clean + counts.findings;
			attemptedTargets = candidate.filesChecked;
		}
		if (!nonNegativeInteger(completedTargets) || !nonNegativeInteger(attemptedTargets) || attemptedTargets < completedTargets) return undefined;
		if (observation && (observation.completedTargets !== completedTargets || observation.attemptedTargets !== attemptedTargets)) return undefined;
		observation = { kind, completedTargets, attemptedTargets };
	}
	return observation;
}

function diffPart(objects: readonly JsonObject[]): ResultPart | undefined {
	for (const candidate of objects) {
		const numbered = stringAt(candidate, "diff");
		const patch = stringAt(candidate, "patch");
		const format = patch === undefined ? undefined : patchRepresentation(patch);
		const preview = candidate.preview === true || candidate.origin === "preview";
		const origin = preview ? "preview" : "reported";
		if (numbered && patch) {
			if (!format) return undefined;
			return {
				kind: "diff",
				representations: format === "codex" ? { numbered, codex: patch } : { numbered, unified: patch },
				origin,
			};
		}
		if (numbered) return { kind: "diff", representations: { numbered }, origin };
		if (patch && format) {
			return { kind: "diff", representations: format === "codex" ? { codex: patch } : { unified: patch }, origin };
		}
	}
	return undefined;
}

function fileDiffParts(objects: readonly JsonObject[]): ResultPart[] {
	for (const candidate of objects) {
		if (!Array.isArray(candidate.changes)) continue;
		const counts = new Map<string, number>();
		for (const value of candidate.changes) {
			const path = stringAt(object(value) ?? {}, "path");
			if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
		}
		const entries = candidate.changes.flatMap((value) => {
			const change = object(value);
			if (!change || typeof change.kind !== "string" || !["add", "update", "delete"].includes(change.kind)) return [];
			const path = stringAt(change, "path");
			const numbered = stringAt(change, "displayDiff");
			const moveTo = stringAt(change, "moveTo");
			if (!path || !numbered || (change.moveTo !== undefined && !moveTo)) return [];
			const preview = change.preview === true || change.origin === "preview" || candidate.preview === true || candidate.origin === "preview";
			return [{ path, numbered, preview, ...(moveTo === undefined ? {} : { moveTo }) }];
		});
		return entries.map((entry) => ({
			kind: "diff" as const, origin: entry.preview ? "preview" as const : "reported" as const,
			path: entry.path, ...(entry.moveTo === undefined ? {} : { moveTo: entry.moveTo }),
			...(counts.get(entry.path)! > 1 ? { ambiguousAssociation: true as const } : {}),
			representations: { numbered: entry.numbered },
		}));
	}
	return [];
}

function cleanEditResult(result: SuppliedToolResult): boolean {
	return !result.isError && !processDetails(result).some(candidate => {
		const outcome = reportedOutcome(candidate.status) ?? reportedOutcome(candidate.outcome);
		return outcome === "reported-failure" || outcome === "reported-partial" || candidate.partialFailure === true
			|| [candidate.status, candidate.outcome].some(value => value !== undefined && reportedOutcome(value) !== "reported-complete")
			|| candidate.partial === true || candidate.truncated === true || object(candidate.truncation)?.truncated === true
			|| candidate.error === true || (typeof candidate.error === "string" && candidate.error.length > 0)
			|| candidate.warning === true || (typeof candidate.warning === "string" && candidate.warning.length > 0)
			|| candidate.preview === true || candidate.origin === "preview";
	});
}

function replacementReceipt(result: SuppliedToolResult, request: RequestView | undefined): string | undefined {
	if (!cleanEditResult(result) || request?.kind !== "change.replacements" || !request.requestedEdits.length
		|| result.content.length !== 1 || result.content[0]?.kind !== "text") return undefined;
	const paths = [...new Set(request.requestedEdits.map(edit => edit.path))];
	const path = paths.length === 1 ? paths[0] : undefined;
	if (!path) return undefined;
	const text = result.content[0].text;
	const message = text.replace(/\r?\n$/, "");
	return message === `Edited ${path}.` || message === `Successfully replaced ${request.requestedEdits.length} block(s) in ${path}.`
		? text : undefined;
}

function compactEditReceipt(result: SuppliedToolResult, request: RequestView | undefined): string | undefined {
	if (!cleanEditResult(result) || request?.kind !== "change.replacements" || request.requestedEdits.length < 2
		|| result.content.length !== 1 || result.content[0]?.kind !== "text") return undefined;
	const text = result.content[0].text;
	const headline = /^Applied (\d+) edit\(s\) successfully\.(\r?\n)/.exec(text);
	if (!headline || Number(headline[1]) !== request.requestedEdits.length) return undefined;
	let offset = headline[0].length;
	for (let index = 0; index < request.requestedEdits.length; index++) {
		const expected = `${index + 1}. Edited ${request.requestedEdits[index]!.path}.`;
		if (!text.startsWith(expected, offset)) return undefined;
		offset += expected.length;
		const ending = text.startsWith("\r\n", offset) ? "\r\n" : text[offset] === "\n" ? "\n" : "";
		if (!ending && (index < request.requestedEdits.length - 1 || offset !== text.length)) return undefined;
		if (index < request.requestedEdits.length - 1) offset += ending.length;
	}
	return headline[0].slice(0, -headline[2]!.length) + text.slice(offset);
}

function patchReceiptParts(result: SuppliedToolResult, request: RequestView | undefined): readonly ResultPart[] | undefined {
	if (!cleanEditResult(result) || request?.kind !== "change.patch" || result.content.length !== 1 || result.content[0]?.kind !== "text") return undefined;
	const data = object(object(result.details)?.result), paths = data?.changedFiles;
	if (!Array.isArray(paths) || !paths.length || !paths.every(path => typeof path === "string")) return undefined;
	const text = result.content[0].text;
	const header = /^Applied patch successfully(\r?\n)Changed files: (\d+)(?:\r?\n|$)/.exec(text);
	if (!header || Number(header[2]) !== paths.length) return undefined;
	const boundary = "Applied patch successfully".length + header[1]!.length;
	return [{ kind: "text", text: text.slice(0, boundary), role: "receipt" }, { kind: "text", text: text.slice(boundary) }];
}

function embeddedEditReceipt(result: SuppliedToolResult, request: RequestView | undefined, parts: readonly ResultPart[]): boolean {
	if (!cleanEditResult(result) || request?.kind !== "change.replacements" || request.requestedEdits.length < 2
		|| result.content.length !== 1 || parts.length !== 2 || parts[0]?.kind !== "text"
		|| parts[1]?.kind !== "diff" || parts[1].placement !== "inline") return false;
	const match = /^Replaced (\d+) occurrences in ([^\r\n]+)\r?\n$/.exec(parts[0].text);
	return !!match && Number(match[1]) === request.requestedEdits.length
		&& request.requestedEdits.every(edit => edit.path === match[2]);
}

function reportedOutcome(value: Json | undefined): "reported-complete" | "reported-partial" | "reported-failure" | undefined {
	if (typeof value !== "string") return undefined;
	if (["partial", "partial_failure", "incomplete"].includes(value)) return "reported-partial";
	if (["failed", "failure", "error"].includes(value)) return "reported-failure";
	if (["completed", "complete", "success", "succeeded"].includes(value)) return "reported-complete";
	return undefined;
}

function stringList(value: Json | undefined): readonly string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return value as readonly string[];
}

function changesPart(objects: readonly JsonObject[]): ResultPart | undefined {
	for (const candidate of objects) {
		const changes: ReportedChange[] = [];
		const seenActivities = new Set<string>();
		for (const [primary, alternate, activity] of [["addedFiles", "added", "added"], ["updatedFiles", "updated", "updated"], ["deletedFiles", "deleted", "deleted"]] as const) {
			if (seenActivities.has(activity)) continue;
			const key = primary in candidate ? primary : alternate;
			const paths = stringList(candidate[key]);
			if (paths) {
				seenActivities.add(activity);
				for (const path of paths) changes.push({ path, activity });
			}
		}
		const moved = stringList(candidate.movedFiles);
		if (moved) for (const path of moved) changes.push({ path, activity: "moved" });
		const declaredOutcome = reportedOutcome(candidate.status) ?? reportedOutcome(candidate.outcome);
		const outcome = candidate.partialFailure === true && declaredOutcome !== "reported-failure" ? "reported-partial" : declaredOutcome;
		if (changes.length === 0 && outcome === undefined) continue;
		return { kind: "changes", changes, ...(outcome === undefined ? {} : { application: { scope: { kind: "call" }, outcome } }) };
	}
	return undefined;
}

function noticePart(objects: readonly JsonObject[], result: SuppliedToolResult): ResultPart | undefined {
	if (!result.isError) return undefined;
	for (const candidate of objects) {
		const text = stringAt(candidate, "failure_message") ?? stringAt(candidate, "error");
		if (text && !result.content.some((item) => item.kind === "text" && item.text.includes(text))) {
			return { kind: "notice", severity: "error", text, origin: "producer" };
		}
	}
	return undefined;
}

function embeddedDiffParts(result: SuppliedToolResult, indexes: readonly number[]): readonly ResultPart[] | undefined {
	const parts: ResultPart[] = [];
	let found = false;
	for (const index of indexes) {
		const content = result.content[index];
		const spans = content?.kind === "text" ? embeddedUnifiedSpans(content.text) : [];
		if (content?.kind !== "text" || spans.length === 0) {
			parts.push(originalContent([index]));
			continue;
		}
		found = true;
		let offset = 0;
		for (const span of spans) {
			if (span.start > offset) parts.push({ kind: "text", text: content.text.slice(offset, span.start) });
			parts.push({ kind: "diff", origin: "reported", placement: "inline", representations: { unified: content.text.slice(span.start, span.end) } });
			offset = span.end;
		}
		if (offset < content.text.length) parts.push({ kind: "text", text: content.text.slice(offset) });
	}
	return found ? parts : undefined;
}

function queryResultsField(declaration: EffectiveDeclaration): string | undefined {
	return uniqueProperty(object(declaration.outputSchema), (_key, field) => {
		const item = arrayItem(field);
		return hasType(schemaProperty(item, "query"), "string")
			&& (hasType(schemaProperty(item, "answer"), "string") || arrayItem(schemaProperty(item, "results")) !== undefined
				|| hasType(schemaProperty(item, "error"), "string"));
	})?.[0];
}

function queryResults(result: SuppliedToolResult, field: string): { readonly part: ResultPart; readonly consumed: readonly number[] } | undefined {
	const decoded = result.content.map(content => {
		if (content.kind !== "text") return undefined;
		try { return object(JSON.parse(content.text)); } catch { return undefined; }
	});
	const root = [object(result.structuredContent), object(result.details), ...decoded]
		.find(candidate => candidate !== undefined && Array.isArray(candidate[field]));
	if (!root) return undefined;
	const items: QueryObservation[] = [];
	let incomplete = Object.keys(root).some(key => ![field, "responseId", "fetchId"].includes(key))
		|| ["responseId", "fetchId"].some(key => root[key] !== undefined && root[key] !== null && stringAt(root, key) === undefined);
	for (const value of root[field] as readonly Json[]) {
		const item = object(value);
		const query = item && stringAt(item, "query");
		if (query === undefined || !item) { incomplete = true; continue; }
		if (Object.keys(item).some(key => !["query", "answer", "error", "results"].includes(key))) incomplete = true;
		const answer = stringAt(item, "answer"), error = stringAt(item, "error");
		if ((item.answer !== undefined && answer === undefined) || (item.error !== undefined && item.error !== null && error === undefined)
			|| (item.results !== undefined && !Array.isArray(item.results))) incomplete = true;
		const sources = Array.isArray(item.results) ? item.results.flatMap(sourceValue => {
			const source = object(sourceValue);
			const url = source && stringAt(source, "url");
			if (!source || url === undefined) { incomplete = true; return []; }
			if (Object.keys(source).some(key => !["url", "title", "snippet"].includes(key))) incomplete = true;
			const title = stringAt(source, "title"), snippet = stringAt(source, "snippet");
			if ((source.title !== undefined && title === undefined) || (source.snippet !== undefined && snippet === undefined)) incomplete = true;
			return [{ url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }) }];
		}) : undefined;
		items.push({ query, ...(answer === undefined ? {} : { answer }), ...(error === undefined ? {} : { error }),
			...(sources === undefined ? {} : { sources }) });
	}
	if (!items.length) return undefined;
	const responseId = stringAt(root, "responseId"), fetchId = stringAt(root, "fetchId");
	const serialized = JSON.stringify(root);
	// Keep unclassified fields and producer prose alongside the normalized records.
	const consumed = incomplete ? [] : decoded.flatMap((value, index) => value && JSON.stringify(value) === serialized ? [index] : []);
	return { part: { kind: "query-results", items, ...(responseId === undefined ? {} : { responseId }),
		...(fetchId === undefined ? {} : { fetchId }) }, consumed };
}

function makeResult(
	family: ResultFamily,
	declaration: EffectiveDeclaration,
	result: SuppliedToolResult,
	request?: RequestView,
	queryField?: string,
): ResultView {
	const candidates = processDetails(result);
	const parts: ResultPart[] = [];
	const consumed = new Set<number>();
	let process: ProcessObservation | undefined;
	const sourceSelection = family === "source" ? reportedSourceSelection(result, request) : undefined;
	if (family === "web" && queryField !== undefined) {
		const queries = queryResults(result, queryField);
		if (queries) {
			parts.push(queries.part);
			for (const index of queries.consumed) consumed.add(index);
		}
	}

	if (family === "search" && request?.kind === "search.symbols") {
		const ranked = rankedSearchParts(result, request);
		if (ranked) return resultView(ranked);
	}

	if (family === "code" && request?.kind === "search.ast") {
		const groups = groupedSearchParts(result);
		if (groups) return resultView(groups);
	}

	if (family === "code" && (request?.kind === "code.outline" || request?.kind === "code.document-symbols" || request?.kind === "code.module-report" || request?.kind === "code.navigation")) {
		const structured = structuredCodeParts(result, request.kind, request.kind === "code.navigation" ? request.operation : undefined);
		if (structured) return resultView(structured.parts, structured.reportedFailure ? { reportedFailure: true } : {});
	}

	if (family === "source") {
		const outline = sourceOutlineParts(result, request, sourceSelection);
		if (outline) {
			const capture = captureFacts(family, result.content, object(result.details));
			return resultView(outline, { ...(sourceSelection ? { sourceSelection } : {}), ...(capture ? { contentCapture: capture } : {}) });
		}

		const source = sourceResult(result, declaration, request, sourceSelection);
		if (source) {
			const capture = captureFacts(family, result.content, object(result.details));
			return { ...source, ...(capture ? { contentCapture: capture } : {}), ...(sourceSelection ? { sourceSelection } : {}) };
		}
	}

	if (family === "search-text" || request?.kind === "search.text" || request?.kind === "search.literal-any") {
		const decoded = searchTextParts(result, declaration, request);
		if (decoded) {
			const capture = captureFacts(family, result.content, object(result.details));
			return resultView(decoded, capture ? { contentCapture: capture } : {});
		}
	}

	if (family === "search") {
		const listing = fileListParts(result, declaration, request);
		const capture = listing ? captureFacts(family, result.content, object(result.details)) : undefined;
		if (listing) return resultView(listing, capture ? { contentCapture: capture } : {});
	}

	if (request?.kind === "change.write" && cleanEditResult(result) && result.content.length === 1
		&& result.content[0]?.kind === "text" && result.content[0].text === `Successfully wrote to ${request.path}`) {
		return resultView([{ kind: "text", text: result.content[0].text, role: "receipt" }]);
	}

	if (["replacement", "patch"].includes(family)) {
		const diff = diffPart(candidates);
		const changes = changesPart(candidates);
		if (diff) {
			const identifiers = diff.kind === "diff" ? anchoredDiffIdentifiers(result, diff) : [];
			parts.push(diff.kind === "diff" && identifiers.length ? { ...diff, lineIdentifiers: identifiers } : diff);
			if (diff.kind === "diff") {
				const representations = diff.representations;
				for (const representation of [representations.numbered, representations.unified, representations.codex]) {
					if (representation) for (const index of textMatches(result.content, representation)) consumed.add(index);
				}
			}
		}
		if (!diff) parts.push(...fileDiffParts(candidates));
		if (changes) parts.push(changes);
		const notice = noticePart(candidates, result);
		if (notice) parts.push(notice);
	}

	if (family === "shell") {
		process = processObservation(candidates);
	}

	const capture = captureFacts(family, result.content, object(result.details));
	const targetCoverage = targetCoverageObservation(family, candidates, request);
	const failure = reportedFailure(family, candidates);
	const remaining = result.content.flatMap((_item, index) => consumed.has(index) ? [] : [index]);
	let completeEditReceipt: true | undefined;
	if (remaining.length > 0 || !hasAnyContent(result.content)) {
		const compact = remaining.length === 1 && remaining[0] === 0
			? compactEditReceipt(result, request) ?? replacementReceipt(result, request) : undefined;
		if (compact !== undefined && /^Applied \d+ edit\(s\) successfully\.(?:\r?\n)?$/.test(compact)) completeEditReceipt = true;
		const embedded = compact === undefined && ["replacement", "patch"].includes(family)
			&& !parts.some(part => part.kind === "diff") ? embeddedDiffParts(result, remaining) : undefined;
		const patch = compact === undefined && family === "patch" && remaining.length === 1 && remaining[0] === 0
			? patchReceiptParts(result, request) : undefined;
		if (patch) parts.push(...patch);
		else if (embedded) {
			const receipt = embeddedEditReceipt(result, request, embedded);
			if (receipt) completeEditReceipt = true;
			parts.push(...embedded.map(part => receipt && part.kind === "text" ? { ...part, role: "receipt" as const } : part));
		}
		else {
			const remainder = compact === undefined && family === "replacement" && remaining.length === 1 && remaining[0] === 0
				? anchorSectionRemainder(result, request, parts) : undefined;
			if (remainder !== undefined) {
				if (remainder) parts.push({ kind: "text", text: remainder });
			} else {
				const receipt = compact === undefined && family === "replacement" && remaining.length === 1 && remaining[0] === 0 && cleanEditResult(result)
					? editReceipt(result, request, parts) : undefined;
				if (receipt) parts.push(receipt);
				else parts.push(compact === undefined ? remaining.length === result.content.length ? originalContent() : originalContent(remaining)
					: { kind: "text", text: compact, role: "receipt" });
			}
		}
	}
	if (parts.length === 0) parts.push(originalContent());
	return resultView(parts, {
		...(process === undefined ? {} : { process }),
		...(capture === undefined ? {} : { contentCapture: capture }),
		...(targetCoverage === undefined ? {} : { targetCoverage }),
		...(failure === undefined ? {} : { reportedFailure: failure }),
		...(sourceSelection === undefined ? {} : { sourceSelection }),
		...(completeEditReceipt === undefined ? {} : { completeEditReceipt }),
	});
}

export function compileResult(family: ResultFamily, declaration: EffectiveDeclaration): (result: SuppliedToolResult, request?: RequestView) => ResultView {
	const queryField = queryResultsField(declaration);
	return (result, request) => {
		const projected = resultMetadata(makeResult(family, declaration, result, request, queryField), result, codeEnvelope(result, request));
		if (family === "source" && (request?.kind === "source.symbol" || request?.kind === "source.enclosing")) {
			const details = object(result.details);
			const warnings = typeof details?.found === "boolean" && Array.isArray(details.warnings)
				? details.warnings.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
			const text = result.content.flatMap(item => item.kind === "text" ? [item.text] : []).join("\n");
			const alreadyReported = details?.found === false && warnings.length > 0 && text.includes(`Warnings: ${warnings.join("; ")}`);
			if (warnings.length > 0 && !alreadyReported) {
				const notices: ResultPart[] = warnings.map(warning => ({ kind: "notice", severity: "warning", origin: "producer", text: `Warning: ${warning}` }));
				return { ...projected, parts: [notices[0]!, ...notices.slice(1), ...projected.parts] };
			}
		}
		if (request?.kind !== "source.lines") return projected;

		const withRequestSource = (part: ResultPart): ResultPart => {
			if (part.kind !== "source") return part;
			const path = part.path ?? request.path;
			return {
				...part, path,
				source: { ...part.source, ...(path === request.path && nativeTextRead(declaration) && part.source.firstLine1 === undefined
					? { firstLine1: request.firstLine1 ?? 1 } : {}) },
			};
		};
		return { ...projected, parts: [withRequestSource(projected.parts[0]), ...projected.parts.slice(1).map(withRequestSource)] };
	};
}
