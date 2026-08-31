import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";

import {
  PACKAGE_INVENTORY_PROTOCOL,
  packageInventorySchema,
  type PackageInventory,
  type PackageInventoryAgent,
} from "@sapiom/agent";

import {
  type AgentKey,
  type GraphWarning,
  type WorkspaceKey,
} from "../shared/system-graph.js";
import type { WorkflowInfo } from "../shared/types.js";
import { fingerprintWorkflowSources } from "./canvas-cache.js";
import type { ManifestNameInspection } from "./definition-name.js";

export interface WorkspaceScope {
  workspaceKey: WorkspaceKey;
  root: string;
}

/** Harness-only evidence paired with one public inventory record. */
export interface AgentInventoryContextItem {
  agentKey: AgentKey;
  /** Internal deployment provenance. Never serialize this into SystemGraph. */
  definitionId: number | null;
  definitionSlug: string | null;
  label: string;
  /** Marker/source compatibility aliases. Never cross the graph HTTP boundary. */
  resolutionAliases: string[];
  /** Canonical filesystem evidence. Never serialize this into SystemGraph. */
  sourceRoot: string;
  /** Registry-owned navigation target, served only by the protected resolver. */
  workflowPath: string;
  /** Joins this context to the public record without relying on array order. */
  path: string;
  entrypoint: string;
}

/** Builder-facing item after the public contract and private context are joined. */
export interface AgentInventoryItem extends AgentInventoryContextItem {
  /** Parsed public evidence used to keep authoritative keys above aliases. */
  identityStatus: PackageInventoryAgent["identityStatus"];
}

export interface AgentInventoryWarning {
  code: Extract<
    GraphWarning["code"],
    "duplicate-agent-key" | "inventory-extraction-failed"
  >;
  agentKey: AgentKey;
  message: string;
}

export interface AgentInventoryResult {
  inventory: PackageInventory;
  context: AgentInventoryContextItem[];
  warnings: AgentInventoryWarning[];
  /**
   * Private lifecycle state: false while an unchanged source could still
   * resolve to a different identity. This stays outside PackageInventory so
   * the public contract continues to answer only what exists and where.
   */
  identitySettled: boolean;
  /** Starts source identity work only after the provisional graph is committed. */
  startEnrichment?: () => void;
}

/** Read-only boundary between Studio's registry and graph projection. */
export interface AgentInventoryProvider {
  listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult>;
  /** Prunes private identity state for roots no active graph can reference. */
  retainSources?(sourceRoots: ReadonlySet<string>): void;
}

type ManifestNameInspector = (
  sourceRoot: string,
) => Promise<ManifestNameInspection>;

export interface HarnessRegistryInventoryProviderOptions {
  listWorkflows: () =>
    | readonly WorkflowInfo[]
    | Promise<readonly WorkflowInfo[]>;
  inspectManifestName?: ManifestNameInspector;
  /**
   * Called with coalesced identity changes. Settled roots are surfaced within
   * a short bounded window, while a fully drained queue flushes immediately.
   */
  onIdentityChange?: (sourceRoots: readonly string[]) => void | Promise<void>;
  /** Test seam. Production uses the same fingerprint as Canvas extraction. */
  fingerprintSource?: (sourceRoot: string) => Promise<string>;
  /** Test seam for the bounded identity-change coalescing window. */
  identityChangeCoalesceMs?: number;
}

const MANIFEST_INSPECTION_CONCURRENCY = 4;
const IDENTITY_CHANGE_COALESCE_MS = 250;
const ENTRYPOINT = "index.ts";
const ZERO_REVISION = `sha256:${"0".repeat(64)}` as const;
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

type InventoryIdentityIssue = Exclude<
  PackageInventoryAgent["identityIssue"],
  undefined
>;

function isWindowsAbsolute(input: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input)
  );
}

function pathApi(input: string): typeof path.posix {
  return isWindowsAbsolute(input) ? path.win32 : path.posix;
}

/**
 * Resolve with the input path's own flavor so mixed Windows separators remain
 * comparable even when the test process (or a future remote host) is POSIX.
 */
