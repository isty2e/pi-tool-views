import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../../src/settings/store.ts";
import { defaults, validateSettings } from "../../src/settings/model.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tool-views-settings-"));
  const personal = join(dir, "agent", "tool-views.json");
  const project = join(dir, "project", ".pi", "tool-views.json");
  await mkdir(join(dir, "agent"), { recursive: true });
  await mkdir(join(dir, "project", ".pi"), { recursive: true });
  const store = new SettingsStore(personal, project, false);
  return { dir, personal, project, store, async close() { store.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test("settings layer inheritance distinguishes missing, unlimited and zero", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.store.effective, defaults);
    await writeFile(f.personal, JSON.stringify({ resultRows: null, diffContext: 5 }));
    await writeFile(f.project, JSON.stringify({ diffContext: 0 }));
    f.store.reload();
    assert.equal(f.store.effective.resultRows, null);
    assert.equal(f.store.effective.diffContext, 0);
    assert.equal(validateSettings({ resultRows: -1 }).ok, false);
    assert.equal(validateSettings({ diffContext: 0.5 }).ok, false);
    assert.equal(validateSettings({ unknown: true }).ok, false);
  } finally { await f.close(); }
});

test("invalid external changes retain the last valid layer; removal restores inheritance", async () => {
  const f = await fixture();
  try {
    await writeFile(f.personal, JSON.stringify({ resultRows: 7 }));
    await writeFile(f.project, JSON.stringify({ resultRows: 3 }));
    f.store.reload();
    await writeFile(f.project, "{broken");
    f.store.reload();
    assert.equal(f.store.effective.resultRows, 3);
    assert.equal(f.store.diagnostics.length, 1);
    await rm(f.project);
    f.store.reload();
    assert.equal(f.store.effective.resultRows, 7);
    assert.equal(f.store.diagnostics.length, 0);
  } finally { await f.close(); }
});

test("preview never writes; cancel uses new committed layers, not the opening snapshot", async () => {
  const f = await fixture();
  try {
    f.store.begin("project");
    f.store.edit("resultRows", 2);
    assert.equal(f.store.effective.resultRows, 2);
    await assert.rejects(readFile(f.project));
    await writeFile(f.personal, JSON.stringify({ resultRows: 19 }));
    f.store.reload();
    assert.equal(f.store.effective.resultRows, 2);
    f.store.cancel();
    assert.equal(f.store.effective.resultRows, 19);
  } finally { await f.close(); }
});

test("save affects one target and detected external edits retain the draft", async () => {
  const f = await fixture();
  try {
    await writeFile(f.personal, JSON.stringify({ showDuration: false }));
    f.store.reload();
    f.store.begin("project");
    f.store.edit("diffMode", "split");
    await writeFile(f.project, JSON.stringify({ diffMode: "unified" }));
    assert.equal((await f.store.save()).kind, "conflict");
    assert.equal(f.store.draft?.patch.diffMode, "split");
    assert.deepEqual(JSON.parse(await readFile(f.project, "utf8")), { diffMode: "unified" });

    f.store.reload();
    f.store.begin("project");
    f.store.edit("diffMode", "split");
    assert.equal((await f.store.save()).kind, "saved");
    assert.deepEqual(JSON.parse(await readFile(f.project, "utf8")), { diffMode: "split" });
    assert.deepEqual(JSON.parse(await readFile(f.personal, "utf8")), { showDuration: false });
  } finally { await f.close(); }
});

test("failed persistence retains the draft and committed writes survive redraw errors", async () => {
  const f = await fixture();
  try {
    f.store.begin("project");
    f.store.edit("backdrop", true);
    await rm(join(f.dir, "project", ".pi"), { recursive: true });
    await writeFile(join(f.dir, "project", ".pi"), "not a directory");
    assert.equal((await f.store.save()).kind, "error");
    assert.equal(f.store.draft?.patch.backdrop, true);
    await rm(join(f.dir, "project", ".pi"));
    await mkdir(join(f.dir, "project", ".pi"));

    f.store.subscribe(() => { throw new Error("synthetic redraw failure"); });
    assert.equal((await f.store.save()).kind, "saved");
    assert.equal(f.store.draft, undefined);
    assert.equal(f.store.committed.backdrop, true);
    assert.equal(JSON.parse(await readFile(f.project, "utf8")).backdrop, true);
    assert.ok(f.store.notificationError);
  } finally { await f.close(); }
});

test("menu Save does not replace a managed symlink or modify its referent", async () => {
  const f = await fixture();
  try {
    await writeFile(f.personal, JSON.stringify({ resultRows: 7 }));
    await symlink(f.personal, f.project);
    f.store.reload();
    f.store.begin("project");
    f.store.edit("resultRows", 19);
    assert.equal((await f.store.save()).kind, "error");
    assert.equal((await lstat(f.project)).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(await readFile(f.personal, "utf8")), { resultRows: 7 });
    assert.equal(f.store.draft?.patch.resultRows, 19);
  } finally { await f.close(); }
});
