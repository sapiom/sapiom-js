/**
 * Workflow registry (workstream W2's backend slice).
 *
 * Discovers orchestration projects by scanning a directory tree (bounded by
 * depth, by directories visited, and by the scan root's own repository) for
 * `sapiom.json` marker files, tracks
 * manually-connected paths, and persists the combined list to
 * HARNESS_PATHS.workflows. Exposes an
 * Express router implementing the /api/workflows surface from
 * src/shared/types.ts; the integrator mounts it (and express.json()) on the
 * shared app.
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";

import {
  HARNESS_PATHS,
  type WorkflowInfo as PublicWorkflowInfo,
} from "../shared/types.js";
import {
  type AgentProjectMarker,
  type AgentProjectMarkerInspection,
  AgentProjectScanBudget,
  type AgentProjectWalkAction,
  type AgentProjectWalkOptions,
  inspectAgentProjectMarker,
  isAgentProjectScanIgnoredDir,
  walkAgentProjectTreeAsync,
} from "./agent-project-discovery.js";
import {
  AGENT_SOURCE_ENTRYPOINT,
  AgentSourceDiscovery,
  AgentSourceScanBudget,
} from "./agent-source-discovery.js";
import { rememberCanonicalGraphPath } from "./canonical-graph-path.js";
import { hasTraversalSegment, resolveWithinRoot } from "./path-safety.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/"))
    return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

const REGISTRY_FS_CONCURRENCY = 16;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;

async function mapBounded<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
  concurrency = REGISTRY_FS_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function sameFileSnapshot(
  left: import("node:fs").Stats,
  right: import("node:fs").Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function safeDisplayName(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    value.trim() &&
    !hasControlCharacter(value)
    ? value.trim()
    : fallback;
}

function safeDefinitionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    hasControlCharacter(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("local:") ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    return null;
  }
  return normalized;
}

function safeOpaqueString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && !hasControlCharacter(normalized) ? normalized : null;
}

function safeDefinitionId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normalizedMarkerFields(
  marker: AgentProjectMarker,
): Pick<
  WorkflowInfo,
  | "definitionId"
  | "definitionSlug"
  | "templateId"
  | "forkId"
  | "starterId"
  | "markerPresent"
> {
  const untrusted = marker as Record<string, unknown>;
  return {
    definitionId: safeDefinitionId(untrusted.definitionId),
    definitionSlug: safeDefinitionName(untrusted.name),
    templateId: safeOpaqueString(untrusted.templateId),
    forkId: safeOpaqueString(untrusted.forkId),
    starterId: safeOpaqueString(untrusted.starterId),
    markerPresent: true,
  };
}

// `dir` reaching these sinks is always a resolved absolute path (from
// path.resolve in scan/connectPath, or a confined descent in the scan walk),
// so a
// `..` segment can never survive. Asserting it anyway keeps the no-traversal
// guarantee explicit and local to each fs read, and covers the arbitrary
// path connectPath accepts (which has no scan root to confine it to).

async function inspectMarker(
  dir: string,
): Promise<AgentProjectMarkerInspection> {
  if (hasTraversalSegment(dir)) return { status: "invalid" };
  return inspectAgentProjectMarker(dir);
}

async function nameFor(dir: string): Promise<string> {
  const fallback = path.basename(dir);
  if (hasTraversalSegment(dir)) return fallback;
  const packagePath = path.join(dir, "package.json");
  try {
    const initialDirectory = await fs.lstat(dir);
    if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink()) {
      return fallback;
    }
    const canonicalDirectoryPath = await fs.realpath(dir);
    const initial = await fs.lstat(packagePath);
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      initial.size > PACKAGE_JSON_MAX_BYTES
    ) {
      return fallback;
    }
    const handle = await fs.open(
      packagePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    let raw: string;
    try {
      const opened = await handle.stat();
      const beforeReadDirectory = await fs.lstat(dir);
      const beforeReadCanonicalDirectory = await fs.realpath(dir);
      const beforeReadPath = await fs.lstat(packagePath);
      if (
        !opened.isFile() ||
        !sameFileSnapshot(opened, initial) ||
        beforeReadDirectory.isSymbolicLink() ||
        !beforeReadDirectory.isDirectory() ||
        !sameFileSnapshot(beforeReadDirectory, initialDirectory) ||
        beforeReadCanonicalDirectory !== canonicalDirectoryPath ||
        beforeReadPath.isSymbolicLink() ||
        !beforeReadPath.isFile() ||
        !sameFileSnapshot(beforeReadPath, initial)
      ) {
        return fallback;
      }
      const bytes = Buffer.alloc(initial.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const finalHandle = await handle.stat();
      const finalPath = await fs.lstat(packagePath);
      if (
        finalPath.isSymbolicLink() ||
        !finalPath.isFile() ||
        !sameFileSnapshot(opened, initial) ||
        !sameFileSnapshot(finalHandle, initial) ||
        !sameFileSnapshot(finalPath, initial) ||
        offset !== initial.size
      ) {
        return fallback;
      }
      raw = bytes.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
    const pkg = JSON.parse(raw) as { name?: unknown };
    return safeDisplayName(pkg.name, fallback);
  } catch {
    // No package.json (or it doesn't parse) — fall back to the directory name.
  }
  return fallback;
}

type CanonicalDirectoryEvidence =
  | { status: "resolved"; key: string }
  | { status: "missing"; key: string }
  | { status: "unreadable"; key: string };

async function canonicalDirectoryEvidence(
  input: string,
): Promise<CanonicalDirectoryEvidence> {
  const absolute = path.resolve(input);
  try {
    const key = await fs.realpath(absolute);
    rememberCanonicalGraphPath(absolute, key);
    return { status: "resolved", key };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status:
        code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      key: absolute,
    };
  }
}

async function canonicalDirectory(input: string): Promise<string> {
  return (await canonicalDirectoryEvidence(input)).key;
}

function hasSourceDiscoveryEvidence(workflow: WorkflowInfo): boolean {
  return Object.prototype.hasOwnProperty.call(workflow, "sourceDefinitionName");
}

function workflowEvidenceScore(workflow: WorkflowInfo): number {
  return (
    (workflow.source === "connect" ? 64 : 0) +
    (workflow.definitionId !== null ? 16 : 0) +
    (workflow.definitionSlug !== null ? 8 : 0) +
    (workflow.templateId ? 4 : 0) +
    (workflow.forkId ? 2 : 0) +
    (workflow.starterId ? 2 : 0) +
    (workflow.activeBuildRunId ? 2 : 0) +
    (hasSourceDiscoveryEvidence(workflow) ? 1 : 0)
  );
}

function compareWorkflowEvidence(
  left: WorkflowInfo,
  right: WorkflowInfo,
): number {
  return (
    workflowEvidenceScore(right) - workflowEvidenceScore(left) ||
    compareText(left.path, right.path) ||
    compareText(left.name, right.name)
  );
}

function workflowRowsEqual(
  left: readonly WorkflowInfo[],
  right: readonly WorkflowInfo[],
): boolean {
  if (left.length !== right.length) return false;
  const key = (workflow: WorkflowInfo): string =>
    JSON.stringify({
      path: workflow.path,
      name: workflow.name,
      definitionId: workflow.definitionId,
      definitionSlug: workflow.definitionSlug,
      sourceDefinitionName: hasSourceDiscoveryEvidence(workflow)
        ? [true, workflow.sourceDefinitionName ?? null]
        : [false],
      markerPresent: workflow.markerPresent === true,
      activeBuildRunId: workflow.activeBuildRunId ?? null,
      activeBuildRunStatus: workflow.activeBuildRunStatus ?? null,
      templateId: workflow.templateId ?? null,
      forkId: workflow.forkId ?? null,
      starterId: workflow.starterId ?? null,
      source: workflow.source,
    });
  return left.every((workflow, index) => key(workflow) === key(right[index]!));
}

function statusMapsEqual(
  left: ReadonlyMap<string, "complete" | "degraded">,
  right: ReadonlyMap<string, "complete" | "degraded">,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([root, status]) => right.get(root) === status)
  );
}

function evidenceMapsEqual(
  left: ReadonlyMap<string, WorkflowIdentityEvidence>,
  right: ReadonlyMap<string, WorkflowIdentityEvidence>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([root, evidence]) => right.get(root) === evidence)
  );
}

interface StoredSourceObservation {
  candidateRoot: string;
  workspaceRoot: string;
  paths: readonly string[];
}

function sourceObservationKey(
  workspaceRoot: string,
  candidateRoot: string,
): string {
  return JSON.stringify([workspaceRoot, candidateRoot]);
}

function observationMapsEqual(
  left: ReadonlyMap<string, StoredSourceObservation>,
  right: ReadonlyMap<string, StoredSourceObservation>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(
      ([root, observations]) =>
        JSON.stringify(observations) === JSON.stringify(right.get(root)),
    )
  );
}

function mergeLoadedEvidence(
  preferred: WorkflowInfo,
  fallback: WorkflowInfo,
): WorkflowInfo {
  const merged: WorkflowInfo = {
    ...preferred,
    source:
      preferred.source === "connect" || fallback.source === "connect"
        ? "connect"
        : "scan",
    definitionId: preferred.definitionId ?? fallback.definitionId,
    definitionSlug: preferred.definitionSlug ?? fallback.definitionSlug,
    templateId: preferred.templateId ?? fallback.templateId,
    forkId: preferred.forkId ?? fallback.forkId,
    starterId: preferred.starterId ?? fallback.starterId,
    activeBuildRunId:
      preferred.activeBuildRunId ?? fallback.activeBuildRunId ?? null,
    activeBuildRunStatus:
      preferred.activeBuildRunStatus ?? fallback.activeBuildRunStatus ?? null,
  };
  if (preferred.markerPresent === true || fallback.markerPresent === true) {
    merged.markerPresent = true;
  } else {
    delete merged.markerPresent;
  }
  const sourceName =
    (hasSourceDiscoveryEvidence(preferred)
      ? preferred.sourceDefinitionName
      : undefined) ??
    (hasSourceDiscoveryEvidence(fallback)
      ? (fallback.sourceDefinitionName ?? null)
      : hasSourceDiscoveryEvidence(preferred)
        ? null
        : undefined);
  if (sourceName !== undefined) {
    merged.sourceDefinitionName = sourceName;
  } else {
    delete merged.sourceDefinitionName;
  }
  return merged;
}

async function normalizeLoadedWorkflows(
  workflows: WorkflowInfo[],
): Promise<WorkflowInfo[]> {
  const candidates = workflows.filter(
    (workflow) =>
      workflow &&
      typeof workflow.path === "string" &&
      path.isAbsolute(workflow.path),
  );
  const normalized = await mapBounded(candidates, async (workflow) => {
    const absolutePath = path.resolve(workflow.path);
    const normalizedWorkflow: WorkflowInfo = {
      name: safeDisplayName(workflow.name, path.basename(absolutePath)),
      path: absolutePath,
      definitionId: safeDefinitionId(workflow.definitionId),
      definitionSlug: safeDefinitionName(workflow.definitionSlug),
      templateId: safeOpaqueString(workflow.templateId),
      forkId: safeOpaqueString(workflow.forkId),
      starterId: safeOpaqueString(workflow.starterId),
      source: workflow.source === "connect" ? "connect" : "scan",
    };
    if (workflow.markerPresent === true)
      normalizedWorkflow.markerPresent = true;
    if (Object.prototype.hasOwnProperty.call(workflow, "activeBuildRunId")) {
      normalizedWorkflow.activeBuildRunId = safeOpaqueString(
        workflow.activeBuildRunId,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(workflow, "activeBuildRunStatus")
    ) {
      normalizedWorkflow.activeBuildRunStatus = safeOpaqueString(
        workflow.activeBuildRunStatus,
      );
    }
    if (hasSourceDiscoveryEvidence(workflow)) {
      normalizedWorkflow.sourceDefinitionName = safeDefinitionName(
        workflow.sourceDefinitionName,
      );
    }
    return {
      workflow: normalizedWorkflow,
      canonicalKey: await canonicalDirectory(absolutePath),
    };
  });
  normalized.sort((left, right) =>
    compareWorkflowEvidence(left.workflow, right.workflow),
  );
  const byPath = new Map<string, WorkflowInfo>();
  for (const { workflow, canonicalKey } of normalized) {
    const existing = byPath.get(canonicalKey);
    if (!existing) {
      byPath.set(canonicalKey, workflow);
      continue;
    }
    byPath.set(canonicalKey, mergeLoadedEvidence(existing, workflow));
  }
  return [...byPath.values()].sort((left, right) =>
    compareText(left.path, right.path),
  );
}

function mergeScannedWorkflow(
  existing: WorkflowInfo | undefined,
  discovered: WorkflowInfo,
): WorkflowInfo {
  if (!existing) return discovered;
  if (hasSourceDiscoveryEvidence(discovered)) {
    if (existing.source === "connect") {
      const connected = {
        ...existing,
        name: discovered.name,
      };
      connected.sourceDefinitionName = discovered.sourceDefinitionName ?? null;
      delete connected.markerPresent;
      return connected;
    }
    return { ...discovered, path: existing.path };
  }
  if (existing.source === "connect") {
    const connected = {
      ...existing,
      name: discovered.name,
      definitionId: existing.definitionId ?? discovered.definitionId,
      definitionSlug: existing.definitionSlug ?? discovered.definitionSlug,
      templateId: existing.templateId ?? discovered.templateId,
      forkId: existing.forkId ?? discovered.forkId,
      starterId: existing.starterId ?? discovered.starterId,
      markerPresent: true as const,
    };
    delete connected.sourceDefinitionName;
    return connected;
  }
  const markerRefreshed = {
    ...existing,
    ...discovered,
    path: existing.path,
    source: existing.source,
  };
  delete markerRefreshed.sourceDefinitionName;
  return markerRefreshed;
}

/** What one scan of a root turned up, and how far it can be trusted. */
export interface AgentProjectScanResult {
  /** Projects discovered on this pass. */
  found: WorkflowInfo[];
  /** Subtrees left opaque by a transient filesystem error. */
  unreconciledRoots: string[];
  /** Existing entrypoints proven to export no supported agent definition. */
  notAgentRoots: string[];
  /** Symlink entries the no-follow policy deliberately left opaque. */
  opaqueRoots: string[];
  /**
   * Valid marker/source projects whose descendants were deliberately not
   * traversed. The project root itself is proven, but everything below it is
   * outside this scan's reconciliation envelope.
   */
  discoveredStopRoots: string[];
  /** Bounded analyzer path observations, including deterministic absences. */
  sourceObservations: readonly {
    candidateRoot: string;
    workspaceRoot: string;
    paths: readonly string[];
  }[];
  /**
   * Nested repository checkouts the walk declined to enter (see
   * {@link isForeignRepositoryRoot}). A scan that comes back short is then able
   * to say WHY it came back short, which is the difference between "there are
   * no agents there" and "there is another repo there and you did not ask for
   * it". The server logs the count on every scan.
   */
  repositoryBoundaries: string[];
  /** The traversal allowance this scan spent — `visited`, `envelopeDepth`. */
  budget: AgentProjectScanBudget;
  /** Syntax modules charged even on an LRU hit. */
  sourceBudget: AgentSourceScanBudget;
  /** False when any source candidate or the shared source budget was incomplete. */
  sourceDiscoveryComplete: boolean;
}

