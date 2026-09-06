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

import { quotePathForTerminal } from "@shared/initial-prompt";
export { quotePathForTerminal };

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
