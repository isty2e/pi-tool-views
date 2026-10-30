import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "../../src/settings/store.ts";
import { SettingsMenu } from "../../src/settings/menu.ts";
import { mergeSettings, settingKeys, validateSettings } from "../../src/settings/model.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
const down = "\x1b[B", right = "\x1b[C";

test("emphasis gap defaults to two and accepts only nonnegative safe integers", () => {
  assert.equal(mergeSettings({}, {}).diffEmphasisGap, 2);
  for (const value of [0, 1, 2, 7, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(validateSettings({ diffEmphasisGap: value }), { ok: true, value: { diffEmphasisGap: value } });
  }
  for (const value of [-1, 0.5, "2", null, false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateSettings({ diffEmphasisGap: value }).ok, false);
  }
});

test("existing layers inherit the new default while explicit zero overrides personal values", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-emphasis-"));
  const personal = join(root, "personal.json"), project = join(root, "project.json");
  const store = new SettingsStore(personal, project, false);
  try {
    assert.equal(store.effective.diffEmphasisGap, 2);
    await writeFile(personal, JSON.stringify({ diffEmphasisGap: 5 }));
    await writeFile(project, JSON.stringify({ diffEmphasisGap: 0, showDuration: false }));
    store.reload();
    assert.equal(store.effective.diffEmphasisGap, 0);
    assert.equal(store.effective.showDuration, false);
    store.begin("project");
    store.edit("diffEmphasisGap", 3);
    assert.equal(store.effective.diffEmphasisGap, 3);
    assert.equal(JSON.parse(await readFile(project, "utf8")).diffEmphasisGap, 0);
    await writeFile(project, JSON.stringify({ diffEmphasisGap: 1, showDuration: false }));
    store.reload();
    assert.equal(store.effective.diffEmphasisGap, 3);
    store.cancel();
    assert.equal(store.effective.diffEmphasisGap, 1);
    await writeFile(project, JSON.stringify({ showDuration: false }));
    store.reload();
    assert.equal(store.effective.diffEmphasisGap, 5);
    await writeFile(personal, "{}");
    store.reload();
    assert.equal(store.effective.diffEmphasisGap, 2);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("menu preserves custom gaps and supports preview, Cancel, Save and reloading zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-emphasis-menu-"));
  const personal = join(root, "personal.json"), project = join(root, "project.json");
  await writeFile(project, JSON.stringify({ diffEmphasisGap: 7, diffContext: 5 }));
  const store = new SettingsStore(personal, project, false);
  let reopened: SettingsStore | undefined;
  try {
    const index = settingKeys.indexOf("diffEmphasisGap");
    const menu = new SettingsMenu(store, theme, () => {}, () => {});
    for (let i = 0; i < index; i++) menu.handleInput(down);
    menu.handleInput("\r");
    menu.handleInput("\r");
    assert.equal(store.draft?.patch.diffEmphasisGap, 7);
    menu.handleInput(right);
    assert.equal(store.effective.diffEmphasisGap, 0);
    assert.equal(JSON.parse(await readFile(project, "utf8")).diffEmphasisGap, 7);
    menu.handleInput("\x1b");
    assert.equal(store.effective.diffEmphasisGap, 7);
    const saving = new SettingsMenu(store, theme, () => {}, () => {});
    for (let i = 0; i < index; i++) saving.handleInput(down);
    saving.handleInput(right);
    for (let i = index; i < settingKeys.length + 1; i++) saving.handleInput(down);
    const committed = new Promise<void>(resolve => store.subscribe(() => { if (!store.draft) resolve(); }));
    saving.handleInput("\r");
    await committed;
    assert.deepEqual(JSON.parse(await readFile(project, "utf8")), { diffEmphasisGap: 0, diffContext: 5 });
    reopened = new SettingsStore(personal, project, false);
    assert.equal(reopened.effective.diffEmphasisGap, 0);
    assert.equal(reopened.effective.diffContext, 5);
  } finally { reopened?.dispose(); store.dispose(); await rm(root, { recursive: true, force: true }); }
});
