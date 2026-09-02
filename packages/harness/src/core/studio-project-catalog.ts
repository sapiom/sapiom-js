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
    new Set(bindings.map((binding) => binding.localRootRef)).size !==
      bindings.length ||
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

function parseCatalog(value: unknown): PersistedStudioProjectCatalog {
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
  return {
    schemaVersion: STUDIO_PROJECT_CATALOG_SCHEMA_VERSION,
    projects: parsed,
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

/**
 * Durable, serialized owner of Studio project identity. Catalog reads never
 * run package inventory or source discovery; callers provide the already
 * allow-listed workspace scopes they want reconciled.
 */
export class StudioProjectCatalog {
  private projects: StudioProjectIdentity[] | null = null;
  private loadPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly catalogPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly lockTestHooks: StudioProjectCatalogLockTestHooks = {},
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const lockedOperation = async (): Promise<T> => {
      const release = await this.acquireFileLock();
      try {
        // CLI and Electron share one state root. Always re-read after taking
        // the cross-instance lock so a whole-catalog atomic rewrite includes
        // identities committed by another live host.
        await this.load(true);
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
      this.projects = parseCatalog(decoded).projects;
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
      await this.persist(next);
      this.projects = next;
      return publicSummary(project);
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
      const dedupedScopes = new Map<string, WorkspaceScopeSummary>();
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
        roots.add(canonical);
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
        if (!dedupedScopes.has(canonical)) {
          // Canonical form is private matching evidence only. Preserve the
          // existing lexical cwd in AppState so this additive join cannot
          // perturb legacy rail/session path equality.
          dedupedScopes.set(canonical, { ...scope });
        }
      }

      const activeRoots = new Set(dedupedScopes.keys());
      let changed = false;
      for (const project of next) {
        let projectChanged = false;
        for (const binding of project.rootBindings) {
          const status = activeRoots.has(binding.localRootRef)
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
      for (const [canonical, scope] of dedupedScopes) {
        const matchingProjects = next.filter(
          (candidate) =>
            candidate.legacyWorkspaceKeys.includes(scope.workspaceKey) ||
            candidate.rootBindings.some(
              (binding) => binding.localRootRef === canonical,
            ),
        );
        if (matchingProjects.length > 1) {
          throw new StudioProjectCatalogError("malformed_state");
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
          changed = true;
        } else {
          let projectChanged = false;
          if (!project.legacyWorkspaceKeys.includes(scope.workspaceKey)) {
            project.legacyWorkspaceKeys.push(scope.workspaceKey);
            projectChanged = true;
          }
          let binding = project.rootBindings.find(
            (candidate) => candidate.localRootRef === canonical,
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
        await this.persist(next);
        this.projects = next;
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
            candidate.id !== binding.id && candidate.localRootRef === canonical,
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
              (candidateBinding) => candidateBinding.localRootRef === canonical,
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
              (binding) => binding.localRootRef === canonical,
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
        (binding) => binding.localRootRef === canonical,
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
