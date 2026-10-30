import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { InspectionMenu } from "../../src/display/inspection.ts";
import { ToolViewsRuntime } from "../../src/host/runtime.ts";
import { SettingsMenu } from "../../src/settings/menu.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
type Notice = { message: string; type: Parameters<ExtensionCommandContext["ui"]["notify"]>[1] };

function registeredCommand() {
  const captured: { command?: Command } = {};
  const api = {
    on: () => () => {},
    registerToolRenderer() {},
    registerCommand(name: string, command: Command) {
      if (name === "tool-views") captured.command = command;
    },
  } as unknown as ExtensionAPI;
  const unused = (): never => { throw new Error("Command handling must not invoke the rendering engine"); };
  const runtime = new ToolViewsRuntime(api, { compile: unused, compare: unused, renderDiff: unused });
  runtime.install();
  if (!captured.command) throw new Error("The command fixture was not registered");
  return { command: captured.command, runtime };
}

test("SDK completion discovers described subcommands and applies them as valid command arguments", async t => {
  const { command, runtime } = registeredCommand();
  t.after(() => runtime.dispose());
  const provider = new CombinedAutocompleteProvider([{ name: "tool-views", ...command }], process.cwd());
  const options = { force: false, signal: new AbortController().signal };
  const root = await provider.getSuggestions(["/tool-v"], 0, 7, options);
  assert.deepEqual(root?.items.map(item => item.value), ["tool-views"]);

  for (const [prefix, expected] of [["", ["inspect", "help"]], ["i", ["inspect"]], ["h", ["help"]], ["  ins", ["inspect"]]] as const) {
    const line = `/tool-views ${prefix}`;
    const result = await provider.getSuggestions([line], 0, line.length, options);
    assert.deepEqual(result?.items.map(item => item.value), expected);
    assert.ok(result);
    for (const item of result.items) {
      assert.ok(item.description?.trim(), "each action needs a visible description");
      const completed = provider.applyCompletion([line], 0, line.length, item, result.prefix);
      assert.deepEqual(completed.lines[0]?.trim().split(/\s+/), ["/tool-views", item.value]);
    }
  }

  for (const prefix of ["unknown", "inspect extra", "inspect "]) {
    const line = `/tool-views ${prefix}`;
    assert.equal(await provider.getSuggestions([line], 0, line.length, options), null);
  }
});

test("help and unknown arguments show usage without initializing settings or opening a menu", async t => {
  const { command, runtime } = registeredCommand();
  t.after(() => runtime.dispose());
  const notices: Notice[] = [];
  const context = {
    hasUI: true,
    get cwd(): string { throw new Error("Usage must not initialize configuration"); },
    ui: {
      notify(message: string, type: Notice["type"]) { notices.push({ message, type }); },
      custom() { throw new Error("Usage must not open a menu"); },
    },
  } as unknown as ExtensionCommandContext;

  for (const argument of ["help", "  help \n", "inspec", "inspect extra"]) await command.handler(argument, context);
  assert.deepEqual(notices.map(notice => notice.type), ["info", "info", "warning", "warning"]);
  for (const notice of notices) {
    assert.ok(notice.message.includes("/tool-views inspect"));
    assert.ok(notice.message.includes("/tool-views help"));
  }
});

test("commands without an interactive UI do not initialize configuration or call UI methods", async t => {
  const { command, runtime } = registeredCommand();
  t.after(() => runtime.dispose());
  const context = {
    hasUI: false,
    get cwd(): string { throw new Error("A non-interactive command must not initialize configuration"); },
    get ui(): never { throw new Error("A non-interactive command must not access UI methods"); },
  } as unknown as ExtensionCommandContext;
  for (const argument of ["", "inspect", "help", "unknown"]) await command.handler(argument, context);
});

test("empty and inspect commands retain their real menus and leave configuration unchanged on close", async t => {
  const root = await mkdtemp(join(tmpdir(), "tool-views-command-"));
  const agent = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agent);
  await mkdir(join(workspace, ".pi"), { recursive: true });
  const userFile = join(agent, "tool-views.json");
  const projectFile = join(workspace, ".pi", "tool-views.json");
  const userSettings = '{"lineNumbers":false}\n';
  const projectSettings = '{"diffMode":"unified"}\n';
  await writeFile(userFile, userSettings);
  await writeFile(projectFile, projectSettings);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const { command, runtime } = registeredCommand();
  t.after(async () => {
    runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const opened: (SettingsMenu | InspectionMenu)[] = [];
  let closed = 0;
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
  const context = {
    hasUI: true,
    cwd: workspace,
    ui: {
      notify() { throw new Error("A supported menu command must not report invalid usage"); },
      async custom(factory: CustomFactory) {
        const component = await factory(
          { requestRender() {}, terminal: { rows: 24 } } as unknown as Parameters<CustomFactory>[0],
          theme, {} as Parameters<CustomFactory>[2], () => { closed++; },
        );
        assert.ok(component instanceof SettingsMenu || component instanceof InspectionMenu);
        assert.ok(component.render(80).length > 0);
        opened.push(component);
        component.handleInput("\x1b");
      },
    },
  } as unknown as ExtensionCommandContext;

  for (const argument of ["", " \t ", "  inspect \n"]) await command.handler(argument, context);
  assert.deepEqual(opened.map(component => component instanceof SettingsMenu ? "settings" : "inspect"), ["settings", "settings", "inspect"]);
  assert.equal(closed, 3);
  assert.equal(await readFile(userFile, "utf8"), userSettings);
  assert.equal(await readFile(projectFile, "utf8"), projectSettings);
});
