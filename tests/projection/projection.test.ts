import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveDeclaration, Json, JsonObject, SuppliedToolResult } from "../../src/presentation.ts";
import { compileProjection } from "../../src/projection/index.ts";

type Schema = Record<string, unknown>;

function declaration(
	schema: Schema,
	options: Partial<Pick<EffectiveDeclaration, "description" | "outputSchema" | "sampling">> = {},
): EffectiveDeclaration {
	return {
		description: options.description ?? "A declared tool operation.",
		input: { kind: "json", schema: schema as Json },
		...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
		...(options.sampling === undefined ? {} : { sampling: options.sampling }),
	};
}

function stringField(description: string, required = false): Schema {
	return { type: "string", description, ...(required ? { required: true } : {}) };
}

function result(content: SuppliedToolResult["content"], overrides: Partial<SuppliedToolResult> = {}): SuppliedToolResult {
	return { content, isError: false, ...overrides };
}

test("reported symbol ranges normalize source without dropping warnings or producer footer", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path", "line"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	} }));
	const request = projection.request({ path: "src/math.ts", line: 6 });
	assert.equal(request.kind, "source.enclosing");
	const warning = "Warning: read coverage recording failed; the returned body may not satisfy the edit guard.\n\n";
	const prefix = "function add  math.ts:3-6\n\n" + warning;
	const body = "export function add() {\n\n  return 1;\n}";
	const footer = "\n\nresult ok\nusage tokens=50 elapsed-ms=0 bytes=199 truncated=false";
	const supplied = result([{ kind: "text", text: prefix + body + footer }], {
		details: { found: true, name: "add", kind: "function", startLine: 3, endLine: 6, partial: true, readRecorded: false },
	});
	const actual = projection.result(supplied, request);
	assert.deepEqual(actual.parts, [
		{ kind: "text", text: warning },
		{ kind: "source", path: "src/math.ts", source: { text: body, firstLine1: 3 } },
		{ kind: "text", text: "\n\nresult ok\n", role: "receipt" },
		{ kind: "text", text: footer.slice("\n\nresult ok\n".length), role: "usage" },
	]);
	assert.deepEqual(actual.sourceSelection, { path: "src/math.ts", symbol: { kind: "function", name: "add" },
		range: { firstLine1: 3, lastLine1: 6 }, partial: true });
	assert.equal(supplied.content[0]?.kind === "text" && supplied.content[0].text, prefix + body + footer);
	assert.deepEqual(supplied.details, { found: true, name: "add", kind: "function", startLine: 3, endLine: 6, partial: true, readRecorded: false });
});

test("unknown, conflicting, failed and truncated symbol bodies retain the original output", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path", "line"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	} }));
	const request = projection.request({ path: "src/math.ts", line: 4 });
	const text = "function add  math.ts:3-4\n\nfirst\nsecond\n\nresult ok\nusage tokens=1 elapsed-ms=0 bytes=1 truncated=false";
	for (const overrides of [
		{ details: { found: true, name: "add", kind: "function", startLine: 0, endLine: 4 } },
		{ details: { found: true, name: "add", kind: "function", startLine: 3, endLine: 5 } },
		{ details: { found: false, name: "add", kind: "function", startLine: 3, endLine: 4 } },
		{ details: { found: true, name: "add", kind: "function", startLine: 3, endLine: 4 }, isError: true },
	]) assert.deepEqual(projection.result(result([{ kind: "text", text }], overrides), request).parts, [{ kind: "original-content" }]);
	const truncated = text.replace("truncated=false", "truncated=true");
	assert.deepEqual(projection.result(result([{ kind: "text", text: truncated }], {
		details: { found: true, name: "add", kind: "function", startLine: 3, endLine: 4 },
	}), request).parts, [{ kind: "original-content" }]);
	const misleadingPrefix = "function add  math.ts:3-4\n\nfirst source line\n\nsecond\nthird\n\nresult ok\nusage tokens=1 elapsed-ms=0 bytes=1 truncated=false";
	const details = { found: true, name: "add", kind: "function", startLine: 3, endLine: 4 };
	assert.deepEqual(projection.result(result([{ kind: "text", text: misleadingPrefix }], { details }), request).parts,
		[{ kind: "original-content" }]);
	const malformedFooter = text.replace("tokens=1", "tokens=unknown");
	assert.deepEqual(projection.result(result([{ kind: "text", text: malformedFooter }], { details }), request).parts,
		[{ kind: "original-content" }]);
	const otherSymbol = text.replace("function add  ", "function additional  ");
	assert.deepEqual(projection.result(result([{ kind: "text", text: otherSymbol }], { details }), request).parts,
		[{ kind: "original-content" }]);
});

test("symbol reads use the returned range rather than the requested symbol and preserve the returned source", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path", "symbol"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		symbol: stringField("Exact symbol name or callback handle to read."),
	} }));
	const request = projection.request({ path: "src/math.ts", symbol: "Calculator.calculate" });
	assert.equal(request.kind, "source.symbol");
	const text = "method calculate  math.ts:11-12\n\ncalculate() {\n  return 1;\n\nresult ok\nusage tokens=50 elapsed-ms=0 bytes=199 truncated=false";
	const output = projection.result(result([{ kind: "text", text }], {
		details: { found: true, name: "calculate", kind: "method", startLine: 11, endLine: 12 },
	}), request);
	const source = output.parts.find(part => part.kind === "source");
	assert.ok(source?.kind === "source");
	assert.deepEqual(source.source, { text: "calculate() {\n  return 1;", firstLine1: 11 });
	assert.deepEqual(output.sourceSelection, { path: "src/math.ts", symbol: { kind: "method", name: "calculate" },
		range: { firstLine1: 11, lastLine1: 12 } });
});

test("symbol reads retain only an explicitly declared and supplied symbol kind filter", () => {
	const schema = { type: "object", required: ["path", "symbol"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		symbol: stringField("Exact symbol name or callback handle to read."),
		kind: stringField("Optional kind filter, e.g. function, interface, or class."),
	} };
	const projection = compileProjection(declaration(schema));
	assert.deepEqual(projection.request({ path: "src/math.ts", symbol: "add", kind: "function" }),
		{ kind: "source.symbol", path: "src/math.ts", symbol: "add", kindFilter: "function" });
	assert.deepEqual(projection.request({ path: "src/math.ts", symbol: "add" }),
		{ kind: "source.symbol", path: "src/math.ts", symbol: "add" });
	const unrelated = { ...schema, properties: { ...schema.properties, kind: stringField("Output encoding kind.") } };
	assert.deepEqual(compileProjection(declaration(unrelated)).request({ path: "src/math.ts", symbol: "add", kind: "function" }),
		{ kind: "source.symbol", path: "src/math.ts", symbol: "add" });
});

