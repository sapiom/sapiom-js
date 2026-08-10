/**
 * Bracketed paste (DEC private mode 2004) for programmatic prompt injection.
 *
 * `submitInput()` writes a prompt into a coding agent's pty and then a `\r` to
 * send it. Both halves are ambiguous to a TUI unless the paste is bracketed:
 *
 *   - A prompt with newlines in it (the canvas chat prepends a multi-line step
 *     context to every question) is a stream of `\n`s to the app. Ink — Claude
 *     Code's input layer — maps a bare `\n` to Return exactly like `\r`, so a
 *     raw write submits at the FIRST newline and the rest of the prompt lands
 *     as further half-prompts.
 *   - The trailing `\r` is only a "submit" keypress if the app has already
 *     stopped treating the write as pasted content. Its paste heuristic is a
 *     timing/size guess, so the same click can submit or sit in the composer
 *     depending on how busy the agent was — the reported inconsistency.
 *
 * With mode 2004 on, the app is told where pasted content starts and ends, so
 * newlines inside stay literal and the following `\r` is unambiguously a
 * keypress. The mode is only usable when the app turned it on, so
 * {@link trackBracketedPaste} reads that fact off the pty's own output rather
 * than assuming it: an app that never enables 2004 keeps the previous raw
 * behaviour instead of being fed escape sequences it would render as text.
 *
 * Pure — no I/O, no pty — so the parsing is unit-testable on strings.
 */

/** Start of pasted content (`ESC [ 200 ~`). */
export const PASTE_START = "\x1b[200~";
/** End of pasted content (`ESC [ 201 ~`). */
export const PASTE_END = "\x1b[201~";

/**
 * A DEC private mode set/reset: `ESC [ ? <params> h|l`, where params is a
 * `;`-separated list (apps commonly batch, e.g. `ESC[?1049;2004h`).
 */
// eslint-disable-next-line no-control-regex
const PRIVATE_MODE_RE = /\x1b\[\?([0-9;]*)([hl])/g;

/**
 * Longest prefix of a private-mode sequence worth carrying between chunks:
 * `ESC [ ? ` plus a params list. A pty chunk can split any escape sequence, so
 * a tail that could still grow into a mode set is re-scanned with the next
 * chunk instead of being dropped.
 */
const MAX_CARRY = 32;

/** Incremental scan state — see {@link trackBracketedPaste}. */
export interface BracketedPasteState {
  /** Whether the app currently has mode 2004 on. */
  enabled: boolean;
  /** Trailing bytes of the last chunk that may be an unfinished sequence. */
  carry: string;
}

export const initialBracketedPasteState: BracketedPasteState = { enabled: false, carry: "" };

/** The tail of `chunk` that could still grow into a private-mode sequence. */
function pendingCarry(chunk: string): string {
  const start = chunk.lastIndexOf("\x1b[?");
  if (start === -1) return "";
  const tail = chunk.slice(start);
  // A finished sequence (it has its final h/l) tells us nothing more.
  if (/[hl]/.test(tail)) return "";
  return tail.length > MAX_CARRY ? "" : tail;
}

/**
 * Fold one chunk of pty output into the running bracketed-paste mode state.
 * The LAST 2004 set/reset in the chunk wins, matching how the terminal itself
 * would apply them in order.
 */
export function trackBracketedPaste(
  state: BracketedPasteState,
  chunk: string,
): BracketedPasteState {
  const scanned = state.carry + chunk;
  let enabled = state.enabled;
  for (const match of scanned.matchAll(PRIVATE_MODE_RE)) {
    if (match[1]?.split(";").includes("2004")) enabled = match[2] === "h";
  }
  return { enabled, carry: pendingCarry(scanned) };
}

/**
 * Wrap `text` as bracketed pasted content.
 *
 * Any `ESC [ 201 ~` inside the text would end the paste early and hand the
 * remainder to the app as keystrokes, so it is dropped; `\r` is normalized to
 * `\n` because a carriage return inside a paste is what the app reads as
 * Return, which is precisely the premature submit this exists to prevent.
 */
export function wrapPaste(text: string): string {
  const body = text.split(PASTE_END).join("").replace(/\r\n?/g, "\n");
  return PASTE_START + body + PASTE_END;
}
