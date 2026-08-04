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

/**
 * A detailed marker result for callers that must distinguish definitive
 * absence/invalidity from a transient filesystem failure. Most UI callers only
 * need the nullable wrappers below; registry reconciliation needs all states so
 * an unreadable project is not mistaken for a deleted one.
 */
export type AgentProjectMarkerInspection =
  | { status: "valid"; marker: AgentProjectMarker }
  | { status: "absent" | "invalid" | "unreadable" };

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

/**
 * Resolve the fixed marker filename beneath the directory the user selected.
 * The folder picker deliberately accepts any absolute local directory, so the
 * selected directory itself is not confined to one application-owned root.
 * What we can and must prove is that the derived read stays inside that exact
 * directory rather than treating either input as a free-form file path.
 */
function resolveAgentProjectMarkerPath(dir: string): string | null {
  const resolvedDir = path.resolve(dir);
  const markerPath = path.resolve(resolvedDir, AGENT_PROJECT_MARKER);
  const relativeMarker = path.relative(resolvedDir, markerPath);
  if (
    !relativeMarker ||
    relativeMarker.startsWith(`..${path.sep}`) ||
    relativeMarker === ".." ||
    path.isAbsolute(relativeMarker)
  ) {
    return null;
  }
  return markerPath;
}

function markerReadErrorStatus(error: unknown): "absent" | "unreadable" {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
}

export function readAgentProjectMarkerSync(
  dir: string,
): AgentProjectMarker | null {
  try {
    const markerPath = resolveAgentProjectMarkerPath(dir);
    if (!markerPath) return null;
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null;
    return parseAgentProjectMarker(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

export async function readAgentProjectMarker(
  dir: string,
): Promise<AgentProjectMarker | null> {
  const result = await inspectAgentProjectMarker(dir);
  return result.status === "valid" ? result.marker : null;
}

export async function inspectAgentProjectMarker(
  dir: string,
): Promise<AgentProjectMarkerInspection> {
  const markerPath = resolveAgentProjectMarkerPath(dir);
  if (!markerPath) return { status: "invalid" };

  let markerStat: import("node:fs").Stats;
  try {
    markerStat = await fsp.lstat(markerPath);
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  }

  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    return { status: "invalid" };
  }

  try {
    const marker = parseAgentProjectMarker(
      await fsp.readFile(markerPath, "utf8"),
    );
    return marker ? { status: "valid", marker } : { status: "invalid" };
  } catch (error) {
    return { status: markerReadErrorStatus(error) };
  }
}
