import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffPresentation, renderDiffPresentation } from "../../src/diff/index.ts";
import { buildOperationPresentation } from "../../src/operations.ts";
import { parseNumbered } from "../../src/diff/formats.ts";
import { titleFacts } from "../../src/display/title.ts";
import type { RequestView, ResultView } from "../../src/presentation.ts";

test("a located replacement retains an unknown before side and renders its supplied anchor", () => {
	const request: RequestView = { kind: "change.replacements", requestedEdits: [{ kind: "located", operation: "replace",
		path: "src/math.ts", anchor: { token: "9#KT", line1: 9 }, newText: 'console.log("hello");' }] };
	const plan = buildDiffPresentation(request, undefined);
	assert.equal(plan.units[0]?.origin, "request");
	const section = plan.units[0]?.sections[0];
	assert.equal(section?.kind, "hunks");
	if (section?.kind !== "hunks") return;
	const block = section.hunks[0]?.blocks[0];
	assert.equal(block?.kind, "located-change");
	if (block?.kind !== "located-change") return;
	assert.equal(block.locationLabel, "9#KT");
	assert.equal(block.after[0]?.text, 'console.log("hello");');
	assert.equal(block.after[0]?.line1, 9);
	assert.equal(block.after[0]?.locationLabel, undefined);
	for (const layout of ["unified", "split"] as const) {
		const text = renderDiffPresentation(plan, 90, { layout, showHeadings: false }).join("\n");
		assert.ok(text.includes("9#KT"));
		assert.ok(text.includes('console.log("hello");'));
		assert.equal(text.split("9#KT").length - 1, 1);
		assert.match(text, /9\s+\+\s+console\.log/);
		const withoutNumbers = renderDiffPresentation(plan, 90, { layout, lineNumbers: false, showHeadings: false }).join("\n");
		assert.ok(!withoutNumbers.includes("9#KT"));
		assert.doesNotMatch(withoutNumbers, /9\s+\+\s+console\.log/);
		assert.ok(withoutNumbers.includes('console.log("hello");'));
	}
});

test("proposed replacement and insertion lines use the request anchor, not a new hash", () => {
	const cases = [
		{ operation: "replace", first: 9 }, { operation: "insert-before", first: 9 }, { operation: "insert-after", first: 10 },
	] as const;
	for (const { operation, first } of cases) {
		const request: RequestView = { kind: "change.replacements", requestedEdits: [{ kind: "located", operation,
			path: "a", anchor: { token: "9#KT", line1: 9 }, newLines: ["first", "second", ""] }] };
		const section = buildDiffPresentation(request, undefined).units[0]?.sections[0];
		assert.equal(section?.kind, "hunks");
		if (section?.kind !== "hunks") continue;
		const block = section.hunks[0]?.blocks[0];
		assert.equal(block?.kind, "located-change");
		if (block?.kind !== "located-change") continue;
		assert.deepEqual(block.after.map(cell => cell.line1), [first, first + 1, first + 2]);
		assert.ok(block.after.every(cell => cell.locationLabel === undefined));
	}
});

test("opaque anchors and overflowing preview line numbers stay unnumbered", () => {
	for (const anchor of [{ token: "dafox" }, { token: "edge", line1: Number.MAX_SAFE_INTEGER }] as const) {
		const request: RequestView = { kind: "change.replacements", requestedEdits: [{ kind: "located", operation: "insert-after",
			path: "", anchor, newText: "first\nsecond" }] };
		const section = buildDiffPresentation(request, undefined).units[0]?.sections[0];
		assert.equal(section?.kind, "hunks");
		if (section?.kind !== "hunks") continue;
		const block = section.hunks[0]?.blocks[0];
		assert.equal(block?.kind, "located-change");
		if (block?.kind === "located-change") assert.ok(block.after.every(cell => cell.line1 === undefined));
	}
});

