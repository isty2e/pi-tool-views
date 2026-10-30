import assert from "node:assert/strict";
import test from "node:test";
import { compileProjection } from "../../src/projection/index.ts";

const text = { type: "string" };
const lines = { type: "array", items: text };
const schema = { type: "object", required: ["path", "edits"], properties: {
	path: text, edits: { type: "array", items: { anyOf: [
		{ type: "object", required: ["op", "pos", "lines"], properties: { op: { type: "string", enum: ["replace"] },
			pos: { type: "string", description: "start anchor (LINE#HASH from read)" }, end: text, lines } },
		{ type: "object", required: ["op", "lines"], properties: { op: { type: "string", enum: ["append"] }, pos: text, lines } },
		{ type: "object", required: ["op", "oldText", "newText"], properties: { op: { type: "string", enum: ["replace_text"] }, oldText: text, newText: text } },
	] } },
} };
const projection = compileProjection({ description: "Edit anchored lines.", input: { kind: "json", schema } });

test("anchored replacements and insertions use the existing ordered edit model", () => {
	const args = { path: "src/math.ts", edits: [
		{ op: "replace", pos: "9#KT", lines: ['console.log("hello");'] },
		{ op: "append", pos: "12#AB", lines: [""] },
		{ op: "replace_text", oldText: "x", newText: "y" },
	] };
	assert.deepEqual(projection.request(args), { kind: "change.replacements", requestedEdits: [
		{ kind: "located", operation: "replace", path: "src/math.ts", anchor: { token: "9#KT", line1: 9 }, newLines: ['console.log("hello");'] },
		{ kind: "located", operation: "insert-after", path: "src/math.ts", anchor: { token: "12#AB", line1: 12 }, newLines: [""] },
		{ path: "src/math.ts", oldText: "x", newText: "y" },
	] });
	assert.deepEqual(projection.request({ path: args.path, edits: JSON.stringify(args.edits) }), projection.request(args));
});

test("unsupported or ambiguous edits leave the original request intact", () => {
	for (const edits of [[{ op: "move", pos: "9#KT" }], [{ op: "replace", pos: "9#KT", lines: ["x"], extra: true }],
		[{ op: "replace", pos: "invalid anchor", lines: ["x"] }], [{ op: "replace", pos: "0#KT", lines: ["x"] }]]) {
		assert.equal(projection.request({ path: "a", edits }).kind, "uninterpreted");
	}
	assert.equal(projection.request({ path: "a", edits: "not-json" }).kind, "uninterpreted");
});

test("opaque anchor replacement retains no invented file or line position", () => {
	const pro = compileProjection({ description: "Replace anchored lines.", input: { kind: "json", schema: {
		type: "object", required: ["remove_from", "remove_to", "text"], properties: {
			remove_from: { type: "string", description: "5-char anchor of the FIRST line to remove." },
			remove_to: { type: "string", description: "5-char anchor of the LAST line to remove." },
			text: { type: "string", description: "The exact text to write in place of the removed range." },
		},
	} } });
	const request = pro.request({ remove_from: "dafox", remove_to: "dafox", text: "new" });
	assert.deepEqual(request, {
		kind: "change.replacements", requestedEdits: [{ kind: "located", operation: "replace", path: "", anchor: { token: "dafox" },
			end: { token: "dafox" }, newText: "new" }],
	});
	const output = pro.result({ content: [{ kind: "text", text: "Applied the edit." }], isError: false,
		details: { diff: "-9 before\n+9 new", warnings: ["producer warning"] } }, request);
	assert.ok(output.parts.some(part => part.kind === "diff" && part.origin === "reported"));
	assert.ok(output.parts.some(part => part.kind === "original-content"));
});

test("structured anchor operations keep their declared line and a blank insertion", () => {
	const anchored = compileProjection({ description: "Edit anchored lines.", input: { kind: "json", schema: {
		type: "object", required: ["path", "edits"], properties: { path: text,
			edits: { type: "array", description: "Hashline ops referencing anchors", items: { type: "object", properties: {
				op: { anyOf: [{ const: "replace", type: "string" }, { const: "delete", type: "string" }, { const: "append", type: "string" }] },
				anchor: { type: "object", properties: { line: { type: "integer" }, hash: text } }, end: { type: "object" }, body: lines,
			} } },
		},
	} } });
	const result = anchored.request({ path: "a", edits: [
		{ op: "delete", anchor: { line: 5, hash: "hT0" } }, { op: "append", body: [""] },
	] });
	assert.deepEqual(result, { kind: "change.replacements", requestedEdits: [
		{ kind: "located", operation: "delete", path: "a", anchor: { token: "5#hT0", line1: 5 } },
		{ kind: "located", operation: "insert-after", path: "a", anchor: { token: "EOF" }, newLines: [""] },
	] });
});

test("an opaque insertion with empty text means one blank line, not an absent edit", () => {
	const insert = compileProjection({ description: "Insert anchored text.", input: { kind: "json", schema: {
		type: "object", required: ["anchor", "direction", "text"], properties: {
			anchor: { type: "string", description: "Anchor line" }, direction: text,
			text: { type: "string", description: "The exact text to insert; an empty string inserts one blank line." },
		},
	} } });
	assert.deepEqual(insert.request({ anchor: "dafox", direction: "after", text: "" }), { kind: "change.replacements", requestedEdits: [
		{ kind: "located", operation: "insert-after", path: "", anchor: { token: "dafox" }, newLines: [""] },
	] });
});

test("nested line-anchor operations use the same ordered edit representation", () => {
	const readmap = compileProjection({ description: "Edit anchored lines.", input: { kind: "json", schema: {
		type: "object", required: ["path"], properties: { path: text, postEditVerify: { type: "boolean" }, edits: { type: "array", items: { anyOf: [
			{ type: "object", properties: { set_line: { type: "object", properties: {
				anchor: { type: "string", description: "Fresh LINE:HASH anchor" }, new_text: text,
			} } } },
			{ type: "object", properties: { replace_lines: { type: "object" } } },
			{ type: "object", properties: { insert_after: { type: "object" } } },
		] } } },
	} } });
	assert.deepEqual(readmap.request({ path: "a", postEditVerify: true, edits: [
		{ set_line: { anchor: "1:f0c", new_text: "hello", literal: true } },
		{ replace_lines: { start_anchor: "3:abc", end_anchor: "4:def", new_text: "" } },
		{ insert_after: { anchor: "8:xyz", new_text: "", text: "new" } },
	] }), { kind: "change.replacements", requestedEdits: [
		{ kind: "located", operation: "replace", path: "a", anchor: { token: "1:f0c", line1: 1 }, newText: "hello" },
		{ kind: "located", operation: "replace", path: "a", anchor: { token: "3:abc", line1: 3 }, end: { token: "4:def", line1: 4 }, newText: "" },
		{ kind: "located", operation: "insert-after", path: "a", anchor: { token: "8:xyz", line1: 8 }, newText: "new" },
	] });
	assert.equal(readmap.request({ path: "a", edits: [{ copy_lines: { start_anchor: "1:f0c", end_anchor: "1:f0c", after_anchor: "3:abc" } }] }).kind, "uninterpreted");
});