export function canonicalGraphPath(input: string): string {
  const windows = isWindowsAbsolute(input);
  const api = pathApi(input);
  const normalizedInput = windows ? input.replace(/\//g, "\\") : input;
  const resolved = api.resolve(normalizedInput);
  const matchesHost = windows === (process.platform === "win32");
  if (!matchesHost) return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    // Watchers can report a path after an atomic rename or deletion, so the
    // leaf itself may no longer exist. Resolve the nearest existing ancestor.
    const missingSegments: string[] = [];
    let ancestor = resolved;
    let parent = api.dirname(ancestor);
    while (parent !== ancestor) {
      missingSegments.unshift(api.basename(ancestor));
      ancestor = parent;
      try {
        return api.join(realpathSync.native(ancestor), ...missingSegments);
      } catch {
        // Keep walking toward an existing ancestor.
      }
      parent = api.dirname(ancestor);
    }
    return resolved;
  }
}

/**
 * Resolve a public package-relative inventory path against its workspace.
 * The inventory path is always POSIX, while the workspace path keeps the
 * host's native drive/UNC/POSIX flavor. Canonicalization also resolves a
 * symlinked workspace before this value is compared with private context.
 */
export function inventorySourceRoot(
  scopeRoot: string,
  inventoryPath: string,
): string {
  const api = pathApi(scopeRoot);
  const joined =
    inventoryPath === "."
      ? scopeRoot
      : api.join(scopeRoot, ...inventoryPath.split("/"));
  return canonicalGraphPath(joined);
}

export function isWithinGraphPath(root: string, candidate: string): boolean {
  if (isWindowsAbsolute(root) !== isWindowsAbsolute(candidate)) return false;
  const api = pathApi(root);
  const relative = api.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(relative))
  );
}

/** Canonical registered roots contained by a workspace, safe for symlinked scopes. */
export function graphSourceRootsWithinScope(
  scopeRoot: string,
  sourceRoots: readonly string[],
): string[] {
  const canonicalScopeRoot = canonicalGraphPath(scopeRoot);
  return [
    ...new Set(
      sourceRoots
        .map(canonicalGraphPath)
        .filter((sourceRoot) =>
          isWithinGraphPath(canonicalScopeRoot, sourceRoot),
        ),
    ),
  ].sort();
}

/**
 * Attribute exact source edits to the deepest registered project roots.
 * A null path list is the polling/ambiguous-event fallback.
 */
export function dirtyGraphSourceRoots(
  scopeRoot: string,
  sourceRoots: readonly string[],
  sourcePaths: readonly string[] | null,
): string[] {
  const roots = graphSourceRootsWithinScope(scopeRoot, sourceRoots);
  if (sourcePaths === null) return roots;

  const dirty = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const canonicalSourcePath = canonicalGraphPath(sourcePath);
    const matches = roots.filter((sourceRoot) =>
      isWithinGraphPath(sourceRoot, canonicalSourcePath),
    );
    for (const match of matches) {
      if (
        !matches.some(
          (candidate) =>
            candidate !== match && isWithinGraphPath(match, candidate),
        )
      ) {
        dirty.add(match);
      }
    }
  }
  return [...dirty].sort();
}

function canonicalIdentity(value: string | null): string | null {
  const identity = value?.trim() ?? "";
  if (
    identity === "" ||
    identity === "." ||
    identity === ".." ||
    identity.startsWith("local:") ||
    hasControlCharacter(identity) ||
    identity.includes("/") ||
    identity.includes("\\") ||
    path.posix.isAbsolute(identity) ||
    path.win32.isAbsolute(identity)
  ) {
    return null;
  }
  return identity;
}

function safeLabel(value: string, fallback: string): string {
  const label = value.trim();
  if (
    label === "" ||
    hasControlCharacter(label) ||
    path.posix.isAbsolute(label) ||
    path.win32.isAbsolute(label)
  ) {
    return fallback;
  }
  return label;
}

