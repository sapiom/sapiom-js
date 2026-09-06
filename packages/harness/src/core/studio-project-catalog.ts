import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  STUDIO_PROJECT_CATALOG_SCHEMA_VERSION,
  type AgentMapErrorCode,
  type ProjectRootBindingStatus,
  type StudioProjectId,
  type StudioProjectSummary,
} from "../shared/agent-map.js";
import type { WorkspaceScopeSummary } from "../shared/system-graph.js";
import { resolveProjectRootForPath } from "../shared/project-roots.js";
import { pathComparisonKey } from "../shared/paths.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import {
  DurableFileLock,
  type DurableFileLockTestHooks,
} from "./durable-file-lock.js";

export interface ProjectRootBinding {
  id: string;
  repositoryId: string | null;
  /** Server-private canonical path reference. Never included in public JSON. */
  localRootRef: string;
  status: ProjectRootBindingStatus;
}

export interface StudioProjectIdentity {
  projectId: StudioProjectId;
  identityVersion: number;
  displayName: string;
  rootBindings: ProjectRootBinding[];
  /** Migration lookup only; never canonical identity or public map data. */
  legacyWorkspaceKeys: string[];
  createdAt: string;
  updatedAt: string;
}

interface PersistedStudioProjectCatalog {
  schemaVersion: number;
  projects: StudioProjectIdentity[];
}

export interface ReconciledStudioProjects {
  projects: StudioProjectSummary[];
  workspaceScopes: WorkspaceScopeSummary[];
}

/** Path-free server result used to scope session capabilities. */
export interface ResolvedStudioProjectIdentity {
  projectId: StudioProjectId;
  identityVersion: number;
  displayName: string;
}

export class StudioProjectCatalogError extends Error {
  constructor(readonly code: Exclude<AgentMapErrorCode, "project_not_found">) {
    super(
      code === "unsupported_schema"
        ? "Studio project state uses an unsupported schema"
        : code === "malformed_state"
          ? "Studio project state is malformed"
          : "Studio project storage is unavailable",
    );
    this.name = "StudioProjectCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

/** Filesystem names may legally begin or end with spaces on macOS/POSIX. */
function isSafePathText(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "" && !hasControlCharacter(value)
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    isSafeText(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":")
  );
}

function isSafeDisplayName(value: unknown): value is string {
  return isSafeText(value) && !value.includes("/") && !value.includes("\\");
}

export function isStudioProjectId(value: unknown): value is StudioProjectId {
  return (
    typeof value === "string" &&
    /^project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isBindingId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^root_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseBinding(value: unknown): ProjectRootBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "repositoryId", "localRootRef", "status"]) ||
    !isBindingId(value.id) ||
    (value.repositoryId !== null && !isOpaqueId(value.repositoryId)) ||
    !isSafePathText(value.localRootRef) ||
    (!path.posix.isAbsolute(value.localRootRef) &&
      !path.win32.isAbsolute(value.localRootRef)) ||
    (value.status !== "active" && value.status !== "missing")
  ) {
    return null;
  }
  return {
    id: value.id,
    repositoryId: value.repositoryId,
    localRootRef: value.localRootRef,
    status: value.status,
  };
}