test("partial source preserves enclosing range and ambiguity that cannot be folded into the title", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path", "line"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	} }));
	const request = projection.request({ path: "src/math.ts", line: 6 });
	const details = { found: true, name: "add", kind: "function", startLine: 3, endLine: 4,
		partial: true, enclosingStartLine: 1, enclosingEndLine: 20 };
	const footer = "\n\nresult ok\nusage tokens=1 elapsed-ms=0 bytes=1 truncated=false";
	const output = projection.result(result([{ kind: "text", text: "function add  math.ts:3-4 (partial of 1-20)\n\nfirst\nsecond" + footer }], { details }), request);
	assert.deepEqual(output.parts, [
		{ kind: "source", path: "src/math.ts", source: { text: "first\nsecond", firstLine1: 3 } },
		{ kind: "text", text: "\n\nresult ok\n", role: "receipt" },
		{ kind: "text", text: footer.slice("\n\nresult ok\n".length), role: "usage" },
	]);
	assert.deepEqual(output.sourceSelection, { path: "src/math.ts", symbol: { kind: "function", name: "add" },
		range: { firstLine1: 3, lastLine1: 4 }, partial: true, enclosingRange: { firstLine1: 1, lastLine1: 20 } });
	const ambiguous = "function add (2 matches — returned first)  math.ts:3-4\n\nfirst\nsecond" + footer;
	const view = projection.result(result([{ kind: "text", text: ambiguous }], { details }), request);
	assert.ok(view.parts.some(part => part.kind === "text" && part.text.includes("2 matches")));
	const invalidEnclosing = projection.result(result([{ kind: "text", text: "function add  math.ts:3-4 (partial of 8-20)\n\nfirst\nsecond" + footer }],
		{ details: { ...details, enclosingStartLine: 8 } }), request);
	assert.ok(invalidEnclosing.parts.some(part => part.kind === "text" && part.text.includes("partial of 8-20")));
});

test("failed enclosing reads retain independently reported selection without inventing a source body", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path", "line"], properties: {
		path: stringField("Absolute or workspace-relative path to the source file."),
		line: { type: "number", description: "1-based line number inside the desired symbol/callback." },
		maxLines: { type: "number", description: "Optional maximum body size to return." },
	} }));
	const request = projection.request({ path: "src/math.ts", line: 6, maxLines: 2 });
	const details = { found: false, line: 6, name: "add", kind: "function", startLine: 3, endLine: 8,
		selection: { strategy: "oversize-outline", source: "tree-sitter", confidence: "medium" } };
	const text = "Enclosing function exceeds the maximum body size";
	const view = projection.result(result([{ kind: "text", text }], { isError: true, details }), request);
	assert.deepEqual(view.parts, [{ kind: "original-content" }]);
	assert.deepEqual(view.sourceSelection, { path: "src/math.ts", symbol: { name: "add", kind: "function" },
		range: { firstLine1: 3, lastLine1: 8 } });
	assert.equal(projection.result(result([{ kind: "text", text }], { isError: true,
		details: { ...details, line: 9 } }), request).sourceSelection, undefined);
	const wrongRange = projection.request({ path: "src/math.ts", line: 9 });
	assert.equal(projection.result(result([{ kind: "text", text }], { isError: true,
		details: { ...details, line: 9 } }), wrongRange).sourceSelection, undefined);
	assert.equal(projection.result(result([{ kind: "text", text }], { isError: true,
		details: { found: false, name: "candidate", startLine: 1, endLine: 2 } }), request).sourceSelection, undefined);
	const partial = projection.result(result([{ kind: "text", text }], { isError: true,
		details: { found: false, selection: { strategy: "candidate" }, name: "add" } }), request);
	assert.deepEqual(partial.sourceSelection, { path: "src/math.ts", symbol: { name: "add" } });
	const withoutBody = projection.result(result([{ kind: "text", text: "Unrecognized source representation" }], {
		details: { found: true, name: "add", kind: "function", startLine: 3, endLine: 8 },
	}), request);
	assert.deepEqual(withoutBody.parts, [{ kind: "original-content" }]);
	assert.deepEqual(withoutBody.sourceSelection, { path: "src/math.ts", symbol: { name: "add", kind: "function" },
		range: { firstLine1: 3, lastLine1: 8 } });
});

test("native read limits preserve source and a separately supplied continuation notice", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["path"], properties: {
		path: stringField("Path to the file to read."),
		offset: { type: "number", description: "Line number to start reading from (1-indexed)." },
		limit: { type: "number", description: "Maximum number of lines to read." },
	} }, { description: "Read the contents of a file." }));
	const request = projection.request({ path: "module.ts", offset: 11, limit: 2 });
	const body = "const first = 1;\nconst second = 2;";
	const notice = "\n\n[6 more lines in file. Use offset=13 to continue.]";
	const supplied = result([{ kind: "text", text: body + notice }]);
	assert.deepEqual(projection.result(supplied, request).parts, [
		{ kind: "source", path: "module.ts", source: { text: body, firstLine1: 11 } },
		{ kind: "coverage", reason: "continuation", producerText: notice },
	]);
	assert.deepEqual(projection.result(supplied).parts, [{ kind: "original-content" }]);
	assert.deepEqual(projection.result(supplied, { kind: "uninterpreted" }).parts, [{ kind: "original-content" }]);
	const wrongOffset = result([{ kind: "text", text: body + notice.replace("offset=13", "offset=14") }]);
	assert.deepEqual(projection.result(wrongOffset, request).parts, [{ kind: "original-content" }]);
	assert.deepEqual(projection.result({ ...supplied, isError: true }, request).parts, [{ kind: "original-content" }]);

	for (const args of [{ path: "module.ts", offset: 11, limit: 20 }, { path: "module.ts", offset: 11 }]) {
		assert.deepEqual(projection.result(supplied, projection.request(args)).parts,
			[{ kind: "source", path: "module.ts", source: { text: body + notice, firstLine1: 11 } }], "footer-like file contents must remain source");
	}
	const truncated = result([{ kind: "text", text: body + "\n\n[Showing lines 11-12. Use offset=13 to continue.]" }],
		{ details: { truncation: { content: body, truncated: true } } });
	assert.deepEqual(projection.result(truncated, request).parts[0], { kind: "source", path: "module.ts", source: { text: body, firstLine1: 11 } });
	assert.equal(projection.result(truncated, request).parts[1]?.kind, "notice");
	const missingMetadata = result(truncated.content);
	assert.deepEqual(projection.result(missingMetadata, request).parts, [{ kind: "original-content" }],
		"a truncation notice without its source-boundary metadata cannot invent file line positions");
});

test("unknown and ambiguous declarations preserve request and supplied result", () => {
	const unknown = compileProjection(declaration({
		type: "object",
		required: ["value"],
		properties: { value: { type: "string", description: "Unrelated free-form value." } },
	}));
	assert.deepEqual(unknown.request({ value: "text" }), { kind: "uninterpreted" });
	assert.deepEqual(unknown.result(result([{ kind: "text", text: "body" }, { kind: "image", data: "x", mimeType: "image/test" }])), {
		parts: [{ kind: "original-content" }],
	});
	assert.deepEqual(compileProjection(undefined).request({}), { kind: "uninterpreted" });

	const conflictingPatchAndEdit = compileProjection(declaration({
		type: "object",
		required: ["path", "oldText", "newText", "patch"],
		properties: {
			path: { type: "string", description: "File path." },
			oldText: { type: "string", description: "Old text." },
			newText: { type: "string", description: "New text." },
			patch: { type: "string", description: "Codex-style patch payload." },
		},
	}));
	assert.deepEqual(conflictingPatchAndEdit.request({ path: "a", oldText: "x", newText: "y", patch: "patch" }), { kind: "uninterpreted" });
});

