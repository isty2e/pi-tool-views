import assert from "node:assert/strict";
import test from "node:test";
import { embeddedUnifiedSpans } from "../../src/diff/formats.ts";

const first = "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,3 +1,3 @@\n-alpha one\n-beta two\n-gamma three\n+first is longer now\n+beta two\n+last changed";

test("complete embedded unified diffs retain preceding and following text", () => {
  const input = `Replaced 2 occurrences in alpha.txt\n${first}\nWarning: verify output.`;
  const spans = embeddedUnifiedSpans(input);
  assert.equal(spans.length, 1);
  assert.equal(input.slice(0, spans[0]!.start), "Replaced 2 occurrences in alpha.txt\n");
  assert.equal(input.slice(spans[0]!.start, spans[0]!.end), `${first}\n`);
  assert.equal(input.slice(spans[0]!.end), "Warning: verify output.");
});

test("truncated hunks and conflicting paths are not consumed", () => {
  const truncated = "text\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\nWarning: truncated";
  assert.deepEqual(embeddedUnifiedSpans(truncated), []);
  const malformed = "text\n--- /dev/null\n+++ /dev/null\n@@ -1 +1 @@\n-old\n+new";
  assert.deepEqual(embeddedUnifiedSpans(malformed), []);
});

test("separate complete diffs preserve intervening text and CRLF boundaries", () => {
  const input = "first\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\nwarning\r\n--- a/b\r\n+++ b/b\r\n@@ -3 +3 @@\r\n-before\r\n+after";
  const spans = embeddedUnifiedSpans(input);
  assert.equal(spans.length, 2);
  assert.equal(input.slice(spans[0]!.end, spans[1]!.start), "warning\r\n");
  assert.equal(input.slice(spans[1]!.end), "");
});
