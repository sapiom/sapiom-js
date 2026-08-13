/**
 * Drop-to-path for the terminal: what a native emulator does when a file lands
 * on it. iTerm2/Terminal.app/Windows Terminal all respond to a file drop by
 * typing the file's (quoted) path at the cursor; the agent CLI then does its
 * own thing with it — Claude Code recognizes a pasted image path and renders it
 * as `[Image #1]`. xterm.js has no such behavior (a browser's default for a
 * file drop is to NAVIGATE to it), so the Terminal component reproduces it:
 * resolve each dropped File to a real path via the desktop bridge and paste
 * the result into the pty.
 *
 * Pure text-shaping only, so it's testable in the Node runner: the DOM/bridge
 * halves live in Terminal.tsx.
 */

/**
 * Characters that survive unquoted in every consumer we care about. Includes
 * `\` and `:` so Windows paths (`C:\Users\…`) don't get quoted needlessly.
 */
const SAFE_PATH = /^[A-Za-z0-9_\-./~:\\]+$/;

/** A Windows absolute path (`C:\…` or `C:/…`). */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Quote a path the way a native terminal's drop does: leave safe paths bare,
 * double-quote anything with spaces or shell-special characters. Double quotes
 * rather than backslash-escaping because they read the same on POSIX and
 * Windows, and the agent CLIs accept both forms.
 *
 * Escaping inside the quotes is per-flavor: a Windows path is quoted verbatim
 * (`"` is not a legal filename character there, and escaping would corrupt the
 * backslash separators), while a POSIX path gets `\` and `"` backslash-escaped
 * so neither can terminate the quoting early.
 */
export function quotePathForTerminal(path: string): string {
  if (SAFE_PATH.test(path)) return path;
  if (WINDOWS_PATH.test(path)) return `"${path}"`;
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The text a drop types into the pty: each resolved path quoted, space
 * separated, plus a trailing space so the user can keep typing — exactly the
 * shape native emulators produce. Empty strings (a File the bridge couldn't
 * resolve) are skipped; null when nothing resolved, so the caller pastes
 * nothing at all rather than a lone space.
 */
export function dropPayload(paths: readonly string[]): string | null {
  const resolved = paths.filter((path) => path.length > 0);
  if (resolved.length === 0) return null;
  return resolved.map(quotePathForTerminal).join(" ") + " ";
}