test("source and file-write requests preserve declared units and source data", () => {
	const read = compileProjection(declaration({
		type: "object",
		required: ["sourceFile"],
		properties: {
			sourceFile: { type: "string", description: "Path to the file to read (relative or absolute)." },
			startAt: { type: "number", description: "Line number to start reading from (1-indexed)." },
			lineCount: { type: "number", description: "Maximum number of lines to read." },
			newOptionalFlag: { type: "boolean", description: "Unrelated optional setting." },
		},
	}));
	assert.deepEqual(read.request({ sourceFile: "src/a.ts", startAt: 14, lineCount: 8, newOptionalFlag: true }), {
		kind: "source.lines", path: "src/a.ts", firstLine1: 14, lineLimit: 8,
	});
	assert.deepEqual(read.request({ sourceFile: "src/a.ts" }), { kind: "source.lines", path: "src/a.ts" });

	const sourceOutput = compileProjection(declaration({
		type: "object", required: ["path"], properties: {
			path: { type: "string", description: "Path to the file to read." },
			offset: { type: "number", description: "Line number to start reading from (1-indexed)." },
			limit: { type: "number", description: "Maximum number of lines to read." },
		},
	}, { outputSchema: { type: "string" } }));
	assert.deepEqual(sourceOutput.result(result([{ kind: "text", text: "const value = 1;\n" }])), {
		parts: [{ kind: "source", source: { text: "const value = 1;\n" } }],
	});
	const suppliedSource = result([{ kind: "text", text: "const value = 1;\n" }]);
	const unchangedSource = structuredClone(suppliedSource);
	for (const args of [{ path: "module.ts" }, { path: "module.ts", offset: 21 }]) {
		assert.deepEqual(sourceOutput.result(suppliedSource, sourceOutput.request(args)).parts, [
			{ kind: "source", path: "module.ts", source: { text: "const value = 1;\n" } },
		], "an output string schema does not establish actual returned coordinates");
	}
	assert.deepEqual(suppliedSource, unchangedSource, "deriving display context does not mutate the result");
	assert.deepEqual(sourceOutput.result(suppliedSource, { kind: "uninterpreted" }).parts, [
		{ kind: "source", source: { text: "const value = 1;\n" } },
	], "missing request context does not hide source or invent a path or file position");
	assert.deepEqual(sourceOutput.result(result([{ kind: "text", text: "not source" }], { isError: true })), {
		parts: [{ kind: "original-content" }],
	});

	const write = compileProjection(declaration({
		type: "object",
		required: ["path", "content"],
		properties: {
			path: { type: "string", description: "Path to the file to write." },
			content: { type: "string", description: "Content to write to the file." },
		},
	}));
	assert.deepEqual(write.request({ path: "new.txt", content: "exact\ntext" }), {
		kind: "change.write", path: "new.txt", content: "exact\ntext",
	});
});

test("declared edit arrays accept direct, singleton, and one JSON encoding without mutation", () => {
	const editDeclaration = declaration({
		type: "object",
		required: ["path", "edits"],
		properties: {
			path: { type: "string", description: "Path to the file to edit." },
			edits: {
				type: "array",
				description: "One or more targeted replacements.",
				items: {
					type: "object", required: ["oldText", "newText"],
					properties: {
						oldText: { type: "string", description: "Exact old text." },
						newText: { type: "string", description: "Replacement text." },
					},
				},
			},
		},
	});
	const projection = compileProjection(editDeclaration);
	const edit = { oldText: "old", newText: "new" };
	const original = { path: "src/a.ts", edits: [edit] };
	const before = structuredClone(original);
	for (const encoded of [original.edits, edit, JSON.stringify(original.edits), JSON.stringify(edit)]) {
		assert.deepEqual(projection.request({ path: original.path, edits: encoded as Json }), {
			kind: "change.replacements",
			requestedEdits: [{ path: "src/a.ts", oldText: "old", newText: "new" }],
		});
	}
	assert.deepEqual(original, before);
	assert.deepEqual(projection.request({ path: "src/a.ts", edits: [{ oldText: "x" }] }), { kind: "uninterpreted" });
	assert.deepEqual(projection.request({ path: "src/a.ts", edits: "not-json" }), { kind: "uninterpreted" });
	assert.deepEqual(projection.request({ path: "src/a.ts", oldText: "legacy", newText: "alias" }), { kind: "change.replacements",
		requestedEdits: [{ path: "src/a.ts", oldText: "legacy", newText: "alias" }] });

	const compactEdit = compileProjection(declaration({
		type: "object", required: ["path", "edits"], properties: {
			path: { type: "string" },
			edits: { type: "array", items: { type: "object", required: ["oldText", "newText"], properties: {
				oldText: { type: "string" }, newText: { type: "string" },
			} } },
		},
	}));
	assert.deepEqual(compactEdit.request({ path: "src/b.ts", edits: { oldText: "before", newText: "after" } }), {
		kind: "change.replacements", requestedEdits: [{ path: "src/b.ts", oldText: "before", newText: "after" }],
	});

	const groupedEdit = compileProjection(declaration({
		type: "object", required: ["path"], properties: {
			path: { type: "string" },
			oldText: { type: "string" },
			newText: { type: "string" },
			patch: { type: "string", description: "Codex-style patch payload." },
			multi: { type: "array", items: { type: "object", required: ["oldText", "newText"], properties: {
				path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
			} } },
		},
	}));
	assert.deepEqual(groupedEdit.request({ path: "src/c.ts", oldText: "old", newText: "new" }), {
		kind: "change.replacements", requestedEdits: [{ path: "src/c.ts", oldText: "old", newText: "new" }],
	});
	assert.deepEqual(groupedEdit.request({ path: "src/c.ts", multi: [{ path: "src/d.ts", oldText: "before", newText: "after" }] }), {
		kind: "change.replacements", requestedEdits: [{ path: "src/d.ts", oldText: "before", newText: "after" }],
	});
	assert.deepEqual(groupedEdit.request({ path: "src/c.ts", oldText: "old", newText: "new", multi: [
		{ oldText: "before", newText: "after" }, { path: "src/d.ts", oldText: "other", newText: "updated" },
	] }), { kind: "change.replacements", requestedEdits: [
		{ path: "src/c.ts", oldText: "old", newText: "new" },
		{ path: "src/c.ts", oldText: "before", newText: "after" },
		{ path: "src/d.ts", oldText: "other", newText: "updated" },
	] });
});

