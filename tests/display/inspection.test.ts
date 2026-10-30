import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { InspectionMenu } from "../../src/display/inspection.ts";
import type { InspectionView } from "../../src/display/inspection.ts";

const theme = { bold: (text: string) => text } as Theme;

test("keyboard inspection selects the actual item and reads every view without a card mouse handler", () => {
  const reads: { item: number; view: InspectionView }[] = [];
  let closed = false;
  const menu = new InspectionMenu([0, 1].map(item => ({ label: `${item + 1}. same-name`,
    lines(view: InspectionView) { reads.push({ item, view }); return [`${item}:${view}`]; },
  })), theme, () => {}, () => { closed = true; }, () => 24);
  menu.render(80);
  menu.handleInput("\x1b[B");
  menu.handleInput("\r");
  assert.ok(menu.render(80).includes("1:arguments"));
  menu.handleInput("\x1b[C");
  assert.ok(menu.render(80).includes("1:source"));
  menu.handleInput("\x1b[C");
  assert.ok(menu.render(80).includes("1:result"));
  assert.deepEqual(reads.map(read => read.item), [1, 1, 1]);
  menu.handleInput("\x1b");
  assert.equal(closed, false);
  menu.handleInput("\x1b");
  assert.equal(closed, true);
});

test("small-screen inspection scrolls to the final supplied row and handles an empty runtime", () => {
  const menu = new InspectionMenu([{ label: "1. output", lines: () => Array.from({ length: 40 }, (_, index) => `line ${index}`) }],
    theme, () => {}, () => {}, () => 8);
  menu.handleInput("\r");
  assert.equal(menu.render(40).length, 3);
  for (let index = 0; index < 45; index++) { menu.handleInput("\x1b[B"); menu.render(40); }
  assert.ok(menu.render(40).includes("line 39"));
  assert.ok(!menu.render(40).includes("line 0"));
  const empty = new InspectionMenu([], theme, () => {}, () => {}, () => 6);
  empty.handleInput("\r");
  assert.equal(empty.render(40).length, 1);
  assert.ok(empty.render(80)[0]?.includes("No tool cards"));
});
