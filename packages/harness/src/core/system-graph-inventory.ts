import { realpathSync } from "node:fs";
import * as path from "node:path";

import type {
  AgentKey,
  GraphWarning,
  WorkspaceKey,
} from "../shared/system-graph.js";
import type { WorkflowInfo } from "../shared/types.js";
import type { ManifestNameInspection } from "./definition-name.js";

export interface WorkspaceScope {
  workspaceKey: WorkspaceKey;
  root: string;
}

export interface AgentInventoryItem {
  agentKey: AgentKey;
  /** Internal deployment provenance. Never serialize this into SystemGraph. */
  definitionId: number | null;
  definitionSlug: string | null;
  label: string;
  resolutionAliases: string[];
  /** Internal filesystem evidence. Never serialize this into SystemGraph. */
  sourceRoot: string;
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
  agents: AgentInventoryItem[];
  /** False when a later graph open should retry degraded enrichment. */
  cacheable: boolean;
  warnings: AgentInventoryWarning[];
}

/** Read-only boundary between Studio's current registry and graph projection. */
export interface AgentInventoryProvider {
  listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult>;
}

type ManifestNameInspector = (
  sourceRoot: string,
) => Promise<ManifestNameInspection>;

export interface HarnessRegistryInventoryProviderOptions {
  listWorkflows: () =>
    | readonly WorkflowInfo[]
    | Promise<readonly WorkflowInfo[]>;
  inspectManifestName?: ManifestNameInspector;
  /** Test seam; production keeps the default first-open latency budget. */
  manifestInspectionBudgetMs?: number;
}

const MANIFEST_INSPECTION_CONCURRENCY = 4;
// Individual extraction can wait 15 s; inventory must return well before that.
const MANIFEST_INSPECTION_BUDGET_MS = 5_000;

async function mapWithDeadline<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  budgetMs: number,
  map: (value: Input) => Promise<Output>,
): Promise<Array<Output | undefined>> {
  const results = new Array<Output | undefined>(values.length);
  let nextIndex = 0;
  let deadlineReached = false;
  const worker = async (): Promise<void> => {
    while (!deadlineReached && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await map(values[index]!);
      } catch {
        // The caller turns every unfinished/failed item into partial inventory.
      }
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker(),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      resolve();
    }, budgetMs);
  });
  await Promise.race([workers, deadline]);
  if (!deadlineReached && timer) clearTimeout(timer);
  // Already-started production inspections have their own 15 s timeout. Do
  // not await them, and prevent workers from starting any more after the cap.
  void workers;
  return results.slice();
}

function isWindowsAbsolute(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input);
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
    // leaf itself may no longer exist. Resolve the nearest existing ancestor
    // and append the missing tail; otherwise a symlinked workspace would stop
    // matching exactly when targeted invalidation matters most.
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
 * A null path list is the polling/ambiguous-event fallback and dirties every
 * caller in the scope.
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

export function workspaceRelativeLocalKey(
  scopeRoot: string,
  sourceRoot: string,
): AgentKey {
  const api = pathApi(scopeRoot);
  const relative = api.relative(scopeRoot, sourceRoot);
  const local =
    relative === ""
      ? api.basename(sourceRoot) || "root"
      : relative.split(api.sep).join("/");
  return `local:${local}`;
}

function normalizedAlias(value: string | null): string | null {
  const alias = value?.trim() ?? "";
  if (
    alias === "" ||
    /[\0\r\n]/.test(alias) ||
    alias.includes("/") ||
    alias.includes("\\") ||
    path.posix.isAbsolute(alias) ||
    path.win32.isAbsolute(alias)
  ) {
    return null;
  }
  return alias;
}

function safeLabel(value: string, fallback: string): string {
  const label = value.trim();
  if (
    label === "" ||
    /[\0\r\n]/.test(label) ||
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
  ];
}

interface PreparedAgent {
  candidateKey: AgentKey;
  fallbackKey: AgentKey;
  definitionId: number | null;
  definitionSlug: string | null;
  extractionFailed: boolean;
  label: string;
  resolutionAliases: string[];
  sourceRoot: string;
}

function preparedOrder(left: PreparedAgent, right: PreparedAgent): number {
  return (
    left.candidateKey.localeCompare(right.candidateKey) ||
    left.sourceRoot.localeCompare(right.sourceRoot) ||
    left.label.localeCompare(right.label)
  );
}

function warningOrder(
  left: AgentInventoryWarning,
  right: AgentInventoryWarning,
): number {
  return (
    left.code.localeCompare(right.code) ||
    left.agentKey.localeCompare(right.agentKey) ||
    left.message.localeCompare(right.message)
  );
}

/**
 * V0 inventory adapter. WorkflowRegistry's scan/connect flows remain the only
 * writers; this provider receives snapshots and performs no discovery. The
 * injected manifest-name inspection may run cached extraction, so enrichment
 * has both a concurrency cap and a wall-clock budget on a cold graph open.
 */
export class HarnessRegistryInventoryProvider implements AgentInventoryProvider {
  constructor(
    private readonly options: HarnessRegistryInventoryProviderOptions,
  ) {}

