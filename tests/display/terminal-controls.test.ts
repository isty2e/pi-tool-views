import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { safeText } from "../../src/display/text.ts";
import { terminalControls } from "../../src/display/terminal-controls.ts";

// Bounded legacy oracles pin text and source-coordinate compatibility, not a production fallback.
const sequences = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])/g;
const controls = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])|\r\n?|\t|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const legacy = (text: string, keepColor: boolean) => text
  .replace(sequences, sequence => keepColor && /^\x1b\[[\d;:]*m$/.test(sequence) ? sequence : "")
  .replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, "")
  .replace(/\x1b(?!\[[\d;:]*m)/g, "").replace(/\t/g, "    ");

test("terminal controls retain bounded legacy text and UTF-16 coordinate interpretations", () => {
  const samples = ["", "plain 🙂é", "\x1b", "\x1b[31mred\x1b[0m", "\x1b[38:2::1:2:3mRGB",
    "\x1b[?25ltext\x1b[2J", "\x1b[  mtext", "\x1b[123no", "\x1b]title\x07tail",
    "\x1b]title\x1b\\tail", "\x1b]broken\x1b[31mred", "\x1b]unfinished", "\x1b_abc\x1b_P\x1b\\tail",
    "\x1bPone\x1b\\two\x1bXthree\x1b\\four", "\x1b_\x1bP\x1b^\x1bXliteral", "\r\n\r\t\x00\x7f\x9f",
    "\x1b\x00[31mtext", "\x1b\x00[31m\x1b[2Jtext", "left\x1b_🙂é\t\r\nright"];
  const atoms = ["a", "🙂", "é", "\x1b", "[", "]", "P", "X", "^", "_", "\\", "\x07", "\x00", "\x9f", "\r", "\n", "\t", "31;:m", "?", " "];
  let state = 41;
  for (let sample = 0; sample < 1_000; sample++) {
    let text = "";
    for (let index = 0; index < 32; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      text += atoms[state % atoms.length];
    }
    samples.push(text);
  }
  for (const sample of samples) {
    assert.deepEqual(Array.from(terminalControls(sample)), Array.from(sample.matchAll(controls), match => ({
      startUtf16: match.index, endUtf16: match.index + match[0].length,
    })), JSON.stringify(sample));
    for (const keepColor of [true, false]) assert.equal(safeText(sample, keepColor), legacy(sample, keepColor), JSON.stringify(sample));
  }
});

test("unterminated string controls reuse one suffix search without losing the literal tail", () => {
  for (const length of [4_096, 51_200]) {
    const input = "\x1b_".repeat(length / 2) + "literal tail";
    let searches = 0;
    const original = String.prototype.indexOf;
    const tracker = mock.method(String.prototype, "indexOf", function (this: string, search: string, from?: number) {
      searches++;
      return original.call(this, search, from);
    });
    let spans;
    try { spans = Array.from(terminalControls(input)); }
    finally { tracker.mock.restore(); }
    assert.ok(searches <= 2);
    assert.equal(spans.length, length / 2);
    assert.equal(safeText(input), "literal tail");
    assert.equal(safeText(input + "\x1b\\after"), "after");
  }
});
