import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SourcePaintCache } from "../../src/display/source-cache.ts";

test("source painting reuses values across object revisions and retains one entry per role", () => {
  const theme = { fg: (_role: string, value: string) => value } as Theme;
  let paints = 0;
  const cache = new SourcePaintCache((source, path, width, numbers) => {
    paints++;
    return [JSON.stringify([source, path, width, numbers])];
  });
  const source = { text: "const value = 1;", language: "javascript", firstLine1: 1 };
  const initial = cache.paint("source", source, "a.js", 80, true, theme);
  assert.equal(cache.paint("source", { ...source }, "a.js", 80, true, theme), initial);
  assert.equal(paints, 1);
  const args = cache.paint("arguments", source, undefined, 80, false, theme);
  cache.paint("source", source, "a.js", 40, true, theme);
  assert.equal(cache.paint("arguments", { ...source }, undefined, 80, false, theme), args);
  assert.equal(paints, 3);
  cache.paint("source", source, "a.js", 80, true, theme);
  assert.equal(paints, 4, "the earlier source width must not remain as another retained entry");

  source.text = "const value = 2;";
  cache.paint("source", source, "a.js", 80, true, theme);
  source.language = "typescript";
  cache.paint("source", source, "a.js", 80, true, theme);
  source.firstLine1 = 7;
  cache.paint("source", source, "a.js", 80, true, theme);
  cache.paint("source", source, "b.ts", 80, true, theme);
  cache.paint("source", source, "b.ts", 80, false, theme);
  assert.equal(paints, 9);
  cache.clear();
  cache.paint("source", source, "b.ts", 80, false, theme);
  cache.paint("arguments", source, undefined, 80, false, theme);
  assert.equal(paints, 11);
});

test("effective palette, color mode and gutter changes invalidate a stable theme facade", () => {
  let colors: Readonly<{ revision: number }> = Object.freeze({ revision: 1 });
  let mode: ReturnType<Theme["getColorMode"]> = "truecolor";
  let gutter = "dim:";
  const theme = { get colors() { return colors; }, getColorMode: () => mode,
    fg: (_role: string, value: string) => gutter + value } as unknown as Theme;
  let paints = 0;
  const cache = new SourcePaintCache(() => [`paint ${++paints}`]);
  const source = { text: "source" };
  const draw = () => cache.paint("source", source, undefined, 80, true, theme);
  draw(); draw();
  assert.equal(paints, 1);
  colors = Object.freeze({ revision: 2 });
  draw();
  mode = "256color";
  draw();
  gutter = "new dim:";
  draw();
  assert.equal(paints, 4);
  assert.equal(cache.observeTheme(theme), false);
});

test("failed paints do not publish entries and unreadable theme metadata disables reuse only", () => {
  const theme = { fg: (_role: string, value: string) => value } as Theme;
  let attempts = 0;
  const cache = new SourcePaintCache(() => { if (++attempts === 1) throw new Error("paint failed"); return ["complete"]; });
  const draw = () => cache.paint("source", { text: "source" }, undefined, 80, true, theme);
  assert.throws(draw, Error);
  assert.deepEqual(draw(), ["complete"]);
  draw();
  assert.equal(attempts, 2);
  const opaque = { get colors() { throw new Error("unavailable metadata"); }, fg: theme.fg } as unknown as Theme;
  cache.paint("source", { text: "source" }, undefined, 80, true, opaque);
  cache.paint("source", { text: "source" }, undefined, 80, true, opaque);
  assert.equal(attempts, 4);
});
