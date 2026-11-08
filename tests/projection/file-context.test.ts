import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { compileProjection } from "../../src/projection/index.ts";
import { normalizeFileContext, fileReference } from "../../src/projection/file-context.ts";
import { CallPreparations } from "../../src/host/prepared.ts";
import { prepareFiles } from "../../src/host/file-targets.ts";
import { buildDiffPresentation } from "../../src/diff/compose.ts";
import type { EffectiveDeclaration, Json } from "../../src/presentation.ts";

const directory = resolve("/fixture/project");
const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";

test("schema roles bind relative and absolute paths without provider names", () => {
  for (const key of ["cwd", "workdir", "folderForThisOperation"]) {
    const declaration: EffectiveDeclaration = { description: "Patch files.", input: { kind: "json", schema: {
      type: "object", required: ["input"], properties: { input: { type: "string", description: "Patch text; paths are relative to the working directory." },
        [key]: { type: "string", description: "Working directory for this file operation" } },
    } } };
    const preparations = new CallPreparations({ compile: compileProjection, compare: buildDiffPresentation });
    const prepared = preparations.prepare(declaration, { input: patch, [key]: "packages/app" });
    assert.equal(prepared.request.kind, "change.patch");
    const files = prepareFiles(prepared, directory);
    assert.deepEqual(files.targets[0]?.before, { kind: "local", absolutePath: resolve(directory, "packages/app/src/a.ts") });
    assert.equal(prepared.args && typeof prepared.args === "object" && !Array.isArray(prepared.args) && key in prepared.args, true);
  }
  assert.deepEqual(fileReference("src/a.ts", directory), { kind: "local", absolutePath: resolve(directory, "src/a.ts") });
  const absolute = resolve("/other/a.ts");
  assert.deepEqual(fileReference(absolute, directory, { kind: "directory", path: "sub" }), { kind: "local", absolutePath: absolute });
});

test("external and conflicting contexts do not fall through to a local absolute path", () => {
  const schema = { type: "object", properties: { cwd: { type: "string" }, workdir: { type: "string" },
    backend: { type: "string", description: "Execution environment" } } };
  for (const args of [{ cwd: "a", workdir: "b" }, { cwd: 123 }, { backend: false }]) {
    assert.deepEqual(normalizeFileContext(schema, args), { kind: "unresolved" });
  }
  const external = normalizeFileContext(schema, { backend: "remote", cwd: "/remote" })!;
  assert.deepEqual(fileReference(resolve("/absolute.ts"), directory, external), { kind: "external", reference: "remote" });
  assert.equal(fileReference("ssh://machine/a.ts", directory).kind, "external");
  assert.equal(fileReference("a.ts", directory, normalizeFileContext(schema, { cwd: "ssh://machine/root" })).kind, "external");
  assert.equal(normalizeFileContext(undefined, {}, "Apply changes inside a remote workspace.")?.kind, "external");
  assert.deepEqual(normalizeFileContext({ type: "object", properties: { remote_host: { type: "string" } } }, { remote_host: "host" }),
    { kind: "external", reference: "host" });
  assert.equal(normalizeFileContext({ type: "object", properties: { cwd: { type: "string", description: "Source file path" } } }, { cwd: "a.ts" }), undefined);
  assert.equal(normalizeFileContext({ type: "object", properties: { cwd: { type: ["string", "null"] } } }, { cwd: null }), undefined);
  assert.deepEqual(normalizeFileContext({ type: "object", properties: { cwd: { type: "string" } } }, { cwd: null }), { kind: "unresolved" });
});

test("target context overrides call context while ordinary path spelling stays literal", () => {
  const declaration: EffectiveDeclaration = { description: "Apply replacement edits.", input: { kind: "json", schema: {
    type: "object", required: ["path", "edits"], properties: { path: { type: "string", description: "Path to the source file, relative to the working directory." }, cwd: { type: "string" }, edits: {
      type: "array", description: "Replacement edits", items: { type: "object", required: ["oldText", "newText"], properties: {
        oldText: { type: "string" }, newText: { type: "string" }, path: { type: "string" }, root: { type: "string", description: "Base directory" },
      } },
    } },
  } } };
  const input = { path: "a.ts", cwd: "packages", edits: [{ oldText: "a", newText: "b", root: "one" }, { oldText: "c", newText: "d", root: "two" }] };
  const before = structuredClone(input);
  const prepared = new CallPreparations({ compile: compileProjection, compare: buildDiffPresentation }).prepare(declaration, input);
  const files = prepareFiles(prepared, directory);
  assert.deepEqual(files.targets.map(target => target.before), ["one", "two"].map(name => ({ kind: "local", absolutePath: resolve(directory, "packages", name, "a.ts") })));
  assert.deepEqual(input, before);
  assert.deepEqual(fileReference("'@name.ts'", directory), { kind: "local", absolutePath: resolve(directory, "'@name.ts'") });
});

test("patch decoding is shared with semantic composition and does not change the request", () => {
  const declaration: EffectiveDeclaration = { description: "Patch files.", input: { kind: "json", schema: { type: "object", required: ["input"],
    properties: { input: { type: "string", description: "Patch text" } } } } };
  const prepared = new CallPreparations({ compile: compileProjection, compare: buildDiffPresentation }).prepare(declaration, { input: patch });
  const request = structuredClone(prepared.request);
  const ordinary = buildDiffPresentation(prepared.request, undefined);
  const reused = buildDiffPresentation(prepared.request, undefined, { prepared: prepared.changes! });
  assert.deepEqual(reused, ordinary);
  assert.deepEqual(prepared.request, request);
  assert.equal(prepareFiles(prepared, directory).targets.length, 1);
});
