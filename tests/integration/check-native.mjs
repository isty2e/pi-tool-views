import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Supply one isolated native case directory.");
const read = file => JSON.parse(readFileSync(join(root, file), "utf8"));
const fixture = read("case.json");
const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const plain = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const paints = replay => events.filter(event => event.event === "paint" && event.replay === replay);
const latest = (rows, id, phase) => {
  const views = new Map();
  for (const row of rows.filter(row => row.id === id && row.phase === phase)) views.set(row.serial, plain(row.lines.join("\n")));
  return [...views.values()];
};

for (const phase of ["live", "replay"]) {
  const driver = read(`${phase}-driver.json`);
  assert.equal(driver.exit, 0);
  assert.equal(driver.failure, null);
  assert.equal(driver.stage, 30);
}
assert.equal(events.filter(event => event.replay && ["provider", "execute", "execution-start"].includes(event.event)).length, 0);

if (fixture.scenario === "normal") {
  assert.equal(read("live-driver.json").preapprovalSiblingPreview, true);
  assert.equal(events.filter(event => !event.replay && event.event === "execution-end" && event.id === "edit-success" && !event.error).length, 2);
  assert.equal(events.filter(event => !event.replay && event.event === "execution-end" && event.id === "edit-failure" && event.error).length, 2);
  assert.match(readFileSync(join(root, "workspace/source.ts"), "utf8"), /^const value = 3;/);
  assert.ok(!readFileSync(join(root, "workspace/source.ts"), "utf8").includes("UNAPPLIED_REQUEST"));
  for (const replay of [false, true]) {
    const rows = paints(replay);
    for (const id of ["edit-success", "edit-failure", "patch", "echo", "code", "read"]) assert.equal(latest(rows, id, "call").length, 2);
    for (const value of latest(rows, "edit-success", "call")) {
      assert.equal(value.split("Reported changes").length - 1, 1);
      assert.ok(!value.includes("Requested changes"));
    }
    const suppliedSuccess = readFileSync(join(root, "sessions/native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === "edit-success")
      .flatMap(entry => entry.message.content.filter(part => part.type === "text").map(part => part.text));
    for (const value of latest(rows, "edit-success", "result")) {
      assert.ok(suppliedSuccess.some(text => value.replace(/\s/g, "").includes(text.replace(/\s/g, ""))));
    }
    for (const value of latest(rows, "edit-failure", "call")) {
      assert.ok(value.includes("Requested changes") && value.includes("UNAPPLIED_REQUEST SAFE_MARKER"));
    }
    for (const value of latest(rows, "patch", "call")) {
      const diff = value.slice(value.indexOf("Reported changes"));
      assert.ok(diff.includes("456_REPORTED"));
      assert.ok(!diff.includes("123_SAFE_MARKER"));
      assert.equal(value.split("Reported changes").length - 1, 1);
    }
    for (const value of latest(rows, "echo", "call")) assert.ok(value.includes("SAFE_MARKER") && !value.includes("RAW_MARKER"));
    for (const value of latest(rows, "echo", "result")) assert.ok(value.includes("FINAL_RESULT") && !value.includes("EARLY_RESULT"));
    for (const value of latest(rows, "code", "call")) assert.ok(!value.includes("first();") && value.includes("[Show source]"));
    for (const value of latest(rows, "code", "result")) {
      assert.ok(value.includes("output 0") && !value.includes("output 20"));
      assert.equal(value.split("\n").filter(line => !/^─+$/.test(line)).length, 7);
      assert.equal(value.split("\n").filter(line => /^─+$/.test(line)).length, 1);
    }
    for (const value of latest(rows, "read", "result")) assert.match(value, /1 const value = \d;/);
    if (fixture.theme) {
      const readViews = new Map();
      for (const row of rows.filter(row => row.id === "read" && row.phase === "result")) readViews.set(row.serial, row);
      for (const row of readViews.values()) assert.ok(row.lines.some(line => line.includes(`${row.keyword}const`)));
    }
  }
  const native = events.filter(event => event.event === "native-call");
  assert.ok(native.length >= 2);
  for (const event of native) {
    assert.deepEqual(event.args, event.contextArgs);
    assert.ok(JSON.stringify(event.args).includes("SAFE_MARKER"));
    assert.ok(!JSON.stringify(event.args).includes("RAW_MARKER"));
  }
  const settings = read("workspace/.pi/tool-views.json");
  assert.equal(settings.titleMode, "tool");
  assert.equal(settings.diffMode, "split");
} else if (fixture.scenario === "image") {
  for (const replay of [false, true]) {
    const rows = paints(replay);
    const call = latest(rows, "image", "call");
    const result = latest(rows, "image", "result");
    assert.equal(call.length, 1);
    assert.equal(result.length, 1);
    assert.equal(call[0].split("\n").filter(line => /^─+$/.test(line)).length, 1);
    assert.equal(result[0].split("\n").filter(line => /^─+$/.test(line)).length, 0);
    assert.ok(result[0].includes("caption 0") && !result[0].includes("caption 20"));
    assert.equal(result[0].split("\n").length, 7);
    assert.ok(readFileSync(join(root, replay ? "replay.pty" : "live.pty"), "utf8").includes("\x1b_G"));
    if (fixture.inspect) {
      assert.equal(read(`${replay ? "replay" : "live"}-driver.json`).inspected, true);
      assert.ok(readFileSync(join(root, replay ? "replay.pty" : "live.pty"), "utf8").includes("caption 23"));
    }
  }
  const entries = readFileSync(join(root, "sessions/native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const images = entries.filter(entry => entry.message?.role === "toolResult").flatMap(entry => entry.message.content).filter(part => part.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
} else {
  assert.ok(["length", "abort"].includes(fixture.scenario));
  assert.equal(readFileSync(join(root, "workspace/source.ts"), "utf8"), "const value = 1;\n");
  const sessions = readFileSync(join(root, "sessions/native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const reason = fixture.scenario === "length" ? "length" : "aborted";
  assert.ok(sessions.some(entry => entry.message?.role === "assistant" && entry.message.stopReason === reason));
  for (const replay of [false, true]) {
    const calls = latest(paints(replay), "unfinished", "call");
    assert.equal(calls.length, 1);
    assert.ok(calls.every(text => !text.includes("Requested changes") && !text.includes("Diff:")));
  }
}
console.log(JSON.stringify({ host: fixture.host, scenario: fixture.scenario, assertions: "passed" }));
