import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileObservations, observationLimits } from "../../src/host/file-observations.ts";
import type { PreparedFiles } from "../../src/host/file-targets.ts";

function files(directory: string, paths = ["a.ts"], signature = "request"): PreparedFiles {
  return { directory, signature, request: { kind: "uninterpreted" }, targets: paths.map((path, operationIndex) => ({ operationIndex, path,
    before: { kind: "local", absolutePath: join(directory, path) }, after: { kind: "local", absolutePath: join(directory, path) } })) };
}

async function fixture(run: (directory: string, store: FileObservations) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "tool-views-observation-"));
  const store = new FileObservations({ ...observationLimits, phaseMs: 5000 });
  try { await run(directory, store); } finally { store.reset(); await rm(directory, { recursive: true, force: true }); }
}

test("phase reads are idempotent and preserve literal UTF-8, BOM and empty files", async () => fixture(async (directory, store) => {
  const path = join(directory, "a.ts");
  const prepared = files(directory);
  await writeFile(path, "\uFEFFbefore🙂\r\n");
  await store.preflight("one", prepared);
  await writeFile(path, "not the preflight observation\n");
  await store.preflight("one", prepared);
  await writeFile(path, "");
  await store.executed("one", prepared);
  store.finish("one");
  const captured = store.take("one", prepared)!;
  assert.equal(captured.before.get(path)?.text, "\uFEFFbefore🙂\r\n");
  assert.equal(captured.after.get(path)?.text, "");
  captured.release();
  assert.equal(store.take("one", prepared), undefined);
}));

test("blocked, rewritten and replaced invocations cannot reuse the old preflight", async () => fixture(async (directory, store) => {
  await writeFile(join(directory, "a.ts"), "old\n");
  await writeFile(join(directory, "b.ts"), "rewritten\n");
  const original = files(directory), rewritten = files(directory, ["b.ts"], "rewritten");
  await store.preflight("blocked", original);
  store.finish("blocked");
  assert.equal(store.take("blocked", original), undefined);
  await store.preflight("rewritten", original);
  await store.executed("rewritten", rewritten);
  store.finish("rewritten");
  const captured = store.take("rewritten", rewritten)!;
  assert.equal(captured.before.size, 0);
  assert.equal(captured.after.get(join(directory, "b.ts"))?.text, "rewritten\n");
  captured.release();
  await store.preflight("stale", original);
  await store.executed("stale", original);
  store.finish("stale");
  assert.equal(store.take("stale", rewritten), undefined);
}));

test("moves read the original file before execution and the explicit destination afterwards", async () => fixture(async (directory, store) => {
  const before = join(directory, "a.ts"), after = join(directory, "moved.ts");
  await writeFile(before, "original\n");
  const prepared: PreparedFiles = { ...files(directory), targets: [{ operationIndex: 0, path: "a.ts", moveTo: "moved.ts",
    before: { kind: "local", absolutePath: before }, after: { kind: "local", absolutePath: after } }] };
  await store.preflight("move", prepared);
  await rename(before, after);
  await writeFile(after, "moved and updated\n");
  await store.executed("move", prepared);
  store.finish("move");
  const captured = store.take("move", prepared)!;
  assert.equal(captured.before.get(before)?.text, "original\n");
  assert.equal(captured.after.get(after)?.text, "moved and updated\n");
  assert.equal(captured.after.has(before), false);
  captured.release();
}));

test("known overlapping writers, including aliases, retain ordinary views", async () => fixture(async (directory, store) => {
  await writeFile(join(directory, "a.ts"), "old\n");
  await symlink(join(directory, "a.ts"), join(directory, "alias.ts"));
  await link(join(directory, "a.ts"), join(directory, "hardlink.ts"));
  const first = files(directory), alias = files(directory, ["alias.ts"]);
  await store.preflight("one", first);
  await store.preflight("two", alias);
  await store.executed("one", first);
  await store.executed("two", alias);
  store.finish("one"); store.finish("two");
  assert.equal(store.take("one", first), undefined);
  assert.equal(store.take("two", alias), undefined);
  const sameCall = files(directory, ["a.ts", "alias.ts", "hardlink.ts"]);
  await store.preflight("aliases", sameCall);
  await store.executed("aliases", sameCall);
  store.finish("aliases");
  const captured = store.take("aliases", sameCall)!;
  assert.equal(captured.before.get(join(directory, "hardlink.ts"))?.text, "old\n");
  assert.equal(captured.after.get(join(directory, "alias.ts"))?.text, "old\n");
  captured.release();
}));

test("a retargeted writer invalidates an overlapping capture that already finished", async () => fixture(async (directory, store) => {
  await writeFile(join(directory, "a.ts"), "old\n");
  await writeFile(join(directory, "b.ts"), "unrelated\n");
  const first = files(directory), planned = files(directory, ["b.ts"], "planned"), executed = files(directory, ["a.ts"], "retargeted");
  await store.preflight("first", first);
  await store.preflight("retargeted", planned);
  await writeFile(join(directory, "a.ts"), "new\n");
  await writeFile(join(directory, "a.ts"), "another writer's context\nnew\n");
  await store.executed("first", first);
  store.finish("first");
  await store.executed("retargeted", executed);
  store.finish("retargeted");
  assert.equal(store.take("first", first), undefined);
  assert.equal(store.take("retargeted", executed), undefined);
}));