function uniqueAliases(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function packageRelativePath(scopeRoot: string, workflowPath: string): string {
  const api = pathApi(scopeRoot);
  const relative = api.relative(scopeRoot, workflowPath);
  if (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  ) {
    return relative.split(api.sep).join("/");
  }
  if (relative === "") return ".";

  // A symlinked registry path can have a different lexical spelling. Its
  // canonical source was already proven inside the canonical scope.
  const canonicalScope = canonicalGraphPath(scopeRoot);
  const canonicalSource = canonicalGraphPath(workflowPath);
  const canonicalApi = pathApi(canonicalScope);
  const canonicalRelative = canonicalApi.relative(
    canonicalScope,
    canonicalSource,
  );
  return canonicalRelative === ""
    ? "."
    : canonicalRelative.split(canonicalApi.sep).join("/");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function buildWorkingTreeInventory(
  workspaceKey: WorkspaceKey,
  agents: PackageInventoryAgent[],
): PackageInventory {
  const status = agents.some((agent) => agent.identityStatus === "provisional")
    ? "degraded"
    : "complete";
  const normalized = packageInventorySchema.parse({
    protocol: PACKAGE_INVENTORY_PROTOCOL,
    version: {
      kind: "working-tree",
      workspaceKey,
      revision: ZERO_REVISION,
    },
    status,
    agents,
  });
  const revision = `sha256:${createHash("sha256")
    .update(
      stableJson({
        protocol: normalized.protocol,
        status: normalized.status,
        agents: normalized.agents,
      }),
    )
    .digest("hex")}` as const;
  return {
    ...normalized,
    version: { kind: "working-tree", workspaceKey, revision },
  };
}

interface PreparedAgent {
  canonicalName: string | null;
  candidateKey: AgentKey;
  fallbackKey: AgentKey;
  identityIssue: InventoryIdentityIssue | null;
  identitySettled: boolean;
  definitionId: number | null;
  definitionSlug: string | null;
  label: string;
  markerAlias: string | null;
  path: string;
  sourceRoot: string;
  workflowPath: string;
  warnOnIdentityFailure: boolean;
}

interface IdentityCacheEntry {
  fingerprint: string | null;
  inspection: ManifestNameInspection;
}

interface IdentityTask {
  sourceRoot: string;
  generation: number;
  epoch: number;
}

function preparedOrder(left: PreparedAgent, right: PreparedAgent): number {
  return (
    compareText(left.candidateKey, right.candidateKey) ||
    compareText(left.path, right.path) ||
    compareText(left.sourceRoot, right.sourceRoot)
  );
}

function warningOrder(
  left: AgentInventoryWarning,
  right: AgentInventoryWarning,
): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.agentKey, right.agentKey) ||
    compareText(left.message, right.message)
  );
}

function workflowRegistryOrder(
  scopeRoot: string,
  left: { workflow: WorkflowInfo; sourceRoot: string },
  right: { workflow: WorkflowInfo; sourceRoot: string },
): number {
  const leftWorkflow = left.workflow;
  const rightWorkflow = right.workflow;
  return (
    compareText(left.sourceRoot, right.sourceRoot) ||
    compareText(
      packageRelativePath(scopeRoot, leftWorkflow.path),
      packageRelativePath(scopeRoot, rightWorkflow.path),
    ) ||
    compareText(
      leftWorkflow.definitionSlug ?? "",
      rightWorkflow.definitionSlug ?? "",
    ) ||
    compareText(leftWorkflow.name, rightWorkflow.name) ||
    (leftWorkflow.definitionId ?? -1) - (rightWorkflow.definitionId ?? -1) ||
    compareText(leftWorkflow.source, rightWorkflow.source) ||
    compareText(leftWorkflow.path, rightWorkflow.path)
  );
}

/**
 * Local transition adapter from WorkflowRegistry to the public package
 * inventory contract. Registry reads are immediate. Source definition names
 * enrich provisional identities only after that first graph revision commits.
 */
