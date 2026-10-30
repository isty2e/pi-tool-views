import { appendFileSync } from "node:fs";

const root = process.env.PTV_TEST_ROOT;
if (!root) throw new Error("PTV_TEST_ROOT is required for native observation.");
const replay = process.env.PTV_TEST_REPLAY === "1";
const log = (event, data = {}) => appendFileSync(`${root}/events.jsonl`, JSON.stringify({ event, replay, pid: process.pid, ...data }) + "\n");

export default function observe(pi) {
  const byState = new WeakMap();
  const rows = new Set();
  let serial = 0;
  pi.registerToolRenderer((name, next) => {
    const native = next();
    if (!native) return native;
    if (!native.renderCall && !native.renderResult) return native;
    const wrap = (component, context, phase, theme) => {
      let row = byState.get(context.state);
      if (!row) { row = { id: context.toolCallId, name, serial: ++serial }; rows.add(row); byState.set(context.state, row); }
      row.invalidate = context.invalidate;
      return {
        render(width) {
          const lines = component.render(width);
          log("paint", { id: row.id, name, serial: row.serial, phase, width, lines,
            keyword: typeof theme.getFgAnsi === "function" ? theme.getFgAnsi("syntaxKeyword") : undefined });
          return lines;
        },
        invalidate() { component.invalidate(); },
        handleMouse(event) { return component.handleMouse?.(event); },
      };
    };
    return { ...native,
      ...(native.renderCall ? { renderCall(args, theme, context) { return wrap(native.renderCall(args, theme, context), context, "call", theme); } } : {}),
      ...(native.renderResult ? { renderResult(result, options, theme, context) { return wrap(native.renderResult(result, options, theme, context), context, "result", theme); } } : {}),
    };
  });
  pi.registerCommand("probe-inspect", { description: "Refresh only the isolated fixture views", handler(_args, ctx) {
    for (const row of rows) row.invalidate();
    log("inspect", { count: rows.size, source: ctx.sessionManager.getBranch().map(entry => entry.id) });
  } });
}
