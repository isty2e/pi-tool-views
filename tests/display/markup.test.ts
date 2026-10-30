import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { markupLines } from "../../src/display/markup.ts";

const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as Theme;

test("a single complete Markdown code fence displays source without fabricated line numbers", () => {
	const text = "\n```typescript\nconst value = 1;\n  return value;\n```\n";
	const part = { kind: "markup", format: "markdown", text } as const;
	const lines = markupLines(part, 120, theme).map(stripTerminalSequences);
	assert.deepEqual(lines, ["const value = 1;", "  return value;"]);
	assert.equal(part.text, text);
});

test("mixed or ambiguous Markdown and plaintext retain their supplied content", () => {
	for (const text of ["explanation\n```typescript\nconst a = 1;\n```", "```\na\n```\nnot code\n```",
		"````typescript\nconst a = 1;\n````"]) {
		assert.equal(markupLines({ kind: "markup", format: "markdown", text }, 200, theme).map(stripTerminalSequences).join("\n"), text);
	}
	const literal = "```typescript\nconst a = 1;\n```";
	assert.equal(markupLines({ kind: "markup", format: "plaintext", text: literal }, 200, theme).map(stripTerminalSequences).join("\n"), literal);
});