export class HarnessRegistryInventoryProvider implements AgentInventoryProvider {
  private readonly identityCache = new Map<string, IdentityCacheEntry>();
  private readonly generations = new Map<string, number>();
  private readonly queuedTasks: IdentityTask[] = [];
  private readonly activeTasks = new Map<string, IdentityTask>();
  private readonly pendingIdentityChanges = new Set<string>();
  private activeInspections = 0;
  private identityChangeFlushInFlight = false;
  private identityChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private nextGeneration = 1;

  constructor(
    private readonly options: HarnessRegistryInventoryProviderOptions,
  ) {}

  async listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult> {
    const workflows = await this.options.listWorkflows();
    this.retainSources(
      new Set(workflows.map((workflow) => canonicalGraphPath(workflow.path))),
    );
    const canonicalScopeRoot = canonicalGraphPath(scope.root);
    const bySourceRoot = new Map<
      string,
      { workflow: WorkflowInfo; sourceRoot: string }
    >();
    const contained = workflows
      .map((workflow) => ({
        workflow,
        sourceRoot: canonicalGraphPath(workflow.path),
      }))
      .filter(({ sourceRoot }) =>
        isWithinGraphPath(canonicalScopeRoot, sourceRoot),
      )
      .sort((left, right) => workflowRegistryOrder(scope.root, left, right));
    for (const { workflow, sourceRoot } of contained) {
      // Registry persistence is expected to be unique by path. Keep the first
      // deterministic row if a corrupt/legacy file contains an exact duplicate.
      if (!bySourceRoot.has(sourceRoot)) {
        bySourceRoot.set(sourceRoot, { workflow, sourceRoot });
      }
    }

    const inspectionRoots: string[] = [];
    const prepared = [...bySourceRoot.values()]
      .map(({ workflow, sourceRoot }): PreparedAgent => {
        const inventoryPath = packageRelativePath(scope.root, workflow.path);
        const fallbackKey = `local:${
          inventoryPath === "." ? "root" : inventoryPath
        }` as AgentKey;
        const markerAlias = canonicalIdentity(workflow.definitionSlug);
        const cached = this.identityCache.get(sourceRoot);
        let canonicalName: string | null = null;
        let identityIssue: InventoryIdentityIssue | null = null;
        let identitySettled = true;
        let warnOnIdentityFailure = false;
        if (!this.options.inspectManifestName) {
          identityIssue = "identity-unavailable";
        } else {
          inspectionRoots.push(sourceRoot);
          this.ensureGeneration(sourceRoot);
          if (!cached) {
            identityIssue = "identity-pending";
            identitySettled = false;
          } else if (cached.inspection.status === "found") {
            canonicalName = canonicalIdentity(cached.inspection.name);
            if (!canonicalName) {
              identityIssue = "identity-invalid";
              warnOnIdentityFailure = true;
            }
          } else {
            identityIssue = "identity-unavailable";
            warnOnIdentityFailure = cached.inspection.status === "failed";
            identitySettled =
              cached.inspection.status !== "failed" ||
              !cached.inspection.retryable;
          }
        }
        const candidateKey = canonicalName ?? markerAlias ?? fallbackKey;
        return {
          canonicalName,
          candidateKey,
          fallbackKey,
          identityIssue,
          identitySettled,
          definitionId: workflow.definitionId,
          definitionSlug: markerAlias,
          label: safeLabel(
            workflow.name,
            canonicalName ?? markerAlias ?? fallbackKey.slice("local:".length),
          ),
          markerAlias,
          path: inventoryPath,
          sourceRoot,
          workflowPath: workflow.path,
          warnOnIdentityFailure,
        };
      })
      .sort(preparedOrder);

    const canonicalCounts = new Map<AgentKey, number>();
    const provisionalCounts = new Map<AgentKey, number>();
    for (const agent of prepared) {
      // An unsettled candidate is a guess, not a claim. Two agents that share
      // a registry marker while source identity is pending or retryable are
      // not yet a collision.
      if (!agent.identitySettled) continue;
      const counts = agent.canonicalName ? canonicalCounts : provisionalCounts;
      counts.set(agent.candidateKey, (counts.get(agent.candidateKey) ?? 0) + 1);
    }

    const warnings: AgentInventoryWarning[] = [];
    const candidates = new Set([
      ...canonicalCounts.keys(),
      ...provisionalCounts.keys(),
    ]);
    for (const candidateKey of [...candidates].sort(compareText)) {
      const canonicalCount = canonicalCounts.get(candidateKey) ?? 0;
      const provisionalCount = provisionalCounts.get(candidateKey) ?? 0;
      const ambiguous =
        canonicalCount > 1 || (canonicalCount === 0 && provisionalCount > 1);
      if (!ambiguous || canonicalIdentity(candidateKey) === null) continue;
      warnings.push({
        code: "duplicate-agent-key",
        agentKey: candidateKey,
        message: `Multiple agents use ${candidateKey}; kept each with a local identity.`,
      });
    }

    const used = new Set<AgentKey>();
    const publicAgents: PackageInventoryAgent[] = [];
    const context: AgentInventoryContextItem[] = [];
    for (const agent of prepared) {
      const canonicalCount = canonicalCounts.get(agent.candidateKey) ?? 0;
      const provisionalCount = provisionalCounts.get(agent.candidateKey) ?? 0;
      const safeCandidate = canonicalIdentity(agent.candidateKey) !== null;
      const duplicate =
        safeCandidate &&
        (agent.canonicalName
          ? canonicalCount > 1
          : canonicalCount > 1 ||
            (canonicalCount === 0 && provisionalCount > 1));
      const shadowedByCanonical =
        agent.canonicalName === null && canonicalCount === 1;
      let agentKey =
        duplicate || shadowedByCanonical
          ? agent.fallbackKey
          : agent.candidateKey;
      const base = agentKey;
      let suffix = 2;
      while (used.has(agentKey)) {
        agentKey = `${base}~${suffix}`;
        suffix += 1;
      }
      used.add(agentKey);

      const canonical = agent.canonicalName !== null && !duplicate;
      const identityIssue = duplicate
        ? "duplicate-agent-key"
        : agent.identityIssue;
      let publicAgent: PackageInventoryAgent;
      if (canonical) {
        publicAgent = {
          agentKey,
          identityStatus: "canonical",
          path: agent.path,
          entrypoint: ENTRYPOINT,
        };
      } else if (duplicate) {
        const candidateAgentKey = canonicalIdentity(agent.candidateKey);
        if (!candidateAgentKey) {
          throw new Error("Duplicate inventory identity had no safe candidate");
        }
        publicAgent = {
          agentKey,
          identityStatus: "provisional",
          identityIssue: "duplicate-agent-key",
          candidateAgentKey,
          path: agent.path,
          entrypoint: ENTRYPOINT,
        };
      } else {
        const provisionalIssue =
          identityIssue === "duplicate-agent-key" || identityIssue === null
            ? "identity-unavailable"
            : identityIssue;
        publicAgent = {
          agentKey,
          identityStatus: "provisional",
          identityIssue: provisionalIssue,
          path: agent.path,
          entrypoint: ENTRYPOINT,
        };
      }
      publicAgents.push(publicAgent);

      const resolutionAliases = uniqueAliases([
        agent.markerAlias,
        duplicate ? canonicalIdentity(agent.candidateKey) : null,
      ]);
      context.push({
        agentKey,
        definitionId: agent.definitionId,
        definitionSlug: agent.definitionSlug,
        label: agent.label,
        resolutionAliases,
        sourceRoot: agent.sourceRoot,
        workflowPath: agent.workflowPath,
        path: agent.path,
        entrypoint: ENTRYPOINT,
      });
      if (!canonical && agent.warnOnIdentityFailure && !duplicate) {
        warnings.push({
          code: "inventory-extraction-failed",
          agentKey,
          message: `Could not resolve ${agent.label}'s source identity; using its provisional identity.`,
        });
      }
    }

    const inventory = buildWorkingTreeInventory(
      scope.workspaceKey,
      publicAgents,
    );
    const contextByAgent = new Map(
      context.map((item) => [item.agentKey, item]),
    );
    const normalizedContext = inventory.agents.map((agent) => {
      const item = contextByAgent.get(agent.agentKey);
      if (!item) throw new Error("Package inventory context was incomplete");
      return item;
    });
    warnings.sort(warningOrder);
    const roots = [...new Set(inspectionRoots)].sort(compareText);
    const enrichmentEpoch = this.epoch;
    const tasks = roots.map((sourceRoot) => ({
      sourceRoot,
      generation: this.generations.get(sourceRoot)!,
      epoch: enrichmentEpoch,
    }));
    return {
      inventory,
      context: normalizedContext,
      warnings,
      identitySettled: prepared.every((agent) => agent.identitySettled),
      ...(roots.length > 0
        ? {
            startEnrichment: () =>
              this.enqueueInspections(tasks, enrichmentEpoch),
          }
        : {}),
    };
  }