test("sequential same-file calls retain their independent observations", async () => fixture(async (directory, store) => {
  const path = join(directory, "a.ts"), prepared = files(directory);
  await writeFile(path, "old\n");
  await store.preflight("first", prepared);
  await writeFile(path, "new\n");
  await store.executed("first", prepared);
  store.finish("first");
  await store.preflight("second", prepared);
  await writeFile(path, "newer\n");
  await store.executed("second", prepared);
  store.finish("second");
  const first = store.take("first", prepared)!, second = store.take("second", prepared)!;
  assert.equal(first.before.get(path)?.text, "old\n");
  assert.equal(first.after.get(path)?.text, "new\n");
  assert.equal(second.before.get(path)?.text, "new\n");
  assert.equal(second.after.get(path)?.text, "newer\n");
  first.release(); second.release();
}));

test("missing, nonregular, binary and invalid UTF-8 observations do not fail capture", async () => fixture(async (directory, store) => {
  await mkdir(join(directory, "folder"));
  await writeFile(join(directory, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(directory, "invalid"), Buffer.from([0xc0, 0xff]));
  const prepared = files(directory, ["missing", "folder", "binary", "invalid"]);
  await store.preflight("one", prepared);
  await store.executed("one", prepared);
  store.finish("one");
  const captured = store.take("one", prepared)!;
  assert.equal(captured.before.size, 0);
  assert.equal(captured.after.size, 0);
  captured.release();
}));

test("oversized files release reservations for later captures", async () => fixture(async directory => {
  const store = new FileObservations({ ...observationLimits, fileBytes: 16, totalBytes: 64, calls: 1, phaseMs: 5000 });
  try {
    await writeFile(join(directory, "a.ts"), "x".repeat(17));
    const prepared = files(directory);
    await store.preflight("large", prepared);
    await store.executed("large", prepared);
    store.finish("large");
    const large = store.take("large", prepared)!;
    assert.equal(large.before.size, 0);
    assert.equal(large.after.size, 0);
    large.release();
    await writeFile(join(directory, "a.ts"), "short");
    await store.preflight("small", prepared);
    await store.executed("small", prepared);
    store.finish("small");
    const small = store.take("small", prepared)!;
    assert.equal(small.before.get(join(directory, "a.ts"))?.text, "short");
    small.release();
  } finally { store.reset(); }
}));

test("a capacity-declined writer still invalidates an overlapping capture", async () => fixture(async directory => {
  const store = new FileObservations({ ...observationLimits, calls: 1, phaseMs: 5000 });
  try {
    await writeFile(join(directory, "a.ts"), "old\n");
    const prepared = files(directory);
    await store.preflight("observed", prepared);
    await store.preflight("declined-writer", prepared);
    assert.equal(store.directory("declined-writer"), undefined);
    await writeFile(join(directory, "a.ts"), "another call's contents\n");
    await store.executed("observed", prepared);
    store.finish("observed");
    assert.equal(store.take("observed", prepared), undefined);

    await store.preflight("capacity-freed-but-writer-active", prepared);
    assert.equal(store.directory("capacity-freed-but-writer-active"), undefined);
    store.completeTurn();
    await store.preflight("next-turn", prepared);
    await store.executed("next-turn", prepared);
    store.finish("next-turn");
    const recovered = store.take("next-turn", prepared)!;
    assert.equal(recovered.before.get(join(directory, "a.ts"))?.text, "another call's contents\n");
    recovered.release();
  } finally { store.reset(); }
}));

for (const limit of [{ queuedReads: 0 }, { totalBytes: 0 }]) test(`${Object.keys(limit)[0]} pressure retains ordinary views until settlement`, async () => fixture(async directory => {
  const store = new FileObservations({ ...observationLimits, ...limit, phaseMs: 5000 });
  try {
    await writeFile(join(directory, "a.ts"), "old\n");
    const prepared = files(directory);
    await store.preflight("unobserved-writer", prepared);
    await store.executed("unobserved-writer", prepared);
    store.finish("unobserved-writer");
    assert.equal(store.take("unobserved-writer", prepared), undefined);
    await store.preflight("still-unsafe", prepared);
    assert.equal(store.directory("still-unsafe"), undefined);
  } finally { store.reset(); }
}));

test("discarding an unfinished capture does not forget its possible writes", async () => fixture(async (directory, store) => {
  await writeFile(join(directory, "a.ts"), "old\n");
  const prepared = files(directory);
  const pending = store.preflight("unfinished", prepared);
  store.discard("unfinished");
  await pending;
  await store.preflight("during-untracked-writer", prepared);
  assert.equal(store.directory("during-untracked-writer"), undefined);
  store.completeTurn();
  await store.preflight("settled", prepared);
  await store.executed("settled", prepared);
  store.finish("settled");
  const recovered = store.take("settled", prepared)!;
  assert.equal(recovered.before.get(join(directory, "a.ts"))?.text, "old\n");
  recovered.release();
}));

test("session reset invalidates pending capture even when a source key is reused", async () => fixture(async (directory, store) => {
  await writeFile(join(directory, "a.ts"), "old\n");
  const prepared = files(directory);
  const pending = store.preflight("same", prepared);
  store.reset();
  await pending;
  assert.equal(store.directory("same"), undefined);
  await store.preflight("same", prepared);
  await store.executed("same", prepared);
  store.finish("same");
  const captured = store.take("same", prepared)!;
  assert.equal(captured.before.get(join(directory, "a.ts"))?.text, "old\n");
  store.reset();
  await store.preflight("same", prepared);
  await store.executed("same", prepared);
  store.finish("same");
  captured.release();
  const replacement = store.take("same", prepared)!;
  assert.equal(replacement.before.get(join(directory, "a.ts"))?.text, "old\n");
  replacement.release();
}));