test("patch grammar and result diff representations retain one material and provenance", () => {
	const patch = compileProjection(declaration({
		type: "object", required: ["payload"],
		properties: { payload: { type: "string", description: "Codex-style patch text beginning with *** Begin Patch." } },
	}));
	assert.deepEqual(patch.request({ payload: "*** Begin Patch\n*** End Patch" }), {
		kind: "change.patch", text: "*** Begin Patch\n*** End Patch", format: "codex",
	});
	const unified = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new";
	assert.deepEqual(patch.result(result([{ kind: "text", text: "saved" }], {
		details: { diff: " 1 -old\n 1 +new", patch: unified, preview: true },
	})), {
		parts: [
			{ kind: "diff", representations: { numbered: " 1 -old\n 1 +new", unified }, origin: "preview" },
			{ kind: "original-content" },
		],
	});
	assert.deepEqual(patch.result(result([{ kind: "text", text: unified }, { kind: "text", text: "warning" }], {
		details: { patch: unified, status: "completed", updatedFiles: ["a.txt"] },
	})).parts, [
		{ kind: "diff", representations: { unified }, origin: "reported" },
		{ kind: "changes", changes: [{ path: "a.txt", activity: "updated" }], application: { scope: { kind: "call" }, outcome: "reported-complete" } },
		{ kind: "original-content", indexes: [1] },
	]);
	assert.deepEqual(patch.result(result([{ kind: "text", text: "tool output" }], {
		details: { diff: "numbered lines", patch: "an unrecognized patch representation" },
	})), { parts: [{ kind: "original-content" }] });
	assert.deepEqual(patch.result(result([], {
		details: { updatedFiles: ["a.txt"], updated: ["a.txt"] },
	})).parts, [
		{ kind: "changes", changes: [{ path: "a.txt", activity: "updated" }] },
		{ kind: "original-content" },
	]);
});

test("shell declarations keep deadlines, waits, process reports, and content capture distinct", () => {
	const seconds = compileProjection(declaration({
		type: "object", required: ["command"],
		properties: {
			command: { type: "string", description: "Shell command to execute." },
			timeout: { type: "number", description: "Maximum timeout in seconds." },
			yield_time_ms: { type: "number", description: "Attachment wait time in milliseconds." },
		},
	}));
	assert.deepEqual(seconds.request({ command: "echo ok", timeout: 2, yield_time_ms: 450 }), {
		kind: "shell.launch", command: "echo ok", processTimeoutMs: 2000, wait: { milliseconds: 450 },
	});
	const milliseconds = compileProjection(declaration({
		type: "object", required: ["cmd"],
		properties: {
			cmd: { type: "string", description: "Shell command to run." },
			timeout_ms: { type: "number", description: "Maximum runtime in milliseconds." },
		},
	}));
	assert.deepEqual(milliseconds.request({ cmd: "true", timeout_ms: 2, timeout: 900 }), {
		kind: "shell.launch", command: "true", processTimeoutMs: 2,
	});
	assert.deepEqual(seconds.result(result([{ kind: "text", text: "running output" }], { details: { running: true, session_id: 41 } })).process, {
		state: "active", sessionId: 41,
	});
	assert.equal(seconds.result(result([{ kind: "text", text: "still running" }], { details: { running: false } })).process, undefined);
	assert.deepEqual(seconds.result(result([{ kind: "text", text: "failed output" }], { details: { exit_code: 7 } })).process, {
		state: "exited", exitCode: 7,
	});
	assert.equal(seconds.result(result([{ kind: "text", text: "ambiguous state" }], {
		structuredContent: { running: true, session_id: 41 },
		details: { exit_code: 7 },
	})).process, undefined);

	const captured = compileProjection(declaration({
		type: "object", required: ["command"], properties: { command: { type: "string", description: "Shell command to execute." } },
	}, { outputSchema: {
		type: "object", properties: { output: { type: "string" }, truncated: { type: "boolean" }, full_output_path: { type: "string" } },
	} }));
	assert.deepEqual(captured.result(result([{ kind: "text", text: "tail" }], {
		details: { output: "tail", truncated: true, full_output_path: "/tmp/captured-output" },
	})).contentCapture, { producerTruncated: true, fullOutputPath: "/tmp/captured-output" });
	assert.equal(captured.result(result([{ kind: "text", text: "other channel" }], {
		structuredContent: { output: "tail", truncated: true, full_output_path: "/tmp/structured-only" },
	})).contentCapture, undefined);
});

test("session output with an omitted exit code retains process continuation without overriding explicit reports", () => {
	const projection = compileProjection(declaration({
		type: "object", required: ["cmd"], properties: {
			cmd: { type: "string", description: "Shell command to run." },
		},
	}));
	const output = "ready for input\n";
	for (const details of [
		{ output, session_id: 41 },
		{ output, session_id: 41, exit_code: null },
		{ output, sessionId: 41 },
		{ output, sessionId: 41, exitCode: null },
	]) {
		assert.deepEqual(projection.result(result([{ kind: "text", text: output }], { details })).process,
			{ state: "active", sessionId: 41 });
	}
	assert.equal(projection.result(result([], { details: { session_id: 41 } })).process, undefined,
		"a bare identifier is not evidence of a running process");
	for (const extra of [{ running: false }, { status: "finished" }, { exit_code: "unknown" }]) {
		assert.equal(projection.result(result([{ kind: "text", text: output }], {
			details: { output, session_id: 41, ...extra },
		})).process, undefined, "missing information does not erase explicit contrary or invalid metadata");
	}
	assert.deepEqual(projection.result(result([{ kind: "text", text: "done" }], {
		details: { output: "done", session_id: 41, exit_code: 7 },
	})).process, { state: "exited", exitCode: 7 });
	assert.equal(projection.result(result([{ kind: "text", text: output }], {
		details: { output, session_id: 41 }, structuredContent: { exit_code: 7 },
	})).process, undefined, "conflicting current reports remain indeterminate");
});

test("execution chunks and reported failures preserve liveness separately from call outcome", () => {
	const projection = compileProjection(declaration({ type: "object", required: ["cmd"], properties: {
		cmd: { type: "string", description: "Shell command to run." },
	} }));
	const content = [{ kind: "text" as const, text: "Process running with session ID 41\nOutput:\n" }];
	const chunk = { sessionId: 41, chunkId: "actual-chunk", wallTimeSeconds: 0.2, originalTokenCount: 0 };
	assert.deepEqual(projection.result(result(content, { details: chunk })).process, { state: "active", sessionId: 41 });
	assert.equal(projection.result(result(content, { details: { sessionId: 41, chunkId: "identifier-only" } })).process, undefined);
	const failed = projection.result(result(content, { details: {
		status: "exited", running: false, output: "", failure_message: "process error: spawn failed",
	} }));
	assert.equal(failed.reportedFailure, true);
	assert.equal(failed.process, undefined, "a launch error does not establish an OS process exit");
	const activeFailure = projection.result(result(content, { details: { running: true, sessionId: 41, failure_message: "input rejected" } }));
	assert.equal(activeFailure.reportedFailure, true);
	assert.deepEqual(activeFailure.process, { state: "active", sessionId: 41 });
	assert.equal(projection.result(result(content, { details: { failure_message: " " } })).reportedFailure, undefined);
});