function parseProject(value: unknown): StudioProjectIdentity | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectId",
      "identityVersion",
      "displayName",
      "rootBindings",
      "legacyWorkspaceKeys",
      "createdAt",
      "updatedAt",
    ]) ||
    !isStudioProjectId(value.projectId) ||
    !Number.isSafeInteger(value.identityVersion) ||
    (value.identityVersion as number) < 1 ||
    !isSafeDisplayName(value.displayName) ||
    !Array.isArray(value.rootBindings) ||
    !Array.isArray(value.legacyWorkspaceKeys) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  const rootBindings = value.rootBindings.map(parseBinding);
  if (
    rootBindings.some((binding) => binding === null) ||
    value.legacyWorkspaceKeys.some((key) => !isSafeText(key))
  ) {
    return null;
  }
  const bindings = rootBindings as ProjectRootBinding[];
  const keys = value.legacyWorkspaceKeys as string[];
  if (
    new Set(bindings.map((binding) => binding.id)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.localRootRef)).size !== bindings.length ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  return {
    projectId: value.projectId,
    identityVersion: value.identityVersion as number,
    displayName: value.displayName,
    rootBindings: bindings,
    legacyWorkspaceKeys: keys,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseCatalog(value: unknown): PersistedStudioProjectCatalog & { migrated: boolean } {
  if (
    isRecord(value) &&
    Number.isSafeInteger(value.schemaVersion) &&
    (value.schemaVersion as number) > STUDIO_PROJECT_CATALOG_SCHEMA_VERSION
  ) {
    throw new StudioProjectCatalogError("unsupported_schema");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "projects"]) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    !Array.isArray(value.projects)
  ) {
    throw new StudioProjectCatalogError("malformed_state");
  }
  if (value.schemaVersion !== STUDIO_PROJECT_CATALOG_SCHEMA_VERSION) {
    throw new StudioProjectCatalogError(
      (value.schemaVersion as number) > STUDIO_PROJECT_CATALOG_SCHEMA_VERSION
        ? "unsupported_schema"
        : "malformed_state",
    );
  }
  const projects = value.projects.map(parseProject);
  if (projects.some((project) => project === null)) {
    throw new StudioProjectCatalogError("malformed_state");
  }
  const parsed = projects as StudioProjectIdentity[];
  const bindingIds = parsed.flatMap((project) =>
    project.rootBindings.map((binding) => binding.id),
  );
  const roots = parsed.flatMap((project) =>
    project.rootBindings.map((binding) => binding.localRootRef),
  );
  const legacyKeys = parsed.flatMap((project) => project.legacyWorkspaceKeys);
  if (
    new Set(parsed.map((project) => project.projectId)).size !==
      parsed.length ||
    new Set(bindingIds).size !== bindingIds.length ||
    new Set(roots).size !== roots.length ||
    new Set(legacyKeys).size !== legacyKeys.length
  ) {
    throw new StudioProjectCatalogError("malformed_state");
  }
  // Older catalogs allowed differently cased Windows spellings of one root.
  // Validate that persisted format first, then collapse aliases within their
  // existing project. Keep separate project IDs: their map state cannot be
  // merged implicitly, and ambiguous roots remain unassigned by reconcile.
  let migrated = false;
  for (const project of parsed) {
    const bindings = new Map<string, ProjectRootBinding>();
    for (const binding of project.rootBindings) {
      const key = pathComparisonKey(binding.localRootRef);
      const previous = bindings.get(key);
      if (previous) {
        if (binding.status === "active") previous.status = "active";
        migrated = true;
      } else {
        bindings.set(key, binding);
      }
    }
    project.rootBindings = [...bindings.values()];
  }
  return {
    schemaVersion: STUDIO_PROJECT_CATALOG_SCHEMA_VERSION,
    projects: parsed,
    migrated,
  };
}

