export interface TerminalControl { readonly startUtf16: number; readonly endUtf16: number }

/** Identify controls in original coordinates, retaining short-escape fallback for incomplete strings. */
export function* terminalControls(text: string): Iterable<TerminalControl> {
  const candidates = /\x1b|\r\n?|\t|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
  const escape = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/y;
  let stringEnd = -1;
  for (let match = candidates.exec(text); match; match = candidates.exec(text)) {
    const startUtf16 = match.index;
    let endUtf16 = startUtf16 + match[0].length;
    if (match[0] === "\x1b") {
      const kind = text[startUtf16 + 1];
      if (kind === "P" || kind === "X" || kind === "^" || kind === "_") {
        // Reuse the next ST (or its absence) instead of searching every remaining suffix.
        if (stringEnd < startUtf16 + 2) {
          const next = text.indexOf("\x1b\\", startUtf16 + 2);
          stringEnd = next < 0 ? text.length : next;
        }
        endUtf16 = stringEnd < text.length ? stringEnd + 2 : startUtf16 + 2;
      } else {
        escape.lastIndex = startUtf16;
        const sequence = escape.exec(text);
        if (sequence) endUtf16 = startUtf16 + sequence[0].length;
      }
    }
    candidates.lastIndex = endUtf16;
    yield { startUtf16, endUtf16 };
  }
}