/**
 * Scans `root` for agent projects, bounded by depth, by directories visited,
 * AND by the repository the root belongs to (core/agent-project-discovery.ts
 * owns that policy and the numbers behind it). A directory carrying a marker is
 * registered and not descended into; a directory that is a repository checkout
 * of its own is reported as a boundary and not descended into either, so one
 * scan registers one project tree rather than every neighbouring clone.
 *
 * Every directory touched is confined to `root` (the tree the caller asked to
 * scan): the walk starts at `root` itself and only ever descends into a direct
 * child, so no crafted entry name can walk the scan outside `root` — and
 * `resolveWithinRoot` re-asserts that at the sink, local to each fs read.
 * Symlinked entries report `isDirectory() === false` (withFileTypes uses raw
 * dirent info, not a followed stat) and so are never descended into either,
 * which is what makes a symlink cycle terminate.
 *
 * Exported so the perf benchmark can measure the real scanner against an
 * explicit budget rather than a copy of its traversal.
 */
export async function scanAgentProjects(
  root: string,
  budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  options: AgentProjectWalkOptions = {},
  sourceDiscovery: AgentSourceDiscovery = new AgentSourceDiscovery(),
  sourceBudget: AgentSourceScanBudget = new AgentSourceScanBudget(),
): Promise<AgentProjectScanResult> {
  const absoluteRoot = path.resolve(root);
  const found: WorkflowInfo[] = [];
  const unreconciledRoots: string[] = [];
  const notAgentRoots: string[] = [];
  const opaqueRoots: string[] = [];
  const discoveredStopRoots: string[] = [];
  const sourceObservations: Array<{
    candidateRoot: string;
    workspaceRoot: string;
    paths: readonly string[];
  }> = [];
  const repositoryBoundaries: string[] = [];
  let sourceDiscoveryComplete = true;

  const onDirectory = async (dir: string): Promise<AgentProjectWalkAction> => {
    const safeDir = resolveWithinRoot(absoluteRoot, dir);
    if (!safeDir) return "stop";

    const markerResult = await inspectMarker(safeDir);
    if (markerResult.status === "valid") {
      const marker = markerResult.marker;
      found.push({
        name: await nameFor(safeDir),
        path: safeDir,
        ...normalizedMarkerFields(marker),
        source: "scan",
      });
      discoveredStopRoots.push(safeDir);
      return "stop";
    }
    if (markerResult.status === "unreadable") {
      // The directory may still be a valid project. Treat the whole subtree as
      // opaque for this pass so a transient filesystem error neither removes an
      // existing entry nor discovers children that should be hidden beneath it.
      unreconciledRoots.push(safeDir);
      return "stop";
    }
    return "descend";
  };

  await walkAgentProjectTreeAsync(
    absoluteRoot,
    {
      onDirectory,
      onAdmittedDirectory: async (dir, _depth, entries) => {
        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            opaqueRoots.push(path.join(dir, entry.name));
          }
        }
        const entry = entries.find(
          (candidate) => candidate.name === AGENT_SOURCE_ENTRYPOINT,
        );
        if (!entry) return "descend";
        const safeDir = resolveWithinRoot(absoluteRoot, dir);
        if (!safeDir) return "stop";
        let result;
        try {
          result = await sourceDiscovery.inspectCandidate(
            safeDir,
            sourceBudget,
            absoluteRoot,
          );
        } catch {
          sourceDiscoveryComplete = false;
          unreconciledRoots.push(safeDir);
          return "descend";
        }
        sourceObservations.push({
          candidateRoot: safeDir,
          workspaceRoot: absoluteRoot,
          paths: result.watchPaths,
        });
        if (result.status === "agent") {
          found.push({
            name: await nameFor(safeDir),
            path: safeDir,
            definitionId: null,
            definitionSlug: null,
            sourceDefinitionName: safeDefinitionName(result.name),
            activeBuildRunId: null,
            activeBuildRunStatus: null,
            templateId: null,
            forkId: null,
            starterId: null,
            source: "scan",
          });
          discoveredStopRoots.push(safeDir);
          return "stop";
        }
        if (result.status === "incomplete") {
          sourceDiscoveryComplete = false;
          unreconciledRoots.push(safeDir);
          return "descend";
        }
        if (result.status === "not-agent") notAgentRoots.push(safeDir);
        return "descend";
      },
      onUnreadable: (dir) => unreconciledRoots.push(dir),
      onRepositoryBoundary: (dir) => {
        repositoryBoundaries.push(dir);
        // Also onto the budget, so a caller that only holds the budget (the
        // server's scan wrapper) can explain an empty result.
        budget.repositoryBoundaries.push(dir);
      },
    },
    budget,
    options,
  );
  sourceDiscoveryComplete &&= !sourceBudget.truncated;
  return {
    found,
    unreconciledRoots,
    notAgentRoots,
    opaqueRoots,
    discoveredStopRoots,
    sourceObservations,
    repositoryBoundaries,
    budget,
    sourceBudget,
    sourceDiscoveryComplete,
  };
}

