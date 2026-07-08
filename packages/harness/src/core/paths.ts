/**
 * Small path helper shared across the harness's core modules (session
 * manager, adapters, analytics store): the contract (`src/shared/types.ts`)
 * expresses well-known paths with a leading `~`.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand a leading `~` (home directory) in a path, then resolve to absolute. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
