import assert from "node:assert/strict";
import test from "node:test";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { effectiveDeclaration } from "../../src/host/result.ts";
import { compileProjection } from "../../src/projection/index.ts";

test("actual Pi declarations retain native core behavior without executing a tool", () => {
  const cases = [
    [createReadToolDefinition("/fixture"), { path: "code.ts", offset: 2 }, "source.lines"],
    [createWriteToolDefinition("/fixture"), { path: "code.ts", content: "content" }, "change.write"],
    [createEditToolDefinition("/fixture"), { path: "code.ts", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) }, "change.replacements"],
    [createBashToolDefinition("/fixture"), { command: "never executed", timeout: 2 }, "shell.launch"],
    [createFindToolDefinition("/fixture"), { pattern: "*.ts", path: "." }, "search.files"],
    [createGrepToolDefinition("/fixture"), { pattern: "match", path: "." }, "search.text"],
    [createLsToolDefinition("/fixture"), { path: "." }, "search.list"],
  ] as const;
  for (const [tool, args, kind] of cases) {
    const projection = compileProjection(effectiveDeclaration(tool));
    assert.equal(projection.request(args).kind, kind);
  }
});

test("native read retains source evidence after historical outputSchema omission and refuses errors", () => {
  const { description, parameters } = createReadToolDefinition("/fixture");
  const projection = compileProjection(effectiveDeclaration({ description, parameters }));
  assert.deepEqual(projection.result({ content: [{ kind: "text", text: "const x = 1;\n" }], isError: false }).parts,
    [{ kind: "source", source: { text: "const x = 1;\n" } }]);
  assert.deepEqual(projection.result({ content: [{ kind: "text", text: "error reading" }], isError: true }).parts,
    [{ kind: "original-content" }]);
  const truncated = projection.result({ content: [{ kind: "text", text: "code\n\n[Showing lines 1-1 of 4.]" }],
    details: { truncation: { content: "code", truncated: true, totalBytes: 40, outputBytes: 4 } }, isError: false });
  assert.equal(truncated.parts[0]?.kind, "source");
  assert.equal(truncated.parts[1]?.kind, "notice");
  assert.equal(truncated.contentCapture?.producerTruncated, true);
});

test("file lists never become source match rows; process reports do not infer exit from dispatch completion", () => {
  const files = compileProjection(effectiveDeclaration(createFindToolDefinition("/fixture")));
  const content = [{ kind: "text" as const, text: "file:123:could-be-a-file-name" }];
  assert.deepEqual(files.result({ content, isError: false }).parts, [{ kind: "original-content" }]);
  const shell = compileProjection(effectiveDeclaration(createBashToolDefinition("/fixture")));
  assert.equal(shell.result({ content: [], details: { running: false }, isError: false }).process, undefined);
  assert.equal(shell.result({ content: [], details: { running: true, exit_code: 0 }, isError: false }).process, undefined);
  assert.deepEqual(shell.result({ content: [], details: { output: "running", session_id: 7, exit_code: null }, isError: false }).process,
    { state: "active", sessionId: 7 });
  assert.equal(shell.result({ content: [{ kind: "text", text: "tail" }], details: {
    truncation: { truncated: true, totalBytes: 60, outputBytes: 4 }, fullOutputPath: "full.log",
  }, isError: false }).contentCapture?.fullOutputPath, "full.log");
});

test("one changed file does not turn a call-level partial result into a file outcome", () => {
  const edit = compileProjection(effectiveDeclaration(createEditToolDefinition("/fixture")));
  const result = edit.result({ content: [{ kind: "text", text: "partial result" }], isError: false,
    details: { updatedFiles: ["changed.ts"], partialFailure: true } });
  const changes = result.parts.find(part => part.kind === "changes");
  assert.deepEqual(changes?.kind === "changes" ? changes.application : undefined,
    { scope: { kind: "call" }, outcome: "reported-partial" });
});