/**
 * Whether a previously scanned path is inside the exact traversal envelope of
 * a new scan. Only those entries may be reconciled away when their marker is no
 * longer found; a narrow scan must never delete projects discovered from a
 * different root.
 *
 * `envelopeDepth` is the scan's own report of how deep it got, not the static
 * cap: a scan the node budget cut short covered fewer levels than it was
 * allowed to, and reconciling at the allowance would delete rows it simply
 * never looked for. The walk is breadth-first, so every level at or above
 * `envelopeDepth` is complete and safe to reconcile.
 */
function isCoveredByScan(
  root: string,
  candidate: string,
  envelopeDepth: number,
): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  const segments = relative.split(path.sep).filter(Boolean);
  return (
    segments.length <= envelopeDepth &&
    !segments.some((segment) => isAgentProjectScanIgnoredDir(segment))
  );
}

function isProtectedByIncompleteScan(
  candidate: string,
  unreconciledRoots: string[],
): boolean {
  return unreconciledRoots.some(
    (unreconciledRoot) =>
      resolveWithinRoot(unreconciledRoot, candidate) !== null,
  );
}

function isStrictlyBelowRoot(root: string, candidate: string): boolean {
  const confined = resolveWithinRoot(root, candidate);
  return confined !== null && path.resolve(confined) !== path.resolve(root);
}

/** Fresh, process-local proof controlling legacy source inspection. */
export type WorkflowIdentityEvidence =
  | "marker"
  | "source"
  | "not-agent"
  | "unknown";

/** Registry-only syntax/marker evidence. Never serialize this row directly. */
export interface RegistryWorkflowInfo extends PublicWorkflowInfo {
  sourceDefinitionName?: string | null;
  markerPresent?: true;
}

type WorkflowInfo = RegistryWorkflowInfo;

export interface WorkflowRegistryScanResult {
  found: WorkflowInfo[];
  repositoryBoundaries: string[];
  budget: AgentProjectScanBudget;
  sourceBudget: AgentSourceScanBudget;
  status: "complete" | "degraded";
  changed: boolean;
  generation: number;
}

/**
 * How often {@link WorkflowRegistry.list} re-checks that every registered path
 * still exists. Round 1's note claimed the registry "prunes lazily"; it did
 * not — pruning only happened where a caller remembered to ask (server boot, a
 * session's workspace rescan, an agent move), so a deleted agent stayed on the
 * rail until one of those happened to run. This interval is what makes the
 * claim true: one `stat` per entry, at most this often, on any read.
 */
const LAZY_PRUNE_INTERVAL_MS = 30_000;

/**
 * Splits entries into "path still there" and "path confirmed gone". Only
 * ENOENT/ENOTDIR counts as gone: an unbuilt, unreadable or momentarily
 * unstattable directory is kept, because losing a real project to a transient
 * filesystem error is far worse than carrying a dead row for one more sweep.
 */
