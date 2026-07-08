/**
 * Small path helper shared across the harness's core modules (session
 * manager, adapters, analytics store): the contract (`src/shared/types.ts`)
 * expresses well-known paths with a leading `~`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { HARNESS_HOME, HARNESS_PATHS } from "../shared/types.js";

/** Expand a leading `~` (home directory) in a path, then resolve to absolute. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

/** Absolute locations of every piece of persistent harness state, all rooted
 *  under one directory. See resolveStatePaths(). */
export interface HarnessStatePaths {
  root: string;
  machineId: string;
  sessions: string;
  workflows: string;
  events: string;
  settings: string;
  generated: string;
  sampleProject: string;
}

/** The path of `entry` relative to HARNESS_HOME — HARNESS_PATHS expresses
 *  every well-known file as `${HARNESS_HOME}/<name>`, and deriving the name
 *  here (instead of repeating it) keeps HARNESS_PATHS the single source of
 *  truth for what the files are called. */
function relativeToHome(entry: string): string {
  return entry.slice(HARNESS_HOME.length + 1);
}

/**
 * Resolves the full set of persistent-state locations under a single root.
 * Defaults to the real HARNESS_HOME (`~/.sapiom/harness`) — the CLI's
 * behavior is unchanged — while tests and scripted checks pass a scratch
 * directory so a server boot can never touch the developer's real state.
 */
export function resolveStatePaths(stateRoot?: string): HarnessStatePaths {
  const root = expandHome(stateRoot ?? HARNESS_HOME);
  return {
    root,
    machineId: join(root, relativeToHome(HARNESS_PATHS.machineId)),
    sessions: join(root, relativeToHome(HARNESS_PATHS.sessions)),
    workflows: join(root, relativeToHome(HARNESS_PATHS.workflows)),
    events: join(root, relativeToHome(HARNESS_PATHS.events)),
    settings: join(root, relativeToHome(HARNESS_PATHS.settings)),
    generated: join(root, relativeToHome(HARNESS_PATHS.generated)),
    sampleProject: join(root, relativeToHome(HARNESS_PATHS.sampleProject)),
  };
}
