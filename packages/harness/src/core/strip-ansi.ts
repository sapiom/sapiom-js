/**
 * Strip ANSI terminal-control sequences from a string so text pattern-matching
 * (blocking-prompt detection, an exited session's last-output tail) sees the
 * words a human would read rather than raw control bytes.
 *
 * Not exhaustive of every escape a TUI could emit, but covers what real
 * captures show in practice: OSC (window title), CSI (cursor moves, SGR
 * colour/style), and charset/keypad-mode selects. Lives here — rather than in
 * one adapter — because more than one consumer needs it (the Codex adapter's
 * trust-prompt detection and SessionManager's exit-tail sanitizer).
 */
export function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- matching literal ESC (\x1b) / BEL
   * (\x07) bytes is the entire point of an ANSI-sequence stripper; there's
   * no non-control-character way to express "a real escape sequence". */
  return (
    stripOsc(text)
      // Params are BOUNDED (`{0,64}`), not `*`: this runs on live pty
      // scrollback, so an unterminated run of parameter bytes after each of
      // many `ESC[` starts would otherwise re-scan the same tail per start —
      // quadratic on attacker-shaped output. A real CSI's parameters are a
      // handful of bytes; 64 is far beyond anything a TUI emits, so nothing
      // legitimate stops being stripped.
      .replace(/\x1b\[[0-9;?]{0,64}[a-zA-Z]/g, "") // CSI sequences
      .replace(/\x1b[()>=][A-Za-z0-9]?/g, "") // charset/keypad-mode selection
  );
  /* eslint-enable no-control-regex */
}

/**
 * Remove OSC sequences (`ESC ]` … terminated by BEL or ST) in ONE forward
 * pass.
 *
 * This was a regex — `/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g` — whose lazy scan
 * re-examines the rest of the string from every `ESC ]` that never finds a
 * terminator, i.e. O(n²) on input like `ESC ]` repeated. That only became
 * reachable when the claude-code adapter started matching blocking prompts
 * against live pty scrollback, which is agent-controlled data (CodeQL:
 * js/polynomial-redos). An index scan has no backtracking at all.
 *
 * Semantics are preserved exactly, including the reason the old pattern was
 * lazy: each OSC ends at its NEAREST terminator, so text between one
 * sequence and an unrelated later BEL/ST is never swallowed (a greedy match
 * once ate a whole multi-KB buffer, and with it the prompt being searched
 * for). An UNTERMINATED `ESC ]` is left in place, exactly as a non-matching
 * regex would.
 */
function stripOsc(text: string): string {
  const OSC_START = "\x1b]";
  let out = "";
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(OSC_START, cursor);
    if (start === -1) return out + text.slice(cursor);

    const bel = text.indexOf("\x07", start + OSC_START.length);
    const st = text.indexOf("\x1b\\", start + OSC_START.length);
    // Nearest terminator wins; -1 (absent) must never beat a real index.
    const useBel = bel !== -1 && (st === -1 || bel < st);
    const end = useBel ? bel : st;
    // Unterminated: this OSC start is ordinary text. Leave the remainder as
    // it is rather than dropping the tail of the buffer.
    if (end === -1) return out + text.slice(cursor);

    out += text.slice(cursor, start);
    cursor = end + (useBel ? 1 : 2);
  }
}