async function partitionByPathExists(
  workflows: WorkflowInfo[],
): Promise<{ kept: WorkflowInfo[]; pruned: WorkflowInfo[] }> {
  const kept: WorkflowInfo[] = [];
  const pruned: WorkflowInfo[] = [];
  for (const workflow of workflows) {
    try {
      await fs.stat(workflow.path);
      kept.push(workflow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") pruned.push(workflow);
      else kept.push(workflow);
    }
  }
  return { kept, pruned };
}

function removeEntriesWithinRoots<T>(
  entries: Map<string, T>,
  roots: readonly string[],
): void {
  for (const entryRoot of entries.keys()) {
    if (roots.some((root) => resolveWithinRoot(root, entryRoot) !== null)) {
      entries.delete(entryRoot);
    }
  }
}

export class WorkflowRegistry {
  private workflows: WorkflowInfo[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** Serializes mutations so concurrent prune/scan/connectPath calls can't
   *  interleave and drop entries from the persisted file. Mirrors the pattern
   *  used by SessionManager.persist() (session-manager.ts:278,851-853). */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Epoch ms of the last confirmed-missing sweep — see LAZY_PRUNE_INTERVAL_MS. */
  private lastPruneAt = 0;
  private readonly discoveryStatusByRoot = new Map<
    string,
    "complete" | "degraded"
  >();
  private readonly canonicalScopeByLexicalRoot = new Map<string, string>();
  private readonly canonicalWorkflowRootByPath = new Map<string, string>();
  private readonly identityEvidenceByCanonicalRoot = new Map<
    string,
    WorkflowIdentityEvidence
  >();
  private readonly sourceObservationsByCanonicalRoot = new Map<
    string,
    StoredSourceObservation
  >();
  private inventoryGeneration = 0;
  private discoveryEpoch = 0;
  private discoveryLifetime = 0;
  private retired = false;
  private activeRename: Promise<void> | null = null;
  /** A failed compensating write leaves disk behind the accepted in-memory
   *  snapshot. The next otherwise-no-op scan must still repair the file. */
  private persistedSnapshotOutOfSync = false;
  private readonly dirtyEpochByCanonicalRoot = new Map<string, number>();

  private cachedRootsForRows(rows: readonly WorkflowInfo[]): string[] {
    return rows.map(
      (workflow) =>
        this.canonicalWorkflowRootByPath.get(workflow.path) ??
        path.resolve(workflow.path),
    );
  }

  private removePrivateStateForRows(rows: readonly WorkflowInfo[]): void {
    if (rows.length === 0) return;
    const removedRoots = this.cachedRootsForRows(rows);
    for (const workflow of rows) {
      this.canonicalWorkflowRootByPath.delete(workflow.path);
      this.canonicalScopeByLexicalRoot.delete(path.resolve(workflow.path));
    }
    removeEntriesWithinRoots(
      this.identityEvidenceByCanonicalRoot,
      removedRoots,
    );
    for (const [key, observation] of this.sourceObservationsByCanonicalRoot) {
      if (
        removedRoots.some(
          (root) => resolveWithinRoot(root, observation.candidateRoot) !== null,
        )
      ) {
        this.sourceObservationsByCanonicalRoot.delete(key);
      }
    }
    removeEntriesWithinRoots(this.discoveryStatusByRoot, removedRoots);
    removeEntriesWithinRoots(this.dirtyEpochByCanonicalRoot, removedRoots);
  }

  constructor(
    private readonly registryPath: string = expandHome(HARNESS_PATHS.workflows),
    private readonly sourceDiscovery: AgentSourceDiscovery = new AgentSourceDiscovery(),
    private readonly persistenceTestHooks: {
      afterPrimaryRename?: () => void | Promise<void>;
    } = {},
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.registryPath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            this.workflows = await normalizeLoadedWorkflows(
              parsed as WorkflowInfo[],
            );
          } else {
            this.workflows = [];
            this.persistedSnapshotOutOfSync = true;
          }
        } catch {
          this.workflows = [];
          // Preserve the historical durability contract: even an empty first
          // scan creates a valid workflows.json. Treat a missing/corrupt file
          // as disk being behind the accepted empty in-memory snapshot so the
          // next scan repairs it despite rowsChanged=false.
          this.persistedSnapshotOutOfSync = true;
        }
        const canonicalRoots = await mapBounded(this.workflows, (workflow) =>
          canonicalDirectory(workflow.path),
        );
        this.canonicalWorkflowRootByPath.clear();
        for (const [index, workflow] of this.workflows.entries()) {
          this.canonicalWorkflowRootByPath.set(
            workflow.path,
            canonicalRoots[index] ?? workflow.path,
          );
        }
        this.loaded = true;
      })().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  private async persist(
    workflows: readonly WorkflowInfo[] = this.workflows,
    isCurrent?: () => boolean,
  ): Promise<void> {
    const acceptedBeforeWrite = this.workflows;
    await this.writeSnapshot(workflows, true, isCurrent);
    const superseded = this.retired || (isCurrent && !isCurrent());
    if (!superseded) {
      this.persistedSnapshotOutOfSync = false;
      return;
    }

    // The generation can change while rename(2) is in flight. At that point
    // the proposed rows are durable but the caller must not commit them to
    // memory. Restore the last accepted snapshot before returning the
    // supersession error; otherwise a later no-op recovery scan would leave
    // workflows.json containing rows that were never atomically published.
    this.persistedSnapshotOutOfSync = true;
    try {
      await this.writeSnapshot(acceptedBeforeWrite, false);
      this.persistedSnapshotOutOfSync = false;
    } catch (rollbackError) {
      const compensationError = new Error(
        "Agent registry write was superseded and compensation failed",
      ) as Error & { cause?: unknown };
      compensationError.cause = rollbackError;
      throw compensationError;
    }
    throw new Error("Agent registry write was superseded");
  }

  private async writeSnapshot(
    workflows: readonly WorkflowInfo[],
    primary: boolean,
    isCurrent?: () => boolean,
  ): Promise<void> {
    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write: write to a temp file in the same directory (so rename is
    // same-filesystem and thus atomic on POSIX), then rename over the target.
    // A crash mid-write leaves the .tmp file, not a torn workflows.json.
    // Mirrors the pattern used by SessionManager.persist().
    const tmpPath = `${this.registryPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(workflows, null, 2));
      if (primary && (this.retired || (isCurrent && !isCurrent()))) {
        throw new Error("Agent registry write was superseded");
      }
      const rename = fs.rename(tmpPath, this.registryPath);
      this.activeRename = rename;
      try {
        await rename;
      } finally {
        if (this.activeRename === rename) this.activeRename = null;
      }
      if (primary) {
        await this.persistenceTestHooks.afterPrimaryRename?.();
      }
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  }

  /** Retires discovery work owned by a shutting-down server instance. */
  async retirePendingDiscovery(): Promise<void> {
    this.retired = true;
    this.discoveryLifetime += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.writeQueue.catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    await this.activeRename?.catch(() => {});
  }

  /** Chains `run` onto the write queue so concurrent mutations never
   *  interleave — a failed run never poisons later ones. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => {}).then(run);
    this.writeQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private discoveryStatusForCanonicalRoot(
    canonicalRoot: string,
  ): "complete" | "degraded" {
    // Completeness is evidence for exactly the selected scan scope. A direct
    // child scan cannot upgrade or degrade a parent whose admitted envelope is
    // different (and may deliberately skip that child behind an ignore or
    // repository boundary). Active containing scopes are rescanned by the
    // server coordinator when child evidence changes.
    return this.discoveryStatusByRoot.get(canonicalRoot) ?? "degraded";
  }

  async discoveryStatus(root: string): Promise<"complete" | "degraded"> {
    const lexicalRoot = path.resolve(root);
    const canonicalRoot =
      this.canonicalScopeByLexicalRoot.get(lexicalRoot) ?? lexicalRoot;
    return this.discoveryStatusForCanonicalRoot(canonicalRoot);
  }

  async inventorySnapshot(root: string): Promise<{
    workflows: readonly WorkflowInfo[];
    status: "complete" | "degraded";
    generation: number;
    canonicalScopeRoot: string;
    canonicalWorkflowRoots: readonly {
      workflowPath: string;
      canonicalRoot: string;
      identityEvidence: WorkflowIdentityEvidence;
    }[];
    sourceObservations: readonly {
      candidateRoot: string;
      workspaceRoot: string;
      paths: readonly string[];
    }[];
  }> {
    await this.ensureLoaded();
    const lexicalRoot = path.resolve(root);
    const canonicalRoot =
      this.canonicalScopeByLexicalRoot.get(lexicalRoot) ?? lexicalRoot;
    return {
      workflows: this.workflows,
      status: this.discoveryStatusForCanonicalRoot(canonicalRoot),
      generation: this.inventoryGeneration,
      canonicalScopeRoot: canonicalRoot,
      canonicalWorkflowRoots: this.workflows.map((workflow) => {
        const canonicalWorkflowRoot =
          this.canonicalWorkflowRootByPath.get(workflow.path) ?? workflow.path;
        return {
          workflowPath: workflow.path,
          canonicalRoot: canonicalWorkflowRoot,
          identityEvidence:
            this.identityEvidenceByCanonicalRoot.get(canonicalWorkflowRoot) ??
            "unknown",
        };
      }),
      sourceObservations: [...this.sourceObservationsByCanonicalRoot.values()]
        .map((observations) => ({ ...observations }))
        .sort(
          (left, right) =>
            compareText(left.workspaceRoot, right.workspaceRoot) ||
            compareText(left.candidateRoot, right.candidateRoot),
        ),
    };
  }

  private cachedCanonicalRoot(inputPath: string): string {
    const lexicalPath = path.resolve(expandHome(inputPath));
    let bestLexicalRoot: string | null = null;
    let bestCanonicalRoot: string | null = null;
    const consider = (lexicalRoot: string, canonicalRoot: string): void => {
      if (resolveWithinRoot(lexicalRoot, lexicalPath) === null) return;
      if (
        bestLexicalRoot !== null &&
        bestLexicalRoot.length >= lexicalRoot.length
      ) {
        return;
      }
      bestLexicalRoot = lexicalRoot;
      bestCanonicalRoot = canonicalRoot;
    };
    for (const [lexicalRoot, canonicalRoot] of this
      .canonicalScopeByLexicalRoot) {
      consider(lexicalRoot, canonicalRoot);
    }
    for (const [lexicalRoot, canonicalRoot] of this
      .canonicalWorkflowRootByPath) {
      consider(lexicalRoot, canonicalRoot);
    }
    if (!bestLexicalRoot || !bestCanonicalRoot) return lexicalPath;
    const suffix = path.relative(bestLexicalRoot, lexicalPath);
    return path.resolve(bestCanonicalRoot, suffix);
  }

  private wasDirtiedSince(canonicalRoot: string, epoch: number): boolean {
    for (const [dirtyRoot, dirtyEpoch] of this.dirtyEpochByCanonicalRoot) {
      if (dirtyEpoch <= epoch) continue;
      if (
        resolveWithinRoot(canonicalRoot, dirtyRoot) !== null ||
        resolveWithinRoot(dirtyRoot, canonicalRoot) !== null
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Synchronous fail-closed invalidation for a raw watcher signal. The server
   * calls this before any asynchronous reconciliation or graph work, so stale
   * marker proof cannot authorize source inspection while an edit is pending.
   * Registry load is completed during server boot; callers before then simply
   * get the conservative no-op and the later scan establishes evidence.
   */
  markDiscoveryDirty(root: string): boolean {
    if (!this.loaded || this.retired) return false;
    this.discoveryEpoch += 1;
    const canonicalRoot = this.cachedCanonicalRoot(root);
    this.dirtyEpochByCanonicalRoot.set(canonicalRoot, this.discoveryEpoch);
    let changed = false;
    const intersectingStatuses = new Set([canonicalRoot]);
    for (const scannedRoot of this.discoveryStatusByRoot.keys()) {
      if (
        resolveWithinRoot(canonicalRoot, scannedRoot) !== null ||
        resolveWithinRoot(scannedRoot, canonicalRoot) !== null
      ) {
        intersectingStatuses.add(scannedRoot);
      }
    }
    for (const scannedRoot of intersectingStatuses) {
      if (this.discoveryStatusByRoot.get(scannedRoot) !== "degraded") {
        this.discoveryStatusByRoot.set(scannedRoot, "degraded");
        changed = true;
      }
    }
    for (const [workflowRoot, evidence] of this
      .identityEvidenceByCanonicalRoot) {
      if (
        evidence !== "unknown" &&
        (resolveWithinRoot(canonicalRoot, workflowRoot) !== null ||
          resolveWithinRoot(workflowRoot, canonicalRoot) !== null)
      ) {
        this.identityEvidenceByCanonicalRoot.set(workflowRoot, "unknown");
        changed = true;
      }
    }
    if (changed) this.inventoryGeneration += 1;
    return changed;
  }

  /**
   * The registry as it stands — and the point at which stale entries actually
   * leave. A read runs {@link prune} when one is due
   * (LAZY_PRUNE_INTERVAL_MS), so an agent whose directory the user deleted
   * disappears from `GET /api/workflows` on its own rather than waiting for the
   * next server boot. Cheap by construction: one `stat` per entry, throttled,
   * and the file is only rewritten when something was actually dropped.
   */
  async list(): Promise<WorkflowInfo[]> {
    await this.ensureLoaded();
    if (Date.now() - this.lastPruneAt >= LAZY_PRUNE_INTERVAL_MS) {
      // CLAIM THE INTERVAL BEFORE SWEEPING. `lastPruneAt` used to be written
      // only inside the queued task, so every read in a burst passed the
      // throttle and queued its own full stat sweep of the whole registry.
      // Claiming it here closes the burst to one sweep per interval.
      this.lastPruneAt = Date.now();
      void this.prune().catch(() => {
        // Reads stay cache-backed; a later read or explicit scan retries.
      });
    }
    return this.workflows;
  }

  /**
   * Drops entries whose `path` no longer exists on disk and persists the
   * result — users delete projects, and a crashed run can leave a temp
   * directory registered. Deliberately narrow: only a confirmed-missing
   * path (ENOENT/ENOTDIR) is pruned. A directory that exists but is
   * merely unbuilt, unreadable (permissions), or temporarily unstattable
   * stays registered. Returns what was pruned so the caller can log it.
   */
  async prune(): Promise<WorkflowInfo[]> {
    await this.ensureLoaded();
    // THE STAT SWEEP RUNS OUTSIDE THE WRITE QUEUE. It only reads the
    // filesystem, so putting it behind `enqueue` made the rail's hot read
    // (`GET /api/workflows`, via list()) block until any in-flight `scan()`
    // finished — 239 ms on a measured real root, 6.8 s uncapped — where it used
    // to answer from memory. Only the WRITE needs the lock, and only when
    // something was actually dropped, which is the rare case.
    const { pruned } = await partitionByPathExists(this.workflows);
    this.lastPruneAt = Date.now();
    if (pruned.length === 0) return [];

    const gone = new Map(pruned.map((workflow) => [workflow.path, workflow]));
    return this.enqueue(async () => {
      if (this.retired) return [];
      // RE-DERIVE FROM CURRENT STATE rather than assigning the `kept` computed
      // above: a scan may have registered entries while we were statting, and
      // writing a stale snapshot back would silently drop them. Removing a set
      // of known-missing paths is safe whatever else changed meanwhile.
      const before = this.workflows;
      const removed: WorkflowInfo[] = [];
      for (const workflow of before) {
        if (gone.get(workflow.path) !== workflow) continue;
        try {
          await fs.stat(workflow.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") removed.push(workflow);
        }
      }
      if (removed.length === 0) return [];
      const removedRows = new Set(removed);
      const nextWorkflows = before.filter(
        (workflow) => !removedRows.has(workflow),
      );
      await this.persist(nextWorkflows);
      this.removePrivateStateForRows(removed);
      this.workflows = nextWorkflows;
      this.inventoryGeneration += 1;
      return removed;
    });
  }

  /**
   * `budget` is overridable so a caller (and the tests that pin this rule) can
   * scan with a narrower allowance than the shipped default; the reconciliation
   * envelope follows whatever the scan actually managed to cover.
   *
   * Scans `root`, refreshes discovered projects, and removes scan-sourced rows
   * in this scan's traversal envelope when their marker is confirmed gone or
   * invalid. Rows beneath a temporarily unreadable directory survive this pass,
   * as do rows below the depth the scan actually completed when the node budget
   * cut it short; manually connected rows remain until their path itself is
   * pruned.
   */
  async scanDetailed(
    root: string,
    budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
    sourceBudget: AgentSourceScanBudget = new AgentSourceScanBudget(),
  ): Promise<WorkflowRegistryScanResult> {
    return this.enqueue(async () => {
      if (this.retired) {
        throw new Error("Agent registry is retired");
      }
      await this.ensureLoaded();
      const scanEpoch = this.discoveryEpoch;
      const scanLifetime = this.discoveryLifetime;
      const absoluteRoot = path.resolve(expandHome(root));
      const rootEvidence = await canonicalDirectoryEvidence(absoluteRoot);
      const canonicalRoot = rootEvidence.key;
      this.canonicalScopeByLexicalRoot.set(absoluteRoot, canonicalRoot);
      this.canonicalScopeByLexicalRoot.set(canonicalRoot, canonicalRoot);
      const scanResult = await scanAgentProjects(
        absoluteRoot,
        budget,
        {},
        this.sourceDiscovery,
        sourceBudget,
      );
      const {
        found,
        unreconciledRoots,
        notAgentRoots,
        opaqueRoots,
        discoveredStopRoots,
        sourceObservations,
        repositoryBoundaries,
        sourceDiscoveryComplete,
      } = scanResult;
      if (rootEvidence.status === "unreadable") {
        unreconciledRoots.push(absoluteRoot);
      }
      let nextStatus: "complete" | "degraded" =
        !budget.truncated &&
        unreconciledRoots.length === 0 &&
        sourceDiscoveryComplete
          ? "complete"
          : "degraded";

      const foundRows = await mapBounded(found, async (workflow) => {
        const canonicalEvidence = await canonicalDirectoryEvidence(
          workflow.path,
        );
        return {
          workflow,
          canonicalKey: canonicalEvidence.key,
          canonicalStatus: canonicalEvidence.status,
        };
      });
      if (foundRows.some((row) => row.canonicalStatus === "unreadable")) {
        nextStatus = "degraded";
      }
      const foundKeys = new Set(foundRows.map((row) => row.canonicalKey));
      const protectedRoots = [
        ...unreconciledRoots,
        ...opaqueRoots,
        ...discoveredStopRoots,
        ...repositoryBoundaries,
      ];
      const canonicalizableProtectedRoots = [
        ...unreconciledRoots,
        ...discoveredStopRoots,
        ...repositoryBoundaries,
      ];
      const canonicalProtectedRoots = await mapBounded(
        canonicalizableProtectedRoots,
        canonicalDirectory,
      );
      const canonicalUnreconciledRoots = await mapBounded(
        unreconciledRoots,
        canonicalDirectory,
      );
      const canonicalNotAgentRoots = await mapBounded(
        notAgentRoots,
        canonicalDirectory,
      );
      const canonicalRepositoryBoundaries = await mapBounded(
        repositoryBoundaries,
        canonicalDirectory,
      );
      const canonicalDiscoveredStopRoots = await mapBounded(
        discoveredStopRoots,
        canonicalDirectory,
      );
      const canonicalSourceObservations = await mapBounded(
        sourceObservations,
        async (observation) => {
          const canonicalWorkspaceRoot = await canonicalDirectory(
            observation.workspaceRoot,
          );
          return {
            candidateRoot: await canonicalDirectory(observation.candidateRoot),
            workspaceRoot: canonicalWorkspaceRoot,
            // Analyzer watch paths are lexical and may sit below a symlinked
            // selected scope. Preserve their already-confined relative suffix
            // while projecting them into the canonical envelope consumed by
            // polling; do not follow an absent target to perform this remap.
            paths: observation.paths.flatMap((observedPath) => {
              for (const envelope of [
                observation.workspaceRoot,
                canonicalWorkspaceRoot,
              ]) {
                const relative = path.relative(envelope, observedPath);
                if (
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative)
                ) {
                  return [path.resolve(canonicalWorkspaceRoot, relative)];
                }
              }
              return [];
            }),
          };
        },
      );
      const currentRows = await mapBounded(
        this.workflows,
        async (workflow) => ({
          workflow,
          canonicalEvidence: await canonicalDirectoryEvidence(workflow.path),
        }),
      );
      const byPath = new Map<string, WorkflowInfo>();
      for (const { workflow, canonicalEvidence } of currentRows) {
        const canonicalKey = canonicalEvidence.key;
        const newlyForeignToOwningEnvelope =
          this.sourceObservationsByCanonicalRoot.has(
            sourceObservationKey(canonicalRoot, canonicalKey),
          ) &&
          canonicalRepositoryBoundaries.some(
            (boundary) => path.resolve(boundary) === path.resolve(canonicalKey),
          );
        const lexicalCovered = isCoveredByScan(
          absoluteRoot,
          workflow.path,
          budget.envelopeDepth,
        );
        const canonicalCovered = isCoveredByScan(
          canonicalRoot,
          canonicalKey,
          budget.envelopeDepth,
        );
        const covered = lexicalCovered || canonicalCovered;
        const lexicalProtected = isProtectedByIncompleteScan(
          workflow.path,
          protectedRoots,
        );
        const protectedByBoundary =
          canonicalEvidence.status === "unreadable" ||
          (lexicalProtected && !canonicalCovered) ||
          (isProtectedByIncompleteScan(canonicalKey, canonicalProtectedRoots) &&
            !newlyForeignToOwningEnvelope);
        if (
          workflow.source === "connect" &&
          covered &&
          !foundKeys.has(canonicalKey) &&
          !protectedByBoundary
        ) {
          const withoutStaleSource = { ...workflow };
          delete withoutStaleSource.sourceDefinitionName;
          delete withoutStaleSource.markerPresent;
          byPath.set(canonicalKey, withoutStaleSource);
          continue;
        }
        if (
          workflow.source !== "scan" ||
          !covered ||
          foundKeys.has(canonicalKey) ||
          protectedByBoundary
        ) {
          byPath.set(canonicalKey, workflow);
        }
      }
      for (const { workflow, canonicalKey } of foundRows) {
        const existing = byPath.get(canonicalKey);
        byPath.set(canonicalKey, mergeScannedWorkflow(existing, workflow));
      }
      // Registry-wide, not envelope-wide: a scan is the most frequent write
      // this file gets, and an entry whose directory is CONFIRMED gone has no
      // claim to survive it regardless of which root turned it up. Without
      // this, a dead row rooted somewhere the studio never scans again lives
      // for as long as the install does.
      const { kept, pruned: initiallyPruned } = await partitionByPathExists(
        Array.from(byPath.values()),
      );
      // The filesystem can resurrect a same-path project while a wide sweep is
      // in progress. Re-stat removal candidates at the commit boundary and
      // preserve any path whose evidence changed after the first observation.
      const { kept: resurrected, pruned } =
        await partitionByPathExists(initiallyPruned);
      const nextWorkflows = [...kept, ...resurrected].sort((left, right) =>
        compareText(left.path, right.path),
      );
      const nextCanonicalRoots = await mapBounded(nextWorkflows, (workflow) =>
        canonicalDirectory(workflow.path),
      );
      const nextCanonicalWorkflowRootByPath = new Map<string, string>();
      for (const [index, workflow] of nextWorkflows.entries()) {
        nextCanonicalWorkflowRootByPath.set(
          workflow.path,
          nextCanonicalRoots[index] ?? workflow.path,
        );
      }
      const nextIdentityEvidence = new Map(
        this.identityEvidenceByCanonicalRoot,
      );
      const nextSourceObservations = new Map(
        this.sourceObservationsByCanonicalRoot,
      );
      // A registry-wide existence sweep can retire a row outside the requested
      // scan envelope. Its source-observation sidecar must retire with it or
      // every later watcher will keep probing a path proven not to exist. Do
      // not trim ordinary not-agent/incomplete candidates here: their missing
      // dependency observations are what let a later dependency-only edit
      // promote them without touching index.ts.
      const prunedCanonicalRoots = this.cachedRootsForRows(pruned);
      const observedCandidatesThisScan = new Set(
        canonicalSourceObservations.map((entry) => entry.candidateRoot),
      );
      for (const [observationKey, observation] of nextSourceObservations) {
        const candidateRoot = observation.candidateRoot;
        if (
          prunedCanonicalRoots.some(
            (root) => resolveWithinRoot(root, candidateRoot) !== null,
          )
        ) {
          nextSourceObservations.delete(observationKey);
          continue;
        }
        const covered = isCoveredByScan(
          canonicalRoot,
          candidateRoot,
          budget.envelopeDepth,
        );
        const protectedByBoundary =
          (isProtectedByIncompleteScan(candidateRoot, [
            ...canonicalUnreconciledRoots,
            ...canonicalRepositoryBoundaries,
          ]) &&
            !(
              observation.workspaceRoot === canonicalRoot &&
              canonicalRepositoryBoundaries.some(
                (boundary) =>
                  path.resolve(boundary) === path.resolve(candidateRoot),
              )
            )) ||
          canonicalDiscoveredStopRoots.some((stopRoot) =>
            isStrictlyBelowRoot(stopRoot, candidateRoot),
          );
        if (
          covered &&
          !protectedByBoundary &&
          (observation.workspaceRoot === canonicalRoot ||
            !observedCandidatesThisScan.has(candidateRoot))
        ) {
          nextSourceObservations.delete(observationKey);
        }
      }
      for (const observation of canonicalSourceObservations) {
        nextSourceObservations.set(
          sourceObservationKey(
            observation.workspaceRoot,
            observation.candidateRoot,
          ),
          {
            candidateRoot: observation.candidateRoot,
            workspaceRoot: observation.workspaceRoot,
            paths: observation.paths,
          },
        );
      }
      for (const { workflow, canonicalEvidence } of currentRows) {
        const canonicalKey = canonicalEvidence.key;
        const covered =
          isCoveredByScan(absoluteRoot, workflow.path, budget.envelopeDepth) ||
          isCoveredByScan(canonicalRoot, canonicalKey, budget.envelopeDepth);
        const protectedByBoundary =
          canonicalEvidence.status === "unreadable" ||
          (isProtectedByIncompleteScan(canonicalKey, canonicalProtectedRoots) &&
            !(
              this.sourceObservationsByCanonicalRoot.has(
                sourceObservationKey(canonicalRoot, canonicalKey),
              ) &&
              canonicalRepositoryBoundaries.some(
                (boundary) =>
                  path.resolve(boundary) === path.resolve(canonicalKey),
              )
            ));
        const intersectsUncertainty = canonicalUnreconciledRoots.some(
          (unreconciledRoot) =>
            resolveWithinRoot(unreconciledRoot, canonicalKey) !== null ||
            resolveWithinRoot(canonicalKey, unreconciledRoot) !== null,
        );
        if (intersectsUncertainty || (covered && !protectedByBoundary)) {
          nextIdentityEvidence.set(canonicalKey, "unknown");
        }
      }
      for (const { workflow, canonicalKey } of foundRows) {
        nextIdentityEvidence.set(
          canonicalKey,
          hasSourceDiscoveryEvidence(workflow) ? "source" : "marker",
        );
      }
      for (const canonicalKey of canonicalNotAgentRoots) {
        nextIdentityEvidence.set(canonicalKey, "not-agent");
      }
      const retainedCanonicalRoots = new Set(nextCanonicalRoots);
      for (const canonicalKey of nextIdentityEvidence.keys()) {
        if (!retainedCanonicalRoots.has(canonicalKey)) {
          nextIdentityEvidence.delete(canonicalKey);
        }
      }
      const nextStatuses = new Map(this.discoveryStatusByRoot);
      removeEntriesWithinRoots(nextStatuses, prunedCanonicalRoots);
      for (const [scannedRoot, priorStatus] of nextStatuses) {
        if (
          scannedRoot === canonicalRoot ||
          resolveWithinRoot(canonicalRoot, scannedRoot) === null
        ) {
          continue;
        }
        const intersectsUncertainty = canonicalUnreconciledRoots.some(
          (unreconciledRoot) =>
            resolveWithinRoot(unreconciledRoot, scannedRoot) !== null ||
            resolveWithinRoot(scannedRoot, unreconciledRoot) !== null,
        );
        if (intersectsUncertainty) {
          nextStatuses.set(scannedRoot, "degraded");
          continue;
        }
        const admittedAndCovered =
          nextStatus === "complete" &&
          isCoveredByScan(canonicalRoot, scannedRoot, budget.envelopeDepth) &&
          !isProtectedByIncompleteScan(
            scannedRoot,
            canonicalRepositoryBoundaries,
          ) &&
          !canonicalDiscoveredStopRoots.some((stopRoot) =>
            isStrictlyBelowRoot(stopRoot, scannedRoot),
          );
        if (priorStatus === "degraded" && admittedAndCovered) {
          nextStatuses.set(scannedRoot, "complete");
        }
      }
      nextStatuses.set(canonicalRoot, nextStatus);
      const rowsChanged = !workflowRowsEqual(this.workflows, nextWorkflows);
      const statusChanged = !statusMapsEqual(
        this.discoveryStatusByRoot,
        nextStatuses,
      );
      const evidenceChanged = !evidenceMapsEqual(
        this.identityEvidenceByCanonicalRoot,
        nextIdentityEvidence,
      );
      const observationsChanged = !observationMapsEqual(
        this.sourceObservationsByCanonicalRoot,
        nextSourceObservations,
      );
      this.lastPruneAt = Date.now();
      if (
        scanLifetime !== this.discoveryLifetime ||
        this.wasDirtiedSince(canonicalRoot, scanEpoch)
      ) {
        throw new Error("Agent discovery scan was superseded by a newer edit");
      }
      try {
        if (rowsChanged || this.persistedSnapshotOutOfSync) {
          await this.persist(
            nextWorkflows,
            () =>
              scanLifetime === this.discoveryLifetime &&
              !this.wasDirtiedSince(canonicalRoot, scanEpoch),
          );
        }
      } catch (error) {
        if (
          scanLifetime === this.discoveryLifetime &&
          this.discoveryStatusByRoot.get(canonicalRoot) !== "degraded"
        ) {
          this.discoveryStatusByRoot.set(canonicalRoot, "degraded");
          this.inventoryGeneration += 1;
        }
        throw error;
      }
      if (
        scanLifetime !== this.discoveryLifetime ||
        this.wasDirtiedSince(canonicalRoot, scanEpoch)
      ) {
        throw new Error("Agent discovery scan was superseded by a newer edit");
      }
      this.removePrivateStateForRows(pruned);
      if (rowsChanged) this.workflows = nextWorkflows;
      this.canonicalWorkflowRootByPath.clear();
      for (const [
        workflowPath,
        canonicalWorkflowRoot,
      ] of nextCanonicalWorkflowRootByPath) {
        this.canonicalWorkflowRootByPath.set(
          workflowPath,
          canonicalWorkflowRoot,
        );
      }
      if (statusChanged) {
        this.discoveryStatusByRoot.clear();
        for (const [scannedRoot, status] of nextStatuses) {
          this.discoveryStatusByRoot.set(scannedRoot, status);
        }
      }
      if (evidenceChanged) {
        this.identityEvidenceByCanonicalRoot.clear();
        for (const [canonicalKey, evidence] of nextIdentityEvidence) {
          this.identityEvidenceByCanonicalRoot.set(canonicalKey, evidence);
        }
      }
      if (observationsChanged) {
        this.sourceObservationsByCanonicalRoot.clear();
        for (const [canonicalKey, observations] of nextSourceObservations) {
          this.sourceObservationsByCanonicalRoot.set(
            canonicalKey,
            observations,
          );
        }
      }
      if (
        rowsChanged ||
        statusChanged ||
        evidenceChanged ||
        observationsChanged
      ) {
        this.inventoryGeneration += 1;
      }
      return {
        found: found.filter(
          (workflow) => !pruned.some((dead) => dead.path === workflow.path),
        ),
        repositoryBoundaries,
        budget,
        sourceBudget,
        status: this.discoveryStatusForCanonicalRoot(canonicalRoot),
        changed:
          rowsChanged ||
          statusChanged ||
          evidenceChanged ||
          observationsChanged,
        generation: this.inventoryGeneration,
      };
    });
  }

  async scan(
    root: string,
    budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  ): Promise<WorkflowInfo[]> {
    return (await this.scanDetailed(root, budget)).found;
  }

  /** Registers an arbitrary path (the "+ Connect" flow); marker is optional at connect time. */
  async connectPath(inputPath: string): Promise<WorkflowInfo> {
    return this.enqueue(async () => {
      if (this.retired) {
        throw new Error("Agent registry is retired");
      }
      await this.ensureLoaded();
      const connectEpoch = this.discoveryEpoch;
      const connectLifetime = this.discoveryLifetime;
      const absolutePath = path.resolve(expandHome(inputPath));
      const canonicalKey = await canonicalDirectory(absolutePath);
      const markerInspection = await inspectMarker(absolutePath);
      const marker =
        markerInspection.status === "valid" ? markerInspection.marker : null;
      let sourceInspection: Awaited<
        ReturnType<AgentSourceDiscovery["inspectCandidate"]>
      > | null = null;
      if (
        markerInspection.status === "absent" ||
        markerInspection.status === "invalid"
      ) {
        try {
          sourceInspection = await this.sourceDiscovery.inspectCandidate(
            absolutePath,
            new AgentSourceScanBudget(),
            absolutePath,
          );
        } catch {
          sourceInspection = {
            status: "incomplete",
            reason: "unreadable-source",
            modules: 0,
            bytes: 0,
            lookups: 0,
            fingerprint: "<connect-inspection-failed>",
            observations: [],
            watchPaths: [],
          };
        }
      }
      const info: WorkflowInfo = {
        name: await nameFor(absolutePath),
        path: absolutePath,
        ...(marker
          ? normalizedMarkerFields(marker)
          : {
              definitionId: null,
              definitionSlug: null,
              templateId: null,
              forkId: null,
              starterId: null,
            }),
        source: "connect",
      };
      if (sourceInspection?.status === "agent") {
        info.sourceDefinitionName = safeDefinitionName(sourceInspection.name);
      }
      const canonicalKeys = await mapBounded(this.workflows, (workflow) =>
        canonicalDirectory(workflow.path),
      );
      const idx = canonicalKeys.findIndex((key) => key === canonicalKey);
      let persisted = info;
      const nextWorkflows = [...this.workflows];
      if (idx >= 0) {
        const existing = this.workflows[idx]!;
        if (markerInspection.status === "unreadable") {
          persisted = { ...existing, source: "connect" };
        } else {
          persisted = {
            ...existing,
            ...info,
            // Keep the registry spelling that existing sessions and rail rows
            // already reference. Canonical matching prevents a duplicate row;
            // rewriting the path would silently unbind exact-path consumers.
            path: existing.path,
            definitionId: existing.definitionId ?? info.definitionId,
            definitionSlug: existing.definitionSlug ?? info.definitionSlug,
            templateId: existing.templateId ?? info.templateId,
            forkId: existing.forkId ?? info.forkId,
            starterId: existing.starterId ?? info.starterId,
          };
        }
        if (markerInspection.status === "unreadable") {
          // Opaque marker evidence is retained exactly until a later accepted
          // marker/source inspection can replace it.
        } else if (marker) {
          delete persisted.sourceDefinitionName;
        } else if (sourceInspection?.status === "agent") {
          persisted.sourceDefinitionName = safeDefinitionName(
            sourceInspection.name,
          );
        } else if (sourceInspection?.status === "incomplete") {
          if (hasSourceDiscoveryEvidence(existing)) {
            persisted.sourceDefinitionName =
              existing.sourceDefinitionName ?? null;
          } else {
            delete persisted.sourceDefinitionName;
          }
        } else {
          delete persisted.sourceDefinitionName;
        }
        if (!marker && markerInspection.status !== "unreadable") {
          delete persisted.markerPresent;
        }
        nextWorkflows[idx] = persisted;
      } else {
        nextWorkflows.push(info);
      }
      const superseded = this.wasDirtiedSince(canonicalKey, connectEpoch);
      if (superseded) {
        delete persisted.markerPresent;
        delete persisted.sourceDefinitionName;
        const persistedIndex = nextWorkflows.findIndex(
          (workflow) => workflow.path === persisted.path,
        );
        if (persistedIndex >= 0) nextWorkflows[persistedIndex] = persisted;
      }
      await this.persist(
        nextWorkflows,
        () =>
          connectLifetime === this.discoveryLifetime &&
          !this.wasDirtiedSince(canonicalKey, connectEpoch),
      );
      this.workflows = nextWorkflows;
      this.canonicalWorkflowRootByPath.set(persisted.path, canonicalKey);
      const supersededAtPublication =
        superseded || this.wasDirtiedSince(canonicalKey, connectEpoch);
      if (supersededAtPublication) {
        this.identityEvidenceByCanonicalRoot.set(canonicalKey, "unknown");
      } else if (markerInspection.status === "unreadable") {
        this.identityEvidenceByCanonicalRoot.set(canonicalKey, "unknown");
      } else {
        this.identityEvidenceByCanonicalRoot.set(
          canonicalKey,
          marker
            ? "marker"
            : sourceInspection?.status === "agent"
              ? "source"
              : sourceInspection?.status === "not-agent"
                ? "not-agent"
                : "unknown",
        );
        if (marker) {
          for (const [key, observation] of this
            .sourceObservationsByCanonicalRoot) {
            if (observation.candidateRoot === canonicalKey) {
              this.sourceObservationsByCanonicalRoot.delete(key);
            }
          }
        } else if (sourceInspection) {
          this.sourceObservationsByCanonicalRoot.set(
            sourceObservationKey(canonicalKey, canonicalKey),
            {
              candidateRoot: canonicalKey,
              workspaceRoot: canonicalKey,
              paths: sourceInspection.watchPaths,
            },
          );
        }
      }
      this.inventoryGeneration += 1;
      return persisted;
    });
  }
}

/**
 * The subset of {@link WorkflowRegistry} the workflows router depends on. Typed
 * structurally so a caller can pass a wrapper (e.g. one that enriches `list()`
 * with resolved slugs) without an unsafe cast — a missing method is then a
 * compile error, not a runtime crash.
 */
/**
 * What a requested scan found, AND what it deliberately declined to enter.
 *
 * The second half exists because the two are only honest together. A scan stops
 * at a foreign repository root, so pointing it at a folder that is not itself a
 * repo but holds several clones finds NOTHING while several agents sit on disk —
 * and a UI told only `found: []` will state, in good faith, that the folder is
 * empty and offer to create the *first* agent in it. `repositoryBoundaries`
 * turns that false statement into the true one: these checkouts were not
 * searched, open one as its own project.
 */
export interface WorkflowScanOutcome {
  found: WorkflowInfo[];
  /** Absolute paths of checkouts the walk stopped at rather than entering. */
  repositoryBoundaries: string[];
}

export interface WorkflowRegistryLike {
  list(): Promise<WorkflowInfo[]>;
  scan(root: string): Promise<WorkflowInfo[]>;
  /**
   * The same scan, reporting the boundaries it stopped at. Optional so an
   * embedder implementing this interface keeps compiling; the route degrades to
   * `scan` with an empty boundary list, which is the pre-existing behaviour.
   */
  scanWithBoundaries?(root: string): Promise<WorkflowScanOutcome>;
  connectPath(inputPath: string): Promise<WorkflowInfo>;
}

/**
 * Keep registry-only proof out of every HTTP adapter, including embedders that
 * mount this generic router directly around a {@link WorkflowRegistry}.
 */
function publicWorkflowInfo(workflow: WorkflowInfo): PublicWorkflowInfo {
  const publicRow = { ...workflow };
  delete publicRow.sourceDefinitionName;
  delete publicRow.markerPresent;
  return publicRow;
}

function publicWorkflowInfos(
  workflows: readonly WorkflowInfo[],
): PublicWorkflowInfo[] {
  return workflows.map(publicWorkflowInfo);
}

export function createWorkflowsRouter(
  registry: WorkflowRegistryLike,
): ExpressRouter {
  const router = Router();

  router.get("/api/workflows", async (_req, res) => {
    res.json(publicWorkflowInfos(await registry.list()));
  });

  router.post("/api/workflows/connect", async (req, res) => {
    const inputPath = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      res.json(publicWorkflowInfo(await registry.connectPath(inputPath)));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/workflows/scan", async (req, res) => {
    const root = (req.body as { root?: unknown } | undefined)?.root;
    if (typeof root !== "string" || !root.trim()) {
      res.status(400).json({ error: "root is required" });
      return;
    }
    try {
      // Responds with the OUTCOME, not a bare array: see WorkflowScanOutcome
      // for why `found` alone lets a caller state a falsehood.
      const outcome: WorkflowScanOutcome = registry.scanWithBoundaries
        ? await registry.scanWithBoundaries(root)
        : { found: await registry.scan(root), repositoryBoundaries: [] };
      res.json({
        ...outcome,
        found: publicWorkflowInfos(outcome.found),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