test("explicit web error reports remain failures when the host flag is false", () => {
	const web = compileProjection(declaration({ type: "object", required: ["query"], properties: {
		query: { type: "string", description: "Single search query." },
	} }));
	for (const error of [true, "unsupported_model"]) {
		const supplied = result([{ kind: "text", text: "The producer could not obtain a result." }], { details: { error } });
		assert.equal(web.result(supplied).reportedFailure, true);
		assert.equal(supplied.isError, false, "presentation does not rewrite the producer or host result");
	}
	assert.equal(web.result(result([], { details: { error: false } })).reportedFailure, undefined);
	assert.equal(compileProjection(declaration({ type: "object" })).result(result([], { details: { error: true } })).reportedFailure, undefined);
});

test("diagnostic coverage counts confirmed checks rather than findings or files merely selected", () => {
	const diagnostics = compileProjection(declaration({ type: "object", properties: {
		source: { type: "string", enum: ["session", "lsp"] }, scope: { type: "string", enum: ["paths", "workspace"] },
		mode: { type: "string", enum: ["delta", "all", "full"] }, paths: { type: "array", items: { type: "string" } }, path: { type: "string" },
	} }));
	const request = diagnostics.request({});
	const project = (details: JsonObject) => diagnostics.result(result([{ kind: "text", text: "Original diagnostic report" }], { details }), request);
	assert.deepEqual(project({ filesChecked: 2, outcomeCounts: { clean: 1, findings: 1, failed: 0 } }).targetCoverage,
		{ kind: "diagnostics", completedTargets: 2, attemptedTargets: 2 });
	assert.deepEqual(project({ filesChecked: 2, outcomeCounts: { clean: 0, findings: 1, failed: 1 } }).targetCoverage,
		{ kind: "diagnostics", completedTargets: 1, attemptedTargets: 2 });
	assert.deepEqual(project({ filesChecked: 1, outcomeCounts: { clean: 0, findings: 0, failed: 1 } }).targetCoverage,
		{ kind: "diagnostics", completedTargets: 0, attemptedTargets: 1 });
	for (const details of [{ filesChecked: 1 }, { filesChecked: 1, outcomeCounts: { clean: 1, findings: 1 } },
		{ filesChecked: 1, outcomeCounts: { clean: 0, findings: 0, failed: -1 } }]) {
		const view = project(details);
		assert.equal(view.targetCoverage, undefined);
		assert.deepEqual(view.parts, [{ kind: "original-content" }]);
	}
});

test("session input preserves its declared encoding and refuses conflicting forms", () => {
	const session = compileProjection(declaration({
		type: "object", required: ["session_id"],
		properties: {
			session_id: { type: "number", description: "Identifier of the running session." },
			chars: { type: "string", description: "C-style escapes sent to stdin." },
			chars_b64: { type: "string", description: "Raw bytes encoded as base64." },
			yield_time_ms: { type: "number", description: "Attachment wait in milliseconds." },
			yield_until: { type: "string", description: "Absolute RFC 3339 UTC deadline for an empty poll." },
		},
	}));
	assert.deepEqual(session.request({ session_id: 5, chars: "\\n" }), {
		kind: "session.send", sessionId: 5, input: { encoding: "c-escaped-utf8", text: "\\n" },
	});
	assert.deepEqual(session.request({ session_id: 5, chars_b64: "AA==" }), {
		kind: "session.send", sessionId: 5, input: { encoding: "base64", text: "AA==" },
	});
	assert.deepEqual(session.request({ session_id: 5, chars_b64: "  ", yield_until: "2026-07-21T18:30:00Z" }), {
		kind: "session.poll", sessionId: 5, wait: { untilUtc: "2026-07-21T18:30:00Z" },
	});
	assert.deepEqual(session.request({ session_id: 5, chars: "send", yield_until: "2026-07-21T18:30:00Z" }), { kind: "uninterpreted" });
});

test("JavaScript object schemas beat sampling metadata; TypeScript bindings remain literal", () => {
	const javascript = compileProjection(declaration({
		type: "object", required: ["code"], properties: { code: { type: "string", description: "Raw JavaScript source." } },
	}, { description: "Run JavaScript that calls tools.", sampling: { expression: "a transport grammar" } }));
	assert.deepEqual(javascript.request({ code: "// @options: {}\nprint(1)" }), {
		kind: "program.javascript", source: "// @options: {}\nprint(1)",
	});
	assert.deepEqual(javascript.request("print(1)"), { kind: "uninterpreted" });
	const inspected = declaration({ type: "object", required: ["code"], properties: { code: { type: "string", description: "Raw JavaScript source." } } },
		{ description: "Inspect JavaScript source without evaluating it." });
	assert.deepEqual(compileProjection(inspected).request({ code: "print(1)" }), { kind: "uninterpreted" });
	assert.deepEqual(compileProjection({ ...inspected, description: "Do not execute JavaScript; store the source." }).request({ code: "print(1)" }), { kind: "uninterpreted" });

	const typescript = compileProjection(declaration({
		type: "object", required: ["code"],
		properties: {
			code: { type: "string", description: "TypeScript code body." },
			strings: { type: "object", additionalProperties: { type: "string" }, description: "Named string constants." },
			resultFormat: { type: "string", enum: ["json", "text"] },
		},
	}, { description: "Execute TypeScript code that calls tools." }));
	assert.deepEqual(typescript.request({ code: "print(π.message)", strings: { message: "a\nb" }, resultFormat: "text" }), {
		kind: "program.typescript", source: "print(π.message)", strings: { message: "a\nb" },
	});
});

test("search dialects, excludes, and string queries preserve distinct meanings", () => {
	const fff = compileProjection(declaration({
		type: "object", required: ["searchTerm"],
		properties: {
			searchTerm: { type: "string", description: "Search pattern (literal text or regex)." },
			fileFilter: { type: "string", description: "Path constraint applied to the full repo-relative path." },
			exclude: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Exclude paths." },
			caseSensitive: { type: "boolean", description: "Force case-sensitive matching; otherwise smart-case." },
			context: { type: "number", description: "Context lines." },
		},
	}));
	assert.deepEqual(fff.request({ searchTerm: "foo", fileFilter: "src/", exclude: ["a,b", " test/"], caseSensitive: false, context: 2 }), {
		kind: "search.text", query: "foo", dialect: "auto", caseMode: "smart",
		scope: { pathExpression: "src/", exclude: { kind: "list", entries: ["a,b", " test/"] } }, contextLines: 2,
	});
	const declaredCaseMode = compileProjection(declaration({
		type: "object", required: ["pattern", "caseMode"], properties: {
			pattern: { type: "string", description: "Search pattern." },
			path: { type: "string", description: "Path constraint on repository paths." },
			caseMode: { type: "string", enum: ["sensitive", "insensitive", "smart"] },
		},
	}));
	assert.deepEqual(declaredCaseMode.request({ pattern: "foo", caseMode: "insensitive" }), {
		kind: "search.text", query: "foo", dialect: "auto", caseMode: "insensitive", scope: {},
	});
	const conflictingCaseModes = compileProjection(declaration({
		type: "object", properties: {
			pattern: { type: "string", description: "Search pattern." },
			path: { type: "string", description: "Path constraint on repository paths." },
			ignoreCase: { type: "boolean", description: "Case-insensitive matching." },
			caseSensitive: { type: "boolean", description: "Force case-sensitive matching." },
		},
	}));
	assert.deepEqual(conflictingCaseModes.request({ pattern: "foo", ignoreCase: true, caseSensitive: true }), { kind: "uninterpreted" });
	const web = compileProjection(declaration({
		type: "object",
		properties: {
			query: { type: "string", description: "Single search query." },
			queries: { type: "array", items: { type: "string" }, description: "Multiple queries searched concurrently." },
			urls: { type: "array", items: { type: "string" }, description: "Additional URLs to analyze." },
		},
	}));
	assert.deepEqual(web.request({ query: "[\"JSON\"]", queries: ["second", "first"], urls: ["https://a", "https://a"] }), {
		kind: "web.search", input: { kind: "both", query: "[\"JSON\"]", queries: ["second", "first"] },
		contextUrls: ["https://a", "https://a"],
	});
});

