import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { settingKeys, settingsChoices } from "./model.ts";
import type { SettingsKey, SettingsTarget } from "./model.ts";
import { SettingsStore } from "./store.ts";
import { safeText } from "../display/text.ts";

const labels: Record<SettingsKey, string> = {
  titleMode: "Title wording", showDuration: "Duration", lineNumbers: "Line numbers",
  backdrop: "Tool backdrop", horizontalRules: "Horizontal rules", resultRows: "Result preview rows",
  shellWindow: "Shell preview", commandPreview: "Command title preview",
  shellSourceInitiallyVisible: "New shell source visible", codeInitiallyVisible: "New code source visible",
  diffMode: "Diff view", diffContext: "Diff context lines", diffEmphasisGap: "Diff emphasis gap", diffRowBackground: "Diff row background",
};

function displayValue(value: unknown): string {
  if (value === undefined) return "Inherit";
  if (value === null) return "Unlimited";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

export class SettingsMenu implements Component {
  private readonly store: SettingsStore;
  private readonly theme: Theme;
  private readonly redraw: () => void;
  private readonly done: () => void;
  private readonly height: () => number;
  private readonly hostDiagnostic: () => string | undefined;
  private selected = 0;
  private picker: { readonly key: SettingsKey; index: number } | undefined;
  private switching: { readonly target: SettingsTarget; index: number } | undefined;
  private status = "";
  private busy = false;

  constructor(store: SettingsStore, theme: Theme, redraw: () => void, done: () => void, height: () => number = () => 24,
    hostDiagnostic: () => string | undefined = () => undefined) {
    this.store = store;
    this.theme = theme;
    this.redraw = redraw;
    this.done = done;
    this.height = height;
    this.hostDiagnostic = hostDiagnostic;
    store.begin("project");
  }

  invalidate(): void {}
  dispose(): void { this.store.cancel(); }

  render(width: number): string[] {
    const draft = this.store.draft;
    if (!draft) return [];
    const header = [this.theme.bold("Tool Views"), `Editing ${draft.target}: ${this.store.path(draft.target)}`];
    const items: string[] = [];
    let selected = this.selected;

    if (this.switching) {
      header[0] = this.theme.bold("Unsaved target changes");
      selected = this.switching.index;
      ["Save and switch", "Discard and switch", "Stay"].forEach((label, index) => {
        items.push(`${index === selected ? "›" : " "} ${label}`);
      });
    } else if (this.picker) {
      const picker = this.picker;
      header[0] = this.theme.bold(`Tool Views · ${labels[picker.key]}`);
      selected = picker.index;
      this.choices(picker.key).forEach((value, index) => {
        items.push(`${index === selected ? "›" : " "} ${displayValue(value)}`);
      });
    } else {
      settingKeys.forEach((key, index) => {
        const own = draft.patch[key];
        const effective = this.store.effective[key];
        const hint = own === undefined ? ` → ${displayValue(effective)}`
          : own !== effective ? ` (project override: ${displayValue(effective)})` : "";
        const text = `${index === this.selected ? "›" : " "} ${labels[key]}: ${displayValue(own)}${hint}`;
        items.push(index === this.selected ? this.theme.fg("accent", text) : text);
      });
      ["Target: " + draft.target, "Save", "Cancel", "Reload selected target"].forEach((text, offset) => {
        const index = settingKeys.length + offset;
        items.push(`${index === this.selected ? "›" : " "} ${text}`);
      });
    }

    const hostDiagnostic = this.hostDiagnostic();
    const footer = [
      ...(this.status ? [this.theme.fg("warning", this.status)] : []),
      ...this.store.diagnostics.map(diagnostic => this.theme.fg("warning", diagnostic)),
      ...(hostDiagnostic ? [this.theme.fg("warning", `Session lookup: ${hostDiagnostic}`)] : []),
      ...(this.store.notificationError ? [this.theme.fg("warning", `Redraw: ${this.store.notificationError}`)] : []),
      "↑/↓ select · ←/→ cycle · Enter choose · Esc cancel",
      "Layout previews the transcript. Initial visibility affects new cards after Save.",
    ];
    const available = Math.max(1, Math.floor(this.height()) - 5);
    const fit = (line: string) => truncateToWidth(safeText(line).replace(/\n/g, " "), Math.max(1, width));
    if (available <= 3) return [items[selected] ?? header[0]!, "Enter choose · Esc cancel"].slice(0, available).map(fit);
    const shownFooter = footer.slice(0, Math.min(footer.length, available - 3));
    const count = Math.max(1, available - header.length - shownFooter.length);
    const start = Math.max(0, Math.min(items.length - count, selected - Math.floor(count / 2)));
    return [...header, ...items.slice(start, start + count), ...shownFooter].map(fit);
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const delta = matchesKey(data, "up") || matchesKey(data, "left") ? -1
      : matchesKey(data, "down") || matchesKey(data, "right") ? 1 : 0;

    if (this.switching) {
      if (delta) this.switching.index = (this.switching.index + delta + 3) % 3;
      else if (matchesKey(data, "escape")) this.switching = undefined;
      else if (matchesKey(data, "enter")) void this.resolveSwitch();
    } else if (this.picker) {
      const values = this.choices(this.picker.key);
      if (delta) this.picker.index = (this.picker.index + delta + values.length) % values.length;
      else if (matchesKey(data, "escape")) this.picker = undefined;
      else if (matchesKey(data, "enter")) {
        this.store.edit(this.picker.key, values[this.picker.index]);
        this.picker = undefined;
      }
    } else if (matchesKey(data, "escape")) {
      this.store.cancel();
      this.done();
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.selected = (this.selected + delta + settingKeys.length + 4) % (settingKeys.length + 4);
    } else {
      const key = settingKeys[this.selected];
      if (key && delta) {
        const values = this.choices(key);
        const index = values.indexOf(this.store.draft?.patch[key]);
        this.store.edit(key, values[(index + delta + values.length) % values.length]);
      } else if (matchesKey(data, "enter")) void this.activate();
    }
    this.redraw();
  }

  private async activate(): Promise<void> {
    const key = settingKeys[this.selected];
    const draft = this.store.draft;
    if (!draft) return;
    this.status = "";
    if (key) {
      this.picker = { key, index: Math.max(0, this.choices(key).indexOf(draft.patch[key])) };
    } else if (this.selected === settingKeys.length) {
      const target = draft.target === "personal" ? "project" : "personal";
      if (draft.dirty) this.switching = { target, index: 2 };
      else this.store.begin(target);
    } else if (this.selected === settingKeys.length + 1) {
      this.busy = true;
      const result = await this.store.save();
      this.busy = false;
      if (result.kind === "saved") this.done();
      else this.status = result.message;
    } else if (this.selected === settingKeys.length + 2) {
      this.store.cancel();
      this.done();
    } else {
      this.store.reload();
      this.store.begin(draft.target);
      this.status = "Draft reloaded from the selected target.";
    }
    this.redraw();
  }

  private async resolveSwitch(): Promise<void> {
    const switching = this.switching;
    if (!switching) return;
    if (switching.index === 0) {
      this.busy = true;
      const result = await this.store.save();
      this.busy = false;
      if (result.kind !== "saved") {
        this.status = result.message;
        this.switching = undefined;
        this.redraw();
        return;
      }
    }
    if (switching.index !== 2) this.store.begin(switching.target);
    this.switching = undefined;
    this.redraw();
  }

  private choices(key: SettingsKey) {
    const values = [...settingsChoices(key)];
    const current = this.store.draft?.patch[key];
    if (current !== undefined && !values.includes(current)) values.splice(1, 0, current);
    return values;
  }
}
