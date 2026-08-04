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
  return text
    // Lazy (`*?`), not greedy: a greedy `[^\x07]*` doesn't exclude `\x1b\\`
    // (ST) from what it can consume, so it backtracks from the END of the
    // whole string looking for the last reachable terminator instead of the
    // next one — silently swallowing everything (including real prompt
    // text) between an OSC sequence and some unrelated, much-later BEL/ST.
    // Confirmed against a real capture: this exact bug made the Codex trust-
    // prompt regex never match a full multi-KB scrollback buffer.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC ... BEL or ST
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") // CSI sequences
    .replace(/\x1b[()>=][A-Za-z0-9]?/g, ""); // charset/keypad-mode selection
  /* eslint-enable no-control-regex */
}