test("stored retrieval selectors retain both text and index without guessing opaque targets", () => {
	const stored = compileProjection(declaration({
		type: "object", required: ["responseId"],
		properties: {
			responseId: { type: "string", description: "Stored result reference." },
			query: { type: "string", description: "Select a search query." },
			queryIndex: { type: "integer", description: "Select a query by index." },
			url: { type: "string", description: "Select a URL." },
			urlIndex: { type: "integer", description: "Select a URL by index." },
			offset: { type: "number", description: "Character offset." },
			limit: { type: "number", description: "Maximum characters." },
			findText: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
			findMode: { type: "string", enum: ["exact", "case-insensitive", "fuzzy"] },
		},
	}));
	assert.deepEqual(stored.request({
		responseId: "opaque-id", query: "literal query", queryIndex: 2, url: "https://example.test", urlIndex: 1,
		findText: ["first", "second"], findMode: "fuzzy", offset: 99, limit: 5,
	}), {
		kind: "web.stored-find", responseId: "opaque-id",
		selectors: {
			query: { kind: "both", value: "literal query", index0: 2 },
			url: { kind: "both", value: "https://example.test", index0: 1 },
		}, needles: ["first", "second"], mode: "fuzzy",
	});
	assert.deepEqual(stored.request({ responseId: "opaque-id", findMode: "exact" }), { kind: "uninterpreted" });
	assert.deepEqual(stored.request({ responseId: "opaque-id", offset: 17, limit: 3 }), {
		kind: "web.stored-slice", responseId: "opaque-id", selectors: {}, offsetUtf16: 17, limitUtf16: 3,
	});
});

test("web fetch and claim contracts keep declared target and query alternatives", () => {
	const fetch = compileProjection(declaration({
		type: "object", properties: {
			url: { type: "string", description: "Single URL to fetch." },
			urls: { type: "array", items: { type: "string" }, description: "Multiple URLs (parallel)." },
			mode: { type: "string", enum: ["readable", "raw", "answer"] },
			prompt: { type: "string", description: "Question required by answer mode." },
		},
	}));
	assert.deepEqual(fetch.request({ url: "https://one.test", urls: ["https://two.test", "https://two.test"], mode: "raw" }), {
		kind: "web.fetch", targets: { kind: "both", url: "https://one.test", urls: ["https://two.test", "https://two.test"] }, mode: "raw",
	});

	const sourceCheck = compileProjection(declaration({
		type: "object", required: ["claim"], properties: {
			claim: { type: "string", description: "The assertion to gather web sources for." },
			queries: { type: "array", items: { type: "string" }, description: "Search queries for source verification." },
		},
	}));
	assert.deepEqual(sourceCheck.request({ claim: "claim text", queries: ["query"] }), {
		kind: "web.source-check", claim: "claim text", queries: ["query"],
	});
	assert.deepEqual(sourceCheck.request({ claim: "claim text", queries: "[\"query\"]" }), { kind: "uninterpreted" });

	const urlContext = compileProjection(declaration({
		type: "object", required: ["query", "urls"], properties: {
			query: { type: "string", description: "Question or task to perform on the URLs." },
			urls: { type: "array", items: { type: "string" }, description: "Public URLs to analyze." },
		},
	}));
	assert.deepEqual(urlContext.request({ query: "What changed?", urls: ["https://one.test"] }), {
		kind: "web.url-context", query: "What changed?", urls: ["https://one.test"],
	});
});

