import assert from "node:assert/strict";
import test from "node:test";
import { compileResult } from "../../src/projection/result.ts";
import { searchContinuation } from "../../src/projection/search-text.ts";
import type { EffectiveDeclaration, RequestView, ResultPart, SuppliedToolResult } from "../../src/presentation.ts";
import { codeEnvelope, resultMetadata } from "../../src/projection/result-metadata.ts";

const declaration: EffectiveDeclaration = { description: "Code report", input: { kind: "json", schema: { type: "object", properties: {} } } };
const decode = compileResult("code", declaration);
const report: RequestView = { kind: "code.project-report" };
const footer = (body: string, status = "ok", diagnostics = "", truncated = false) =>
  `${body}\n\nresult ${status}\n${diagnostics}usage tokens=17 elapsed-ms=0 bytes=${new TextEncoder().encode(body).length} truncated=${truncated}`;
const supplied = (text: string): SuppliedToolResult => ({ isError: false, content: [{ kind: "text", text }] });
const controls = (parts: readonly ResultPart[]) => parts.filter(part => part.kind === "text" && part.role !== undefined);

test("code-report metadata is a separate normalized role and never mutates the supplied result", () => {
  const input = supplied(footer("TRUST: report é🙂\n  actual data")), original = structuredClone(input);
  const view = decode(input, report);
  assert.deepEqual(view.parts[0], { kind: "text", text: "TRUST: report é🙂\n  actual data" });
  assert.deepEqual(controls(view.parts).map(part => part.kind === "text" ? part.role : undefined), ["receipt", "usage"]);
  assert.deepEqual(input, original);
});

test("truncation and producer errors survive metadata classification without changing call status", () => {
  const input = supplied(footer("actual error details", "error", "diag severity=warning message=retained\n", true));
  const view = decode(input, report);
  assert.ok(view.parts.some(part => part.kind === "notice" && part.severity === "error" && part.text === "result error"));
  assert.ok(view.parts.some(part => part.kind === "notice" && part.severity === "warning" && part.text.includes("retained")));
  assert.ok(view.parts.some(part => part.kind === "coverage" && part.reason === "truncated"));
  assert.equal(input.isError, false);
});

test("a footer-looking file, shell or executed program output stays ordinary content", () => {
  const text = footer("real source or stdout");
  for (const request of [{ kind: "source.lines", path: "a.ts" }, { kind: "shell.launch", command: "print" },
    { kind: "program.javascript", source: "print()" }] satisfies RequestView[]) {
    assert.deepEqual(decode(supplied(text), request).parts, [{ kind: "original-content" }]);
  }
  const native: EffectiveDeclaration = { description: "Read the contents of a file", input: { kind: "json", schema: {
    type: "object", properties: { path: { type: "string", description: "Path to the file to read" } },
  } } };
  const view = compileResult("source", native)(supplied(text), { kind: "source.lines", path: "a.ts" });
  assert.equal(view.parts[0]?.kind === "source" ? view.parts[0].source.text : undefined, text);
});

test("unknown and inconsistent wrappers remain intact, including mixed warnings", () => {
  const body = "é🙂";
  for (const text of [footer(body).replace(`bytes=${new TextEncoder().encode(body).length}`, `bytes=${body.length}`),
    footer(body) + "\nWarning: actual finding", footer(body).replace("elapsed-ms=0", "elapsed-ms=unknown")]) {
    assert.deepEqual(decode(supplied(text), report).parts, [{ kind: "original-content" }]);
  }
  const nested = footer("literal inner footer") + "\nactual body tail";
  assert.deepEqual(decode(supplied(footer(nested)), report).parts[0], { kind: "text", text: nested });
});

test("search caps and truncation normalize without claiming that additional matches must exist", () => {
  const limit = "\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]";
  assert.deepEqual(searchContinuation(limit, { matchLimitReached: 2 }), { kind: "coverage", reason: "limit", producerText: limit });
  const combined = "\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]";
  assert.equal(searchContinuation(combined, { matchLimitReached: 2, linesTruncated: true }).kind, "coverage");
  assert.deepEqual(searchContinuation(limit + "\nWarning: failed file", { matchLimitReached: 2 }), { kind: "text", text: limit + "\nWarning: failed file" });
  assert.deepEqual(searchContinuation(limit, { matchLimitReached: 3 }), { kind: "text", text: limit });
});

