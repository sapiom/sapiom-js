/**
 * Small filesystem-path helper shared by the analytics pipeline modules.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Expand a leading `~` (or `~/...`) to the current user's home directory. */
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}