  /** Drops settled/pending identity state after a relevant source edit. */
  invalidateSource(sourceRoot: string): void {
    const key = canonicalGraphPath(sourceRoot);
    this.identityCache.delete(key);
    this.generations.set(key, this.nextGeneration++);
    this.dropQueuedTasks(key);
    this.pendingIdentityChanges.delete(key);
    if (this.pendingIdentityChanges.size === 0) {
      this.clearIdentityChangeTimer();
    }
  }

  /** Explicit Retry may retry failures even when no source fingerprint changed. */
  retryFailedInspections(scope: WorkspaceScope): void {
    const root = canonicalGraphPath(scope.root);
    for (const [sourceRoot, cached] of this.identityCache) {
      if (
        isWithinGraphPath(root, sourceRoot) &&
        (cached.inspection.status === "failed" ||
          (cached.inspection.status === "found" &&
            canonicalIdentity(cached.inspection.name) === null))
      ) {
        this.invalidateSource(sourceRoot);
      }
    }
  }

  clear(): void {
    this.epoch += 1;
    this.identityCache.clear();
    this.generations.clear();
    this.queuedTasks.length = 0;
    this.pendingIdentityChanges.clear();
    this.clearIdentityChangeTimer();
  }

  /** Drops cache, queue, and generation state for retired source roots. */
  retainSources(sourceRoots: ReadonlySet<string>): void {
    const retained = new Set([...sourceRoots].map(canonicalGraphPath));
    const known = new Set([
      ...this.identityCache.keys(),
      ...this.generations.keys(),
      ...this.queuedTasks.map((task) => task.sourceRoot),
    ]);
    for (const sourceRoot of known) {
      if (retained.has(sourceRoot)) continue;
      this.identityCache.delete(sourceRoot);
      this.generations.delete(sourceRoot);
      this.dropQueuedTasks(sourceRoot);
      this.pendingIdentityChanges.delete(sourceRoot);
    }
    if (this.pendingIdentityChanges.size === 0) {
      this.clearIdentityChangeTimer();
    }
  }