test("native read truncation classifies only a corroborated continuation and retains mixed warnings", () => {
  const native: EffectiveDeclaration = { description: "Read the contents of a file", input: { kind: "json", schema: {
    type: "object", properties: { path: { type: "string", description: "Path to the file to read" } },
  } } };
  const source = compileResult("source", native), body = "a\nb";
  const note = "\n\n[Showing lines 5-6 of 99 (50KB limit). Use offset=7 to continue.]";
  const request: RequestView = { kind: "source.lines", path: "a.ts", firstLine1: 5, lineLimit: 2 };
  const result = { ...supplied(body + note), details: { truncation: { content: body, truncated: true } } };
  assert.deepEqual(source(result, request).parts[1], { kind: "coverage", reason: "truncated", producerText: note });
  const mixed = source({ ...result, content: [{ kind: "text", text: body + note + "\nWarning: do not discard" }] }, request);
  assert.ok(mixed.parts.some(part => part.kind === "notice" && part.text.includes("Warning: do not discard")));
});

test("patch completion normalization preserves changed-file counts and warning text", () => {
  const patch = compileResult("patch", declaration);
  const request: RequestView = { kind: "change.patch", text: "*** Begin Patch\n*** End Patch", format: "codex" };
  const text = "Applied patch successfully\nChanged files: 1\nWarning: retain this";
  const result = { ...supplied(text), details: { status: "success", result: { changedFiles: ["a.ts"] } } };
  const view = patch(result, request);
  assert.ok(view.parts.some(part => part.kind === "text" && part.role === "receipt"));
  assert.ok(view.parts.some(part => part.kind === "text" && !part.role && part.text.includes("Changed files: 1\nWarning: retain this")));
  const failed = patch({ ...result, isError: true }, request);
  assert.ok(failed.parts.some(part => part.kind === "original-content"));
  assert.ok(!controls(failed.parts).some(part => part.kind === "text" && part.role === "receipt"));
});

test("multi-block envelopes preserve non-text blocks and earlier source material", () => {
  const body = "first é\nsecond";
  const tail = footer(body).slice("first é\n".length);
  const result: SuppliedToolResult = { isError: false, content: [
    { kind: "text", text: "first é" }, { kind: "image", data: "retained", mimeType: "image/png" }, { kind: "text", text: tail },
  ] };
  const original = structuredClone(result), view = decode(result, report);
  assert.ok(view.parts.some(part => part.kind === "original-content" && part.indexes?.includes(0)));
  assert.ok(view.parts.some(part => part.kind === "original-content" && part.indexes?.includes(1)));
  assert.ok(view.parts.some(part => part.kind === "text" && part.text === "second"));
  assert.deepEqual(result, original);
});

function repeatedFooterBody(prefix: string): string {
  let bytes = 0;
  for (;;) {
    const body = `${prefix}\n\nresult ok\nusage tokens=17 elapsed-ms=0 bytes=${bytes} truncated=false`;
    const actual = new TextEncoder().encode(body).length;
    if (actual === bytes) return body;
    bytes = actual;
  }
}

test("a declared raw-source string owns its entire metadata-shaped payload", () => {
  const text = footer("literal");
  const view = compileResult("source", { ...declaration, outputSchema: { type: "string" } })(supplied(text), {
    kind: "source.symbol", path: "a.txt", symbol: "f",
  });
  const actual = view.parts.find(part => part.kind === "source");
  assert.equal(actual?.kind === "source" ? actual.source.text : undefined, text);
  assert.equal(controls(view.parts).length, 0);
});

test("metadata-shaped text inside a corroborated source body is not reinterpreted", () => {
  const header = "function f  a.txt:1-4\n\n";
  const body = repeatedFooterBody(header + "literal"), source = body.slice(header.length);
  const input: SuppliedToolResult = { ...supplied(footer(body)), details: { found: true, startLine: 1, endLine: 4, name: "f", kind: "function" } };
  const view = compileResult("source", declaration)(input, { kind: "source.symbol", path: "a.txt", symbol: "f" });
  const actual = view.parts.find(part => part.kind === "source");
  assert.equal(actual?.kind === "source" ? actual.source.text : undefined, source);
});

test("only the retained outer suffix is classified, not an identical ordinary body fragment", () => {
  const body = repeatedFooterBody("literal"), input = supplied(footer(body)), envelope = codeEnvelope(input, report);
  assert.ok(envelope);
  const view = resultMetadata({ parts: [{ kind: "text", text: body }, { kind: "text", text: envelope.suffix }] }, input, envelope);
  assert.deepEqual(view.parts[0], { kind: "text", text: body });
  assert.equal(controls(view.parts).length, 2);
  const trailing = decode(supplied(footer("body") + "\n"), report);
  assert.equal(controls(trailing.parts).length, 2);
});