test("known blank insertion and deletion remain distinct and retain the anchor", () => {
	const request: RequestView = { kind: "change.replacements", requestedEdits: [
		{ kind: "located", operation: "insert-after", path: "a", anchor: { token: "9#KT", line1: 9 }, newLines: [""] },
		{ kind: "located", operation: "delete", path: "a", anchor: { token: "10#AB", line1: 10 } },
	] };
	const operations = buildOperationPresentation(request, buildDiffPresentation(request, undefined));
	assert.equal(operations.items.length, 2);
	const first = operations.items[0], second = operations.items[1];
	assert.equal(first?.kind, "edit");
	assert.equal(second?.kind, "edit");
	if (first?.kind !== "edit" || second?.kind !== "edit") return;
	const inserted = renderDiffPresentation(first.diff, 80, { layout: "unified", showHeadings: false }).join("\n");
	const deleted = renderDiffPresentation(second.diff, 80, { layout: "unified", showHeadings: false }).join("\n");
	assert.ok(inserted.includes("Insert after 9#KT"));
	assert.match(inserted, /\n\s*10\s+\+/);
	assert.ok(deleted.includes("10#AB"));
	assert.doesNotMatch(deleted, /^\s*(?:\S+\s+){0,2}\+\s/m);
});

test("producer numbered diffs retain new-side hash labels and old text indentation", () => {
	const actual = "  2#HJ:\n- 3    export function add() {\n+ 3#MP:export function add() { /* updated */\n  4#HQ:  return 1;\n    ...";
	const parsed = parseNumbered(actual);
	const section = parsed?.sections[0];
	assert.equal(section?.kind, "hunks");
	if (section?.kind !== "hunks") return;
	const blocks = section.hunks[0]!.blocks;
	assert.equal(blocks[0]?.kind, "context");
	assert.equal(blocks[1]?.kind, "change");
	if (blocks[0]?.kind !== "context" || blocks[1]?.kind !== "change") return;
	assert.equal(blocks[0].newLabel, "2 HJ");
	assert.equal(blocks[0].oldLine1, 2);
	assert.equal(blocks[1].pairs[0]?.before?.text, "export function add() {");
	assert.equal(blocks[1].pairs[0]?.after?.locationLabel, "3 MP");
	assert.equal(blocks[1].pairs[0]?.after?.text, "export function add() { /* updated */");
	assert.equal(parseNumbered(actual.replace("3#MP:", "3#M:")), undefined);
});

test("multiple known and located edits keep request order and aggregate results unassigned", () => {
	const request: RequestView = { kind: "change.replacements", requestedEdits: [
		{ path: "a", oldText: "old", newText: "new" },
		{ kind: "located", operation: "replace", path: "a", anchor: { token: "3#XY", line1: 3 }, newText: "replacement" },
		{ kind: "located", operation: "delete", path: "b", anchor: { token: "zaxuv" } },
	] };
	const result: ResultView = { parts: [{ kind: "diff", origin: "reported", representations: { numbered: "-1 old\n+1 new" } }] };
	const operations = buildOperationPresentation(request, buildDiffPresentation(request, result));
	assert.deepEqual(operations.items.map(item => item.kind === "edit" ? item.path : undefined), ["a", "a", "b"]);
	assert.equal(operations.remainder.units[0]?.origin, "reported");
	assert.ok(operations.items.every(item => item.kind === "edit" && item.diff.units[0]?.origin === "request"));
});

test("unknown file identities do not become fabricated file counts", () => {
	const request: RequestView = { kind: "change.replacements", requestedEdits: [
		{ path: "a", oldText: "old", newText: "new" },
		{ kind: "located", operation: "replace", path: "", anchor: { token: "dafox" }, newText: "replacement" },
	] };
	assert.equal(titleFacts("edit", request, undefined, true, false, false, false, true).target, undefined);
});

test("located preview preserves later line numbers wider than its starting anchor", () => {
  const request: RequestView = { kind: "change.replacements", requestedEdits: [{ kind: "located", operation: "replace", path: "a",
    anchor: { token: "9", line1: 9 }, newLines: Array.from({ length: 92 }, (_, index) => `line-${index}`) }] };
  const plan = buildDiffPresentation(request, undefined);
  for (const layout of ["unified", "split"] as const) {
    const lines = renderDiffPresentation(plan, 100, { layout, showHeadings: false });
    assert.ok(lines.some(line => /\b100\s+\+\s+line-91\b/.test(line)));
  }
});
