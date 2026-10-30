import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SourceText } from "../presentation.ts";
import { sourceLines } from "./text.ts";

type OwnedSource = Pick<SourceText, "text" | "language" | "firstLine1">;
type SourceSlot = "source" | "arguments";
interface PaintTheme {
  readonly theme: Theme;
  readonly colors: Theme["colors"] | undefined;
  readonly mode: ReturnType<Theme["getColorMode"]> | undefined;
  readonly gutter: string;
}
interface SourcePaint {
  readonly source: OwnedSource;
  readonly path: string | undefined;
  readonly width: number;
  readonly lineNumbers: boolean;
  readonly lines: readonly string[];
}

export class SourcePaintCache {
  private readonly entries = new Map<SourceSlot, SourcePaint>();
  private readonly painter: typeof sourceLines;
  private paintTheme: PaintTheme | undefined;
  constructor(painter: typeof sourceLines = sourceLines) { this.painter = painter; }

  /** SDK 1.4 keeps a stable theme proxy while replacing its immutable resolved palette. */
  observeTheme(theme: Theme): boolean {
    let next: PaintTheme;
    try {
      next = { theme, colors: theme.colors, mode: typeof theme.getColorMode === "function" ? theme.getColorMode() : undefined,
        gutter: theme.fg("dim", "") };
    } catch { this.clear(); return true; }
    const previous = this.paintTheme;
    if (previous?.theme === theme && previous.colors === next.colors && previous.mode === next.mode && previous.gutter === next.gutter) return false;
    this.entries.clear();
    this.paintTheme = next;
    return true;
  }

  paint(slot: SourceSlot, source: OwnedSource, path: string | undefined, width: number, lineNumbers: boolean, theme: Theme): readonly string[] {
    this.observeTheme(theme);
    const cached = this.entries.get(slot);
    if (cached?.source.text === source.text && cached.source.language === source.language && cached.source.firstLine1 === source.firstLine1
      && cached.path === path && cached.width === width && cached.lineNumbers === lineNumbers) return cached.lines;

    const lines = this.painter(source, path, width, lineNumbers, theme);
    if (this.paintTheme) this.entries.set(slot, { source: { text: source.text,
      ...(source.language !== undefined ? { language: source.language } : {}), ...(source.firstLine1 !== undefined ? { firstLine1: source.firstLine1 } : {}) },
      path, width, lineNumbers, lines });
    return lines;
  }

  clear(): void { this.entries.clear(); this.paintTheme = undefined; }
}