function publicSummary(project: StudioProjectIdentity): StudioProjectSummary {
  return {
    projectId: project.projectId,
    identityVersion: project.identityVersion,
    displayName: project.displayName,
    bindings: project.rootBindings
      .map(({ id, status }) => ({ id, status }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function cloneProjects(
  projects: readonly StudioProjectIdentity[],
): StudioProjectIdentity[] {
  return projects.map((project) => ({
    ...project,
    rootBindings: project.rootBindings.map((binding) => ({ ...binding })),
    legacyWorkspaceKeys: [...project.legacyWorkspaceKeys],
  }));
}

function sortProjects(projects: StudioProjectIdentity[]): void {
  projects.sort((left, right) => left.projectId.localeCompare(right.projectId));
  for (const project of projects) {
    project.rootBindings.sort((left, right) => left.id.localeCompare(right.id));
    project.legacyWorkspaceKeys.sort((left, right) =>
      left.localeCompare(right),
    );
  }
}

function storageError(): StudioProjectCatalogError {
  return new StudioProjectCatalogError("storage_unavailable");
}

/** Internal deterministic seams used only by file-lock race regressions. */
export type StudioProjectCatalogLockTestHooks = DurableFileLockTestHooks;

export interface StudioProjectCatalogLifecycleHooks {
  /**
   * Runs under the catalog lock before newly allocated project identities are
   * committed. A durable write-ahead consumer can make the subsequent catalog
   * commit recoverable without changing the public project schema.
   */
  beforeProjectsCreatedCommit?: (
    projects: readonly StudioProjectSummary[],
  ) => void | Promise<void>;
  /**
   * Runs after both the catalog file and this instance reflect the committed
   * identities. Delivery may be retried, so consumers must be project-keyed
   * and idempotent.
   */
  afterProjectsCreatedCommit?: (
    projects: readonly StudioProjectSummary[],
  ) => void | Promise<void>;
}

/**
 * Durable, serialized owner of Studio project identity. Catalog reads never
 * run package inventory or source discovery; callers provide the already
 * allow-listed workspace scopes they want reconciled.
 */
export class StudioProjectCatalog {
  private projects: StudioProjectIdentity[] | null = null;
  private loadPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private migrationPending = false;

  constructor(
    private readonly catalogPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly lockTestHooks: StudioProjectCatalogLockTestHooks = {},
    private readonly lifecycleHooks: StudioProjectCatalogLifecycleHooks = {},
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const lockedOperation = async (): Promise<T> => {
      const release = await this.acquireFileLock();
      try {
        // CLI and Electron share one state root. Always re-read after taking
        // the cross-instance lock so a whole-catalog atomic rewrite includes
        // identities committed by another live host.
        await this.load(true);
        if (this.migrationPending) {
          // Read-only callers can use repaired identities immediately. Commit
          // the repair only under the same cross-host lock as other writes.
          await this.persist(this.projects!);
          this.migrationPending = false;
        }
        return await operation();
      } finally {
        await release();
      }
    };
    const result = this.mutationQueue.then(lockedOperation, lockedOperation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    return new DurableFileLock(this.catalogPath, {
      hooks: this.lockTestHooks,
      storageError,
    }).acquire();
  }

  private async load(force = false): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise;
      // A forced mutation read may have joined a read that began before this
      // instance acquired the file lock. Read once more while holding the lock
      // so the mutation cannot commit from that potentially stale snapshot.
      if (!force) return;
    }
    if (!force && this.projects !== null) return;
    this.loadPromise = (async () => {
      let raw: string;
      try {
        raw = await fs.readFile(this.catalogPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.projects = [];
          this.migrationPending = false;
          return;
        }
        throw storageError();
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw) as unknown;
      } catch {
        throw new StudioProjectCatalogError("malformed_state");
      }
      const parsed = parseCatalog(decoded);
      this.projects = parsed.projects;
      this.migrationPending = parsed.migrated;
    })().finally(() => {
      this.loadPromise = null;
    });
    await this.loadPromise;
  }

  private async persist(projects: StudioProjectIdentity[]): Promise<void> {
    sortProjects(projects);
    const directory = path.dirname(this.catalogPath);
    const temporary = `${this.catalogPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        temporary,
        `${JSON.stringify(
          {
            schemaVersion: STUDIO_PROJECT_CATALOG_SCHEMA_VERSION,
            projects,
          } satisfies PersistedStudioProjectCatalog,
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.rename(temporary, this.catalogPath);
    } catch {
      throw storageError();
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async list(): Promise<StudioProjectSummary[]> {
    await this.mutationQueue;
    await this.load(true);
    return this.projects!.map(publicSummary);
  }

  /**
   * Resolves a cwd to the most-specific active durable project root. Local
   * roots remain private; ambiguous equal-specificity matches fail closed.
   */
  async resolveIdentityForPath(
    cwd: string,
  ): Promise<ResolvedStudioProjectIdentity | null> {
    await this.mutationQueue;
    await this.load(true);
    let canonical: string;
    try {
      canonical = canonicalGraphPath(cwd);
    } catch {
      return null;
    }
    const match = resolveProjectRootForPath(
      canonical,
      this.projects!.flatMap((project) =>
        project.rootBindings
          .filter(({ status }) => status === "active")
          .flatMap((binding) => {
            try {
              const root = canonicalGraphPath(binding.localRootRef);
              return [{ projectId: project.projectId, cwd: root, project }];
            } catch {
              return [];
            }
          }),
      ),
    );
    if (!match) return null;
    const project = match.project;
    return {
      projectId: project.projectId,
      identityVersion: project.identityVersion,
      displayName: project.displayName,
    };
  }

  async create(displayName: string): Promise<StudioProjectSummary> {
    if (!isSafeDisplayName(displayName)) {
      throw new StudioProjectCatalogError("malformed_state");
    }
    return this.enqueue(async () => {
      await this.load();
      const timestamp = this.timestamp();
      const project: StudioProjectIdentity = {
        projectId: `project_${randomUUID()}`,
        identityVersion: 1,
        displayName,
        rootBindings: [],
        legacyWorkspaceKeys: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = [...cloneProjects(this.projects!), project];
      await this.lifecycleHooks.beforeProjectsCreatedCommit?.([
        publicSummary(project),
      ]);
      await this.persist(next);
      this.projects = next;
      const summary = publicSummary(project);
      await this.lifecycleHooks.afterProjectsCreatedCommit?.([summary]);
      return summary;
    });
  }

  /**
   * Reconciles existing allow-listed roots and allocates an identity only for
   * roots not already known by private binding or migration alias.
   */
  async reconcile(
    scopes: readonly WorkspaceScopeSummary[],
  ): Promise<ReconciledStudioProjects> {
    return this.enqueue(async () => {
      await this.load();
      const next = cloneProjects(this.projects!);
      const dedupedScopes = new Map<
        string,
        { scope: WorkspaceScopeSummary; canonical: string }
      >();
      const unassignedScopes: WorkspaceScopeSummary[] = [];
      const canonicalScopes: Array<{
        scope: WorkspaceScopeSummary;
        canonical: string;
      }> = [];
      const rootsByLegacyKey = new Map<string, Set<string>>();
      for (const scope of scopes) {
        // Workspace scopes are live operational input, not persisted catalog
        // state. One unsafe/unrepresentable path must not poison every valid
        // project read. Spaces at either end remain valid path characters.
        if (!isSafeText(scope.workspaceKey) || !isSafePathText(scope.cwd)) {
          unassignedScopes.push({
            workspaceKey: scope.workspaceKey,
            cwd: scope.cwd,
          });
          continue;
        }
        let canonical: string;
        try {
          canonical = canonicalGraphPath(scope.cwd);
        } catch {
          unassignedScopes.push({
            workspaceKey: scope.workspaceKey,
            cwd: scope.cwd,
          });
          continue;
        }
        canonicalScopes.push({ scope, canonical });
        const roots = rootsByLegacyKey.get(scope.workspaceKey) ?? new Set();
        roots.add(pathComparisonKey(canonical));
        rootsByLegacyKey.set(scope.workspaceKey, roots);
      }

      const conflictingLegacyKeys = new Set(
        [...rootsByLegacyKey]
          .filter(([, roots]) => roots.size > 1)
          .map(([workspaceKey]) => workspaceKey),
      );
      for (const { scope, canonical } of canonicalScopes) {
        // Decide alias conflicts as a group before assigning anything. Input
        // order must not let the first member mint a durable identity while
        // later members with the same legacy key remain ambiguous.
        if (conflictingLegacyKeys.has(scope.workspaceKey)) {
          unassignedScopes.push({
            workspaceKey: scope.workspaceKey,
            cwd: scope.cwd,
          });
          continue;
        }
        const comparisonKey = pathComparisonKey(canonical);
        if (!dedupedScopes.has(comparisonKey)) {
          // Canonical form is private matching evidence only. Preserve the
          // existing lexical cwd in AppState so this additive join cannot
          // perturb legacy rail/session path equality.
          dedupedScopes.set(comparisonKey, {
            scope: { ...scope },
            canonical,
          });
        }
      }

      const activeRoots = new Set(dedupedScopes.keys());
      let changed = false;
      for (const project of next) {
        let projectChanged = false;
        for (const binding of project.rootBindings) {
          const status = activeRoots.has(
            pathComparisonKey(binding.localRootRef),
          )
            ? "active"
            : "missing";
          if (binding.status !== status) {
            binding.status = status;
            projectChanged = true;
          }
        }
        if (projectChanged) {
          project.identityVersion += 1;
          project.updatedAt = this.timestamp();
          changed = true;
        }
      }

      const reconciledScopes: WorkspaceScopeSummary[] = [];
      const createdProjects: StudioProjectIdentity[] = [];
      for (const { canonical, scope } of dedupedScopes.values()) {
        const matchingProjects = next.filter(
          (candidate) =>
            candidate.legacyWorkspaceKeys.includes(scope.workspaceKey) ||
            candidate.rootBindings.some(
              (binding) =>
                pathComparisonKey(binding.localRootRef) ===
                pathComparisonKey(canonical),
            ),
        );
        if (matchingProjects.length > 1) {
          unassignedScopes.push({ workspaceKey: scope.workspaceKey, cwd: scope.cwd });
          continue;
        }
        let project = matchingProjects[0];
        if (!project) {
          const timestamp = this.timestamp();
          project = {
            projectId: `project_${randomUUID()}`,
            identityVersion: 1,
            displayName: path.basename(canonical).trim() || "Project",
            rootBindings: [
              {
                id: `root_${randomUUID()}`,
                repositoryId: null,
                localRootRef: canonical,
                status: "active",
              },
            ],
            legacyWorkspaceKeys: [scope.workspaceKey],
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          next.push(project);
          createdProjects.push(project);
          changed = true;
        } else {
          let projectChanged = false;
          if (!project.legacyWorkspaceKeys.includes(scope.workspaceKey)) {
            project.legacyWorkspaceKeys.push(scope.workspaceKey);
            projectChanged = true;
          }
          let binding = project.rootBindings.find(
            (candidate) =>
              pathComparisonKey(candidate.localRootRef) ===
              pathComparisonKey(canonical),
          );
          if (!binding) {
            binding = {
              id: `root_${randomUUID()}`,
              repositoryId: null,
              localRootRef: canonical,
              status: "active",
            };
            project.rootBindings.push(binding);
            projectChanged = true;
          } else if (binding.status !== "active") {
            binding.status = "active";
            projectChanged = true;
          }
          if (projectChanged) {
            project.identityVersion += 1;
            project.updatedAt = this.timestamp();
            changed = true;
          }
        }
        reconciledScopes.push({ ...scope, projectId: project.projectId });
      }

      if (changed) {
        if (createdProjects.length > 0) {
          await this.lifecycleHooks.beforeProjectsCreatedCommit?.(
            createdProjects.map(publicSummary),
          );
        }
        await this.persist(next);
        this.projects = next;
        if (createdProjects.length > 0) {
          await this.lifecycleHooks.afterProjectsCreatedCommit?.(
            createdProjects.map(publicSummary),
          );
        }
      }
      return {
        projects: (changed ? next : this.projects!).map(publicSummary),
        workspaceScopes: [...unassignedScopes, ...reconciledScopes].sort(
          (left, right) => left.cwd.localeCompare(right.cwd),
        ),
      };
    });
  }

  /** Resolve only identities owned by this durable local catalog. */
  async resolve(
    projectId: StudioProjectId,
  ): Promise<StudioProjectSummary | null> {
    if (!isStudioProjectId(projectId)) return null;
    await this.mutationQueue;
    await this.load(true);
    const project = this.projects!.find(
      (candidate) => candidate.projectId === projectId,
    );
    return project ? publicSummary(project) : null;
  }

  /** Server-only resolution for trusted launch/binding consumers. */
  async resolveIdentity(
    projectId: StudioProjectId,
  ): Promise<StudioProjectIdentity | null> {
    if (!isStudioProjectId(projectId)) return null;
    await this.mutationQueue;
    await this.load();
    const project = this.projects!.find(
      (candidate) => candidate.projectId === projectId,
    );
    return project ? structuredClone(project) : null;
  }

  /** Explicit move/rebind seam: identity survives path and WorkspaceKey churn. */
  async moveRootBinding(
    projectId: StudioProjectId,
    bindingId: string,
    root: string,
    legacyWorkspaceKey?: string,
  ): Promise<StudioProjectSummary> {
    return this.enqueue(async () => {
      await this.load();
      const next = cloneProjects(this.projects!);
      const project = next.find(
        (candidate) => candidate.projectId === projectId,
      );
      const binding = project?.rootBindings.find(
        (candidate) => candidate.id === bindingId,
      );
      if (!project || !binding || !isSafePathText(root)) {
        throw new StudioProjectCatalogError("malformed_state");
      }
      if (legacyWorkspaceKey !== undefined && !isSafeText(legacyWorkspaceKey)) {
        throw new StudioProjectCatalogError("malformed_state");
      }
      const canonical = canonicalGraphPath(root);
      if (
        project.rootBindings.some(
          (candidate) =>
            candidate.id !== binding.id &&
            pathComparisonKey(candidate.localRootRef) ===
              pathComparisonKey(canonical),
        )
      ) {
        // Reject instead of persisting two private bindings for the same root;
        // the strict restart parser enforces this same invariant.
        throw new StudioProjectCatalogError("malformed_state");
      }
      if (
        next.some(
          (candidate) =>
            candidate.projectId !== projectId &&
            (candidate.rootBindings.some(
              (candidateBinding) =>
                pathComparisonKey(candidateBinding.localRootRef) ===
                pathComparisonKey(canonical),
            ) ||
              (legacyWorkspaceKey !== undefined &&
                candidate.legacyWorkspaceKeys.includes(legacyWorkspaceKey))),
        )
      ) {
        throw new StudioProjectCatalogError("malformed_state");
      }
      binding.localRootRef = canonical;
      binding.status = "active";
      if (
        legacyWorkspaceKey &&
        !project.legacyWorkspaceKeys.includes(legacyWorkspaceKey)
      ) {
        project.legacyWorkspaceKeys.push(legacyWorkspaceKey);
      }
      project.identityVersion += 1;
      project.updatedAt = this.timestamp();
      await this.persist(next);
      this.projects = next;
      return publicSummary(project);
    });
  }

  async addRootBinding(
    projectId: StudioProjectId,
    root: string,
    options: { repositoryId?: string | null; legacyWorkspaceKey?: string } = {},
  ): Promise<StudioProjectSummary> {
    return this.enqueue(async () => {
      await this.load();
      const next = cloneProjects(this.projects!);
      const project = next.find(
        (candidate) => candidate.projectId === projectId,
      );
      if (
        !project ||
        !isSafePathText(root) ||
        (options.repositoryId !== undefined &&
          options.repositoryId !== null &&
          !isOpaqueId(options.repositoryId)) ||
        (options.legacyWorkspaceKey !== undefined &&
          !isSafeText(options.legacyWorkspaceKey))
      ) {
        throw new StudioProjectCatalogError("malformed_state");
      }
      const canonical = canonicalGraphPath(root);
      if (
        next.some(
          (candidate) =>
            candidate.projectId !== projectId &&
            (candidate.rootBindings.some(
              (binding) =>
                pathComparisonKey(binding.localRootRef) ===
                pathComparisonKey(canonical),
            ) ||
              (options.legacyWorkspaceKey !== undefined &&
                candidate.legacyWorkspaceKeys.includes(
                  options.legacyWorkspaceKey,
                ))),
        )
      ) {
        throw new StudioProjectCatalogError("malformed_state");
      }
      const existing = project.rootBindings.find(
        (binding) =>
          pathComparisonKey(binding.localRootRef) ===
          pathComparisonKey(canonical),
      );
      if (existing) {
        existing.status = "active";
        if (options.repositoryId !== undefined) {
          existing.repositoryId = options.repositoryId;
        }
      } else {
        project.rootBindings.push({
          id: `root_${randomUUID()}`,
          repositoryId: options.repositoryId ?? null,
          localRootRef: canonical,
          status: "active",
        });
      }
      if (
        options.legacyWorkspaceKey &&
        !project.legacyWorkspaceKeys.includes(options.legacyWorkspaceKey)
      ) {
        project.legacyWorkspaceKeys.push(options.legacyWorkspaceKey);
      }
      project.identityVersion += 1;
      project.updatedAt = this.timestamp();
      await this.persist(next);
      this.projects = next;
      return publicSummary(project);
    });
  }
}
