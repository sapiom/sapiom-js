/**
 * One discovery contract for Agent Studio's registry, live workspace watcher,
 * and folder picker. Keeping marker parsing and traversal policy here prevents
 * the three surfaces from disagreeing about whether a directory is an agent
 * project.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { AGENT_PROJECT_MARKER } from "../shared/types.js";

export const AGENT_PROJECT_SCAN_MAX_DEPTH = 3;

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".sapiom",
  "dist",
  "build",
  ".next",
]);

export interface AgentProjectMarker {
  definitionId?: number | null;
  /** The agent's `defineAgent({ name })`, cached by `link`. */
  name?: string;
}

export function isAgentProjectScanIgnoredDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name);
}

/** A marker is JSON whose top-level value is an object (including `{}`). */
export function parseAgentProjectMarker(
  raw: string,
): AgentProjectMarker | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as AgentProjectMarker;
  } catch {
    return null;
  }
}

export function readAgentProjectMarkerSync(
  dir: string,
): AgentProjectMarker | null {
  try {
    return parseAgentProjectMarker(
      fs.readFileSync(path.join(dir, AGENT_PROJECT_MARKER), "utf8"),
    );
  } catch {
    return null;
  }
}

export async function readAgentProjectMarker(
  dir: string,
): Promise<AgentProjectMarker | null> {
  try {
    return parseAgentProjectMarker(
      await fsp.readFile(path.join(dir, AGENT_PROJECT_MARKER), "utf8"),
    );
  } catch {
    return null;
  }
}
