import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { safeText } from "./text.ts";

export type InspectionView = "arguments" | "source" | "result";

export interface InspectionItem {
  readonly label: string;
  readonly lines: (view: InspectionView, width: number) => readonly string[];
}

const views: readonly InspectionView[] = ["arguments", "source", "result"];

export class InspectionMenu implements Component {
  private readonly items: readonly InspectionItem[];
  private readonly theme: Theme;
  private readonly redraw: () => void;
  private readonly done: () => void;
  private readonly height: () => number;
  private selected = 0;
  private opened = false;
  private view = 0;
  private offset = 0;
  private maximumOffset = 0;

  constructor(items: readonly InspectionItem[], theme: Theme, redraw: () => void, done: () => void, height: () => number) {
    this.items = items;
    this.theme = theme;
    this.redraw = redraw;
    this.done = done;
    this.height = height;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const available = Math.max(1, Math.floor(this.height()) - 5);
    const count = Math.max(1, available - 2);
    const item = this.items[this.selected];
    const fit = (line: string) => truncateToWidth(safeText(line).replace(/\n/g, " "), Math.max(1, width));
    let body: readonly string[];
    let title: string;
    let help: string;
    if (this.opened && item) {
      const view = views[this.view]!;
      body = item.lines(view, width);
      this.maximumOffset = Math.max(0, body.length - count);
      this.offset = Math.min(this.offset, this.maximumOffset);
      title = `Inspect ${item.label} · ${view} · ${this.offset + 1}/${Math.max(1, body.length)}`;
      body = body.slice(this.offset, this.offset + count);
      help = "↑/↓ scroll · ←/→ arguments/source/result · Esc back";
    } else {
      title = "Inspect tool";
      const start = Math.max(0, Math.min(this.items.length - count, this.selected - Math.floor(count / 2)));
      body = this.items.length ? this.items.slice(start, start + count).map((row, index) =>
        `${start + index === this.selected ? "›" : " "} ${row.label}`) : ["No tool cards are available in this runtime."];
      help = "↑/↓ select · Enter inspect · Esc close";
    }
    if (available < 3) return [body[0] ?? title, help].slice(0, available).map(fit);
    return [this.theme.bold(fit(title)), ...body.map(fit), fit(help)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.opened) this.opened = false;
      else this.done();
    } else if (this.opened) {
      if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
      else if (matchesKey(data, "down")) this.offset = Math.min(this.maximumOffset, this.offset + 1);
      else if (matchesKey(data, "left") || matchesKey(data, "right")) {
        this.view = (this.view + (matchesKey(data, "left") ? -1 : 1) + views.length) % views.length;
        this.offset = 0;
      }
    } else if (this.items.length) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.selected = (this.selected + (matchesKey(data, "up") ? -1 : 1) + this.items.length) % this.items.length;
      } else if (matchesKey(data, "enter")) {
        this.opened = true;
        this.view = 0;
        this.offset = 0;
      }
    }
    this.redraw();
  }
}