test("AST modes, one-based navigation positions, and action lookup preserve intent", () => {
	const ast = compileProjection(declaration({
		type: "object", required: ["lang"],
		properties: {
			dump: { type: "boolean" }, pattern: { type: "string", description: "AST pattern." },
			lang: { type: "string", enum: ["typescript", "python"] },
			paths: { type: "array", items: { type: "string" } },
			selector: { type: "string" }, rule: { type: "string" }, nodeKind: { type: "string" },
			insideKind: { type: "string" }, hasKind: { type: "string" }, hasDescendantKind: { type: "string" },
			follows: { type: "string" }, precedes: { type: "string" }, skip: { type: "number" }, maxMatches: { type: "number" },
			validateOnly: { type: "boolean" },
		},
	}));
	assert.deepEqual(ast.request({ lang: "typescript", dump: true, pattern: "const x = 1", paths: ["ignored.ts"] }), {
		kind: "code.ast-dump", language: "typescript", source: "const x = 1",
	});
	assert.deepEqual(ast.request({ lang: "typescript", validateOnly: true, rule: "id: rule" }), {
		kind: "code.ast-validate", language: "typescript", selector: { kind: "rule", rule: "id: rule" },
	});
	assert.deepEqual(ast.request({ lang: "typescript", pattern: "foo()", rule: "id: rule" }), { kind: "uninterpreted" });
	const rewrite = compileProjection(declaration({
		type: "object", required: ["lang", "pattern", "rewrite"], properties: {
			lang: { type: "string", enum: ["typescript", "python"] },
			pattern: { type: "string", description: "AST pattern to select." },
			rewrite: { type: "string", description: "Replacement source for matching nodes." },
			nodeKind: { type: "string", description: "Restrict to a node kind." },
			apply: { type: "boolean" },
		},
	}));
	assert.deepEqual(rewrite.request({ lang: "typescript", pattern: "foo()", rewrite: "bar()", nodeKind: "call_expression", apply: true }), {
		kind: "change.structural", language: "typescript", pattern: "foo()", rewrite: "bar()",
		constraints: { nodeKind: "call_expression" }, intent: "apply",
	});

	const lsp = compileProjection(declaration({
		type: "object", required: ["operation"],
		properties: {
			operation: { type: "string", description: "LSP operation to perform." },
			path: { type: "string", description: "Target file path." },
			line: { type: "number", description: "1-based line number." },
			character: { type: "number", description: "1-based character offset." },
			symbol: { type: "string", description: "Symbol for automatic character resolution." },
			endLine: { type: "number" }, endCharacter: { type: "number" },
			newName: { type: "string" }, newFilePath: { type: "string" }, apply: { type: "boolean" },
			command: { type: "string" }, commandArguments: { type: "array", items: {} }, query: { type: "string" },
			callHierarchyItem: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
		},
	}));
	assert.deepEqual(lsp.request({ operation: "hover", path: "src/a.ts", line: 7, character: 0, symbol: "work", endCharacter: 9 }), {
		kind: "code.navigation", operation: "hover", target: {
			path: "src/a.ts", line1: 7, anchor: { kind: "symbol-on-line", symbol: "work" }, end: { character1: 9 },
		},
	});
	assert.deepEqual(lsp.request({ operation: "codeAction", path: "src/a.ts", apply: true }), { kind: "uninterpreted" });
	assert.deepEqual(lsp.request({ operation: "codeAction", path: "src/a.ts", line: 1, apply: true }), {
		kind: "code.actions", target: { path: "src/a.ts", line1: 1, anchor: { kind: "line-start" } },
	});
	assert.deepEqual(lsp.request({ operation: "rename_file", path: "src/old.ts", newFilePath: "src/new.ts", apply: true }), {
		kind: "change.rename-file", path: "src/old.ts", newPath: "src/new.ts", intent: "apply",
	});
	assert.deepEqual(lsp.request({ operation: "incomingCalls", callHierarchyItem: { name: "f" } }), {
		kind: "code.hierarchy", operation: "incomingCalls", target: { kind: "provided-item", item: { name: "f" } },
	});
	assert.deepEqual(lsp.request({ operation: "executeCommand", command: "server.command", commandArguments: [1, "two"] }), {
		kind: "code.command", command: "server.command", arguments: [1, "two"], intent: "preview",
	});

	const diagnostics = compileProjection(declaration({
		type: "object", properties: {
			source: { type: "string", enum: ["session", "lsp"] },
			scope: { type: "string", enum: ["paths", "workspace"] },
			mode: { type: "string", enum: ["delta", "all", "full"] },
			paths: { type: "array", items: { type: "string" } },
			path: { type: "string" },
		},
	}));
	assert.deepEqual(diagnostics.request({}), { kind: "code.diagnostics" });
	assert.deepEqual(diagnostics.request({ source: "lsp", scope: "paths", mode: "full", paths: "src/a.ts" }), {
		kind: "code.diagnostics", source: "lsp", scope: "paths", mode: "full", paths: ["src/a.ts"],
	});
});

test("source selectors and bounded code-report operations remain distinct", () => {
	const symbol = compileProjection(declaration({
		type: "object", required: ["path", "symbol"], properties: {
			path: { type: "string", description: "Absolute or workspace-relative path to the source file." },
			symbol: { type: "string", description: "Exact symbol name or callback handle to read." },
		},
	}));
	assert.deepEqual(symbol.request({ path: "src/a.ts", symbol: "render" }), { kind: "source.symbol", path: "src/a.ts", symbol: "render" });

	const enclosing = compileProjection(declaration({
		type: "object", required: ["path", "line"], properties: {
			path: { type: "string", description: "Path to the source file." },
			line: { type: "number", description: "1-based line number inside the desired symbol." },
			maxLines: { type: "number", description: "Optional maximum body size to return." },
		},
	}));
	assert.deepEqual(enclosing.request({ path: "src/a.ts", line: 23, maxLines: 80 }), {
		kind: "source.enclosing", path: "src/a.ts", line1: 23, maxLines: 80,
	});

	const moduleReport = compileProjection(declaration({
		type: "object", required: ["path"], properties: {
			path: { type: "string", description: "Source file, e.g. src/app.ts." },
			maxRefsPerSymbol: { type: "number", description: "Cap on who-uses-this entries per symbol." },
			blastRadius: { type: "boolean", description: "Include the cross-file blast-radius section." },
		},
	}));
	assert.deepEqual(moduleReport.request({ path: "src/app.ts", maxRefsPerSymbol: 5, blastRadius: true }), {
		kind: "code.module-report", path: "src/app.ts",
	});
	const projectReport = compileProjection(declaration({
		type: "object", properties: {
			limit: { type: "number", description: "Scales every ranked section's cap." },
			focus: { type: "string", description: "Task hint used only to rank recommended reads." },
		},
	}));
	assert.deepEqual(projectReport.request({ limit: 4, focus: "test failures" }), { kind: "code.project-report" });
});

test("image references and compound web actions preserve requested inputs", () => {
	const imageView = compileProjection(declaration({
		type: "object", required: ["path"], properties: { path: { type: "string" } },
	}, { description: "View an image from the supplied path." }));
	assert.deepEqual(imageView.request({ path: "image.png" }), { kind: "image.view", path: "image.png" });
	assert.deepEqual(compileProjection(declaration({
		type: "object", properties: { path: { type: "string" } },
	})).request({ path: "unknown" }), { kind: "uninterpreted" });
	const mixedImage = compileProjection(declaration({
		type: "object", properties: {
			path: { type: "string", description: "Path to the local image file to view." },
			prompt: { type: "string", description: "Prompt for image synthesis." },
		referenced_image_paths: { type: "array", items: { type: "string" } },
		},
	}));
	assert.deepEqual(mixedImage.request({ path: "image.png", prompt: "edit", referenced_image_paths: ["other.png"] }), { kind: "uninterpreted" });

	const image = compileProjection(declaration({
		type: "object", properties: {
			prompt: { type: "string", description: "Include the requested prompt." },
			referenced_image_paths: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
			num_last_images_to_include: { anyOf: [{ type: "integer" }, { type: "null" }] },
			quality: { type: "string", enum: ["high", "low"] },
		},
	}));
	assert.deepEqual(image.request({ prompt: "edit", referenced_image_paths: ["a.png", "b.png"], num_last_images_to_include: 3, quality: "high" }), {
		kind: "image.synthesize", prompt: "edit",
		referenceRequests: [{ kind: "path", path: "a.png" }, { kind: "path", path: "b.png" }, { kind: "recent", count: 3 }],
	});

	const item = (properties: Schema, required: string[] = []): Schema => ({ type: "object", properties, required });
	const compound = compileProjection(declaration({
		type: "object", properties: {
			search_query: { type: "array", items: item({ q: stringField("query", true), domains: { type: "array", items: { type: "string" } } }, ["q"]) },
			image_query: { type: "array", items: item({ q: stringField("query", true) }, ["q"]) },
			open: { type: "array", items: item({ ref_id: stringField("reference", true), lineno: { type: "number" } }, ["ref_id"]) },
			click: { type: "array", items: item({ ref_id: stringField("reference", true), id: { type: "number" } }, ["ref_id", "id"]) },
			find: { type: "array", items: item({ ref_id: stringField("reference", true), pattern: stringField("pattern", true) }, ["ref_id", "pattern"]) },
			finance: { type: "array", items: item({ ticker: stringField("ticker", true) }, ["ticker"]) },
		},
	}));
	assert.deepEqual(compound.request({
		search_query: [{ q: "first", domains: ["example.test"] }],
		open: { ref_id: "result:2", lineno: 4 },
		finance: [{ ticker: "ABC" }],
	}), {
		kind: "web.compound", actions: [
			{ kind: "search", query: "first", domains: ["example.test"] },
			{ kind: "open", reference: "result:2", line: 4 },
			{ kind: "lookup", section: "finance", suppliedArguments: { ticker: "ABC" } },
		],
	});
});