  async listAgents(scope: WorkspaceScope): Promise<AgentInventoryResult> {
    // A registry read is the one operation whose failure makes inventory
    // unavailable. Scope-catalog and per-agent enrichment failures degrade.
    const workflows = await this.options.listWorkflows();
    const selectedScope: WorkspaceScope = {
      workspaceKey: scope.workspaceKey,
      root: canonicalGraphPath(scope.root),
    };
    // Project-axis membership is containment in the SELECTED root. An agent can
    // therefore appear in both a parent project's graph and a separately-opened
    // nested project's graph, exactly as it appears under both project rows in
    // the rail. Deepest-scope ownership made the parent row visibly list agents
    // that disappeared when its graph opened.
    const contained = workflows
      .map((workflow) => ({
        workflow,
        sourceRoot: canonicalGraphPath(workflow.path),
      }))
      .filter(({ sourceRoot }) =>
        isWithinGraphPath(selectedScope.root, sourceRoot),
      );

    const inspections = await mapWithDeadline(
      contained,
      MANIFEST_INSPECTION_CONCURRENCY,
      this.options.manifestInspectionBudgetMs ?? MANIFEST_INSPECTION_BUDGET_MS,
      ({ workflow, sourceRoot }) =>
        this.prepareAgent(selectedScope, workflow, sourceRoot),
    );
    const prepared = Array.from(
      { length: contained.length },
      (_, index) =>
        inspections[index] ??
        this.prepareFallbackAgent(
          selectedScope,
          contained[index]!.workflow,
          contained[index]!.sourceRoot,
        ),
    ).sort(preparedOrder);

    const candidateCounts = new Map<AgentKey, number>();
    for (const agent of prepared) {
      candidateCounts.set(
        agent.candidateKey,
        (candidateCounts.get(agent.candidateKey) ?? 0) + 1,
      );
    }

    const used = new Set<AgentKey>();
    const assigned = prepared.map((agent) => {
      const duplicate = (candidateCounts.get(agent.candidateKey) ?? 0) > 1;
      let agentKey = duplicate ? agent.fallbackKey : agent.candidateKey;
      if (used.has(agentKey)) agentKey = agent.fallbackKey;
      let suffix = 2;
      const base = agentKey;
      while (used.has(agentKey)) {
        agentKey = `${base}~${suffix}`;
        suffix += 1;
      }
      used.add(agentKey);
      return { agent, agentKey };
    });

    const warnings: AgentInventoryWarning[] = [];
    for (const candidateKey of [...candidateCounts.keys()].sort()) {
      if ((candidateCounts.get(candidateKey) ?? 0) < 2) continue;
      warnings.push({
        code: "duplicate-agent-key",
        agentKey: candidateKey,
        message: `Multiple agents use ${candidateKey}; kept each with a local identity.`,
      });
    }
    for (const { agent, agentKey } of assigned) {
      if (!agent.extractionFailed) continue;
      warnings.push({
        code: "inventory-extraction-failed",
        agentKey,
        message: `Could not inspect ${agent.label}; using its local identity.`,
      });
    }

    const agents = assigned
      .map(
        ({ agent, agentKey }): AgentInventoryItem => ({
          agentKey,
          definitionId: agent.definitionId,
          definitionSlug: agent.definitionSlug,
          label: agent.label,
          resolutionAliases: agent.resolutionAliases,
          sourceRoot: agent.sourceRoot,
        }),
      )
      .sort(
        (left, right) =>
          left.agentKey.localeCompare(right.agentKey) ||
          left.sourceRoot.localeCompare(right.sourceRoot),
      );

    warnings.sort(warningOrder);
    return {
      agents,
      cacheable: prepared.every((agent) => !agent.extractionFailed),
      warnings,
    };
  }

  private async prepareAgent(
    scope: WorkspaceScope,
    workflow: WorkflowInfo,
    sourceRoot: string,
  ): Promise<PreparedAgent> {
    const definitionSlug = normalizedAlias(workflow.definitionSlug);
    let manifestName: string | null = null;
    let extractionFailed = false;
    if (!definitionSlug && this.options.inspectManifestName) {
      try {
        const inspected = await this.options.inspectManifestName(sourceRoot);
        if (inspected.status === "found") {
          manifestName = normalizedAlias(inspected.name);
        } else {
          extractionFailed = inspected.status === "failed";
        }
      } catch {
        extractionFailed = true;
      }
    }

    const fallbackKey = workspaceRelativeLocalKey(scope.root, sourceRoot);
    const candidateKey = definitionSlug ?? manifestName ?? fallbackKey;
    // Keep the pre-disambiguation candidate as an alias for every copy. When
    // duplicate local fallbacks exist, a caller targeting that candidate must
    // see ambiguity rather than silently resolving to the unsuffixed copy.
    const resolutionAliases = uniqueAliases([
      definitionSlug,
      manifestName,
      candidateKey,
    ]);
    return {
      candidateKey,
      fallbackKey,
      definitionId: workflow.definitionId,
      definitionSlug,
      extractionFailed,
      label: safeLabel(
        workflow.name,
        definitionSlug ??
          manifestName ??
          (fallbackKey.slice("local:".length) || "Local agent"),
      ),
      resolutionAliases,
      sourceRoot,
    };
  }

  private prepareFallbackAgent(
    scope: WorkspaceScope,
    workflow: WorkflowInfo,
    sourceRoot: string,
  ): PreparedAgent {
    const definitionSlug = normalizedAlias(workflow.definitionSlug);
    const fallbackKey = workspaceRelativeLocalKey(scope.root, sourceRoot);
    const candidateKey = definitionSlug ?? fallbackKey;
    return {
      candidateKey,
      fallbackKey,
      definitionId: workflow.definitionId,
      definitionSlug,
      extractionFailed: !definitionSlug,
      label: safeLabel(
        workflow.name,
        definitionSlug ?? (fallbackKey.slice("local:".length) || "Local agent"),
      ),
      resolutionAliases: [candidateKey],
      sourceRoot,
    };
  }
}
