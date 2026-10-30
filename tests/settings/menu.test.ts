import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "../../src/settings/menu.ts";
import { SettingsStore } from "../../src/settings/store.ts";
import { settingKeys } from "../../src/settings/model.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
const down = "\x1b[B", up = "\x1b[A", right = "\x1b[C";

test("keyboard preview/cancel is nonpersistent; small menus scroll the selected Save control", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-menu-"));
  const project = join(root, "project.json");
  const store = new SettingsStore(join(root, "personal.json"), project, false);
  let closed = false;
  const menu = new SettingsMenu(store, theme, () => {}, () => { closed = true; }, () => 12);
  try {
    menu.handleInput(right);
    menu.handleInput(right);
    assert.equal(store.effective.titleMode, "tool");
    await assert.rejects(readFile(project));
    menu.handleInput("\x1b");
    assert.equal(closed, true);
    assert.equal(store.effective.titleMode, "action");

    store.begin("project");
    closed = false;
    menu.handleInput(right);
    menu.handleInput(right);
    for (let i = 0; i < settingKeys.length + 1; i++) menu.handleInput(down);
    assert.ok(menu.render(40).length <= 7);
    assert.ok(menu.render(40).some(line => line.includes("› Save")));
    const committed = new Promise<void>(resolve => store.subscribe(() => { if (!store.draft) resolve(); }));
    menu.handleInput("\r");
    await committed;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(await readFile(project, "utf8")).titleMode, "tool");
    assert.equal(closed, true);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("dirty target switching requires Save/Discard/Stay and preserves a custom numeric choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-menu-"));
  const personal = join(root, "personal.json"), project = join(root, "project.json");
  await writeFile(project, JSON.stringify({ resultRows: 17 }));
  const store = new SettingsStore(personal, project, false);
  const menu = new SettingsMenu(store, theme, () => {}, () => {});
  try {
    for (let i = 0; i < settingKeys.indexOf("resultRows"); i++) menu.handleInput(down);
    menu.handleInput("\r");
    menu.handleInput("\r");
    assert.equal(store.draft?.patch.resultRows, 17);
    while (!menu.render(100).some(line => line.includes("› Target:"))) menu.handleInput(down);
    menu.handleInput("\r");
    menu.handleInput("\r");
    assert.equal(store.draft?.target, "project");
    menu.handleInput("\r");
    menu.handleInput(up);
    menu.handleInput("\r");
    assert.equal(store.draft?.target, "personal");
    assert.deepEqual(JSON.parse(await readFile(project, "utf8")), { resultRows: 17 });
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});