test("search text decoding retains ambiguous material and coalesces equal overlapping context", () => {
	const search = compileProjection(declaration({
		type: "object", required: ["pattern"], properties: {
			pattern: { type: "string", description: "Search pattern (literal text or regex)." },
			path: { type: "string", description: "Path constraint on repository paths." },
			caseSensitive: { type: "boolean", description: "Force case-sensitive matching." },
		},
	}));
	const text = "src/a.ts-2-before\nsrc/a.ts:3:match\nsrc/a.ts-2-before";
	assert.deepEqual(search.result(result([{ kind: "text", text }])).parts, [{
		kind: "file-matches", groups: [{ path: "src/a.ts", rows: [
			{ kind: "line", text: "before", line1: 2, role: "context" },
			{ kind: "line", text: "match", line1: 3, role: "match" },
		] }],
	}]);
	for (const ambiguous of [
		"Error: Unable to read file:5: fake row",
		"src/a.ts:1:text:2:ambiguous",
		"version-1-file.ts:2:match",
		"notice without a numbered source row",
	]) {
		assert.deepEqual(search.result(result([{ kind: "text", text: ambiguous }])), { parts: [{ kind: "original-content" }] });
	}
	const capture = search.result(result([{ kind: "text", text: "src/a.ts:3:match" }], {
		details: { output: "src/a.ts:3:match", truncated: true, full_output_path: "/tmp/full-search-output" },
	}));
	assert.deepEqual(capture.contentCapture, { producerTruncated: true, fullOutputPath: "/tmp/full-search-output" });
});

test("mixed search output keeps parsed rows and exact unclassified text in original content order", () => {
	const search = compileProjection(declaration({ type: "object", required: ["pattern"], properties: {
		pattern: { type: "string", description: "Search pattern (literal text or regex)." },
		path: { type: "string", description: "Path constraint on repository paths." },
		caseSensitive: { type: "boolean", description: "Force case-sensitive matching." },
	} }));
	const residue = "\r\n[4 matches limit reached. Use limit=8 for more, or refine pattern]\r\n"
		+ "src/a.ts:1:text:2:ambiguous\r\nsrc/a.ts:9:(unable to read file)\r\n";
	const supplied = result([
		{ kind: "text", text: "before the matches" },
		{ kind: "text", text: `src/a.ts:3:match\r\nsrc/a.ts-4-context\r\n${residue}src/b.ts:8:next match` },
		{ kind: "image", data: "image-data", mimeType: "image/test" },
		{ kind: "text", text: "after the matches" },
	]);
	const before = structuredClone(supplied);
	assert.deepEqual(search.result(supplied).parts, [
		{ kind: "original-content", indexes: [0] },
		{ kind: "file-matches", groups: [{ path: "src/a.ts", rows: [
			{ kind: "line", text: "match", line1: 3, role: "match" },
			{ kind: "line", text: "context", line1: 4, role: "context" },
		] }] },
		{ kind: "text", text: residue },
		{ kind: "file-matches", groups: [{ path: "src/b.ts", rows: [
			{ kind: "line", text: "next match", line1: 8, role: "match" },
		] }] },
		{ kind: "original-content", indexes: [2] },
		{ kind: "original-content", indexes: [3] },
	]);
	assert.deepEqual(supplied, before, "partitioning does not mutate or replace the producer's source blocks");
	assert.deepEqual(search.result({ ...supplied, isError: true }).parts, [{ kind: "original-content" }]);
});

test("fetch coverage is a coherent reported result fact rather than inferred from requested URL counts", () => {
	const fetch = compileProjection(declaration({ type: "object", properties: {
		url: { type: "string", description: "Single URL to fetch." },
		urls: { type: "array", items: { type: "string" }, description: "Multiple URLs (parallel)." },
	} }));
	const content = [{ kind: "text" as const, text: "Fetched one resource; another returned HTTP 404." }];
	assert.deepEqual(fetch.result(result(content, { details: { successful: 1, urlCount: 2 } })).targetCoverage,
		{ kind: "fetch", completedTargets: 1, attemptedTargets: 2 });
	assert.deepEqual(fetch.result(result(content, {
		details: { successful: 1, urlCount: 2 }, structuredContent: { successful: 1, urlCount: 2 },
	})).targetCoverage, { kind: "fetch", completedTargets: 1, attemptedTargets: 2 });
	assert.equal(fetch.result(result(content, {
		details: { successful: 1, urlCount: 2 }, structuredContent: { successful: 2, urlCount: 2 },
	})).targetCoverage, undefined);
	for (const details of [{ successful: 1 }, { urlCount: 2 }, { successful: 3, urlCount: 2 },
		{ successful: -1, urlCount: 2 }, { successful: 0.5, urlCount: 2 }, { successful: true, urlCount: 2 }]) {
		const projected = fetch.result(result(content, { details }), fetch.request({ urls: ["https://a.test", "https://b.test"] }));
		assert.equal(projected.targetCoverage, undefined);
		assert.deepEqual(projected.parts, [{ kind: "original-content" }]);
	}
	assert.deepEqual(fetch.result(result(content, { details: { successful: 0, urlCount: 0 } })).targetCoverage,
		{ kind: "fetch", completedTargets: 0, attemptedTargets: 0 });
	const search = compileProjection(declaration({ type: "object", required: ["query"], properties: {
		query: { type: "string", description: "Single search query." },
	} }));
	assert.equal(search.result(result(content, { details: { successful: 1, urlCount: 2 } })).targetCoverage, undefined);
});

test("only a matching freeform grammar accepts raw source text", () => {
	const freeform = compileProjection({
		description: "Run raw JavaScript source.",
		input: { kind: "freeform", grammar: {
			syntax: "lark",
			definition: "start: options_source | plain_source\noptions_source: OPTIONS_LINE NEWLINE SOURCE\nplain_source: SOURCE\nOPTIONS_LINE: /\\/\\/ @options/",
		} },
	});
	assert.deepEqual(freeform.request("print(1)"), { kind: "program.javascript", source: "print(1)" });
	assert.deepEqual(freeform.request({ code: "print(1)" }), { kind: "uninterpreted" });
	const unknownLanguage = compileProjection({ description: "Source program.", input: { kind: "freeform", grammar: {
		syntax: "lark", definition: "start: options_source | plain_source\nSOURCE: /.+/\nOPTIONS_LINE: /@options/",
	} } });
	assert.deepEqual(unknownLanguage.request("print(1)"), { kind: "uninterpreted" });
});