  private enqueueInspections(
    tasks: readonly IdentityTask[],
    requestedEpoch: number,
  ): void {
    if (!this.options.inspectManifestName || requestedEpoch !== this.epoch) {
      return;
    }
    for (const task of tasks) {
      if (!this.isCurrentTask(task)) continue;
      this.dropQueuedTasks(task.sourceRoot);
      const active = this.activeTasks.get(task.sourceRoot);
      if (
        active?.generation === task.generation &&
        active.epoch === task.epoch
      ) {
        continue;
      }
      this.queuedTasks.push(task);
    }
    this.drainInspectionQueue();
  }

  private drainInspectionQueue(): void {
    for (let index = this.queuedTasks.length - 1; index >= 0; index -= 1) {
      if (!this.isCurrentTask(this.queuedTasks[index]!)) {
        this.queuedTasks.splice(index, 1);
      }
    }
    while (this.activeInspections < MANIFEST_INSPECTION_CONCURRENCY) {
      const index = this.queuedTasks.findIndex(
        (task) => !this.activeTasks.has(task.sourceRoot),
      );
      if (index === -1) break;
      const [task] = this.queuedTasks.splice(index, 1);
      if (!task || !this.isCurrentTask(task)) continue;
      this.activeTasks.set(task.sourceRoot, task);
      this.activeInspections += 1;
      void this.inspectSource(task).finally(() => {
        if (this.activeTasks.get(task.sourceRoot) === task) {
          this.activeTasks.delete(task.sourceRoot);
          this.activeInspections -= 1;
        }
        this.drainInspectionQueue();
      });
    }
    this.scheduleIdentityChangeFlush();
  }

  private async inspectSource(task: IdentityTask): Promise<void> {
    const inspect = this.options.inspectManifestName;
    if (!inspect || !this.isCurrentTask(task)) return;
    let fingerprint: string | null = null;
    let inspection: ManifestNameInspection;
    try {
      fingerprint = await (
        this.options.fingerprintSource ?? fingerprintWorkflowSources
      )(task.sourceRoot);
      if (!this.isCurrentTask(task)) return;
      const hit = this.identityCache.get(task.sourceRoot);
      if (hit?.fingerprint === fingerprint) return;
      inspection = await inspect(task.sourceRoot);
    } catch {
      if (!this.isCurrentTask(task)) return;
      const hit = this.identityCache.get(task.sourceRoot);
      if (fingerprint === null && hit) return;
      // The inspector threw, so nothing proved this unchanged source can never
      // resolve. Preserve the Retry path instead of freezing a provisional ID.
      inspection = { status: "failed", retryable: true };
    }
    if (!this.isCurrentTask(task)) return;
    this.identityCache.set(task.sourceRoot, { fingerprint, inspection });
    this.pendingIdentityChanges.add(task.sourceRoot);
    this.scheduleIdentityChangeFlush();
  }

  private scheduleIdentityChangeFlush(): void {
    if (this.pendingIdentityChanges.size === 0) return;
    if (this.activeInspections === 0 && this.queuedTasks.length === 0) {
      this.clearIdentityChangeTimer();
      this.flushIdentityChanges();
      return;
    }
    if (this.identityChangeFlushInFlight || this.identityChangeTimer !== null) {
      return;
    }
    this.identityChangeTimer = setTimeout(() => {
      this.identityChangeTimer = null;
      this.flushIdentityChanges();
    }, this.options.identityChangeCoalesceMs ?? IDENTITY_CHANGE_COALESCE_MS);
  }

  private flushIdentityChanges(): void {
    if (
      this.identityChangeFlushInFlight ||
      this.pendingIdentityChanges.size === 0
    ) {
      return;
    }
    this.clearIdentityChangeTimer();
    const sourceRoots = [...this.pendingIdentityChanges].sort(compareText);
    this.pendingIdentityChanges.clear();
    const notify = this.options.onIdentityChange;
    if (!notify) return;

    this.identityChangeFlushInFlight = true;
    void Promise.resolve()
      .then(() => notify(sourceRoots))
      .catch(() => {
        // A refresh hint cannot make settled identity results disappear.
      })
      .finally(() => {
        this.identityChangeFlushInFlight = false;
        this.scheduleIdentityChangeFlush();
      });
  }

  private clearIdentityChangeTimer(): void {
    if (this.identityChangeTimer === null) return;
    clearTimeout(this.identityChangeTimer);
    this.identityChangeTimer = null;
  }

  private dropQueuedTasks(sourceRoot: string): void {
    for (let index = this.queuedTasks.length - 1; index >= 0; index -= 1) {
      if (this.queuedTasks[index]!.sourceRoot === sourceRoot) {
        this.queuedTasks.splice(index, 1);
      }
    }
  }

  private isCurrentTask(task: IdentityTask): boolean {
    return (
      task.epoch === this.epoch &&
      task.generation === this.generations.get(task.sourceRoot)
    );
  }

  private ensureGeneration(sourceRoot: string): number {
    const existing = this.generations.get(sourceRoot);
    if (existing !== undefined) return existing;
    const generation = this.nextGeneration++;
    this.generations.set(sourceRoot, generation);
    return generation;
  }
}
