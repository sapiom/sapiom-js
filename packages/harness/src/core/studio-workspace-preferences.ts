import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION,
  type StudioCurrentWorkspaceResponse,
  type StudioProjectId,
  type StudioWorkspaceAgentSummary,
  type StudioWorkspacePreference,
  type StudioWorkspaceSelection,
} from "../shared/agent-map.js";
import { workspaceRelativeLocalKey } from "../shared/system-graph.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

interface PrivateAgentBinding extends StudioWorkspaceAgentSummary {
  projectId: StudioProjectId;
  /** Private reconciliation evidence. Never returned by this store. */
  path: string;
  updatedAt: string;
}

interface PersistedPreferences {
  schemaVersion: number;
  preferences: StudioWorkspacePreference[];
  agentBindings: PrivateAgentBinding[];
}

export interface SelectableWorkflow {
  name: string;
  path: string;
  definitionId: number | null;
}

export class StudioWorkspacePreferenceStoreError extends Error {
  constructor(
    readonly code:
      | "malformed_state"
      | "unsupported_schema"
      | "storage_unavailable",
  ) {
    super(code);
    this.name = "StudioWorkspacePreferenceStoreError";
  }
}

const emptyState = (): PersistedPreferences => ({
  schemaVersion: STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION,
  preferences: [],
  agentBindings: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function validSelection(
  value: unknown,
  projectId: string,
): value is StudioWorkspaceSelection {
  if (!isRecord(value) || value.projectId !== projectId) return false;
  if (value.kind === "agent-map") return Object.keys(value).length === 2;
  return (
    value.kind === "agent" &&
    validAgentId(value.agentId) &&
    Object.keys(value).length === 3
  );
}

function parseState(value: unknown): PersistedPreferences {
  if (!isRecord(value))
    throw new StudioWorkspacePreferenceStoreError("malformed_state");
  if (
    typeof value.schemaVersion === "number" &&
    value.schemaVersion > STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION
  ) {
    throw new StudioWorkspacePreferenceStoreError("unsupported_schema");
  }
  if (
    value.schemaVersion !== STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION ||
    !Array.isArray(value.preferences) ||
    !Array.isArray(value.agentBindings)
  ) {
    throw new StudioWorkspacePreferenceStoreError("malformed_state");
  }
  const preferences: StudioWorkspacePreference[] = [];
  for (const candidate of value.preferences) {
    if (
      !isRecord(candidate) ||
      typeof candidate.userId !== "string" ||
      !candidate.userId ||
      !isStudioProjectId(candidate.projectId) ||
      !validSelection(candidate.selection, candidate.projectId) ||
      !validTimestamp(candidate.updatedAt)
    )
      throw new StudioWorkspacePreferenceStoreError("malformed_state");
    preferences.push(candidate as unknown as StudioWorkspacePreference);
  }
  const agentBindings: PrivateAgentBinding[] = [];
  for (const candidate of value.agentBindings) {
    if (
      !isRecord(candidate) ||
      !validAgentId(candidate.agentId) ||
      !isStudioProjectId(candidate.projectId) ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      typeof candidate.path !== "string" ||
      !candidate.path ||
      (candidate.definitionId !== null &&
        !Number.isSafeInteger(candidate.definitionId)) ||
      !validTimestamp(candidate.updatedAt)
    )
      throw new StudioWorkspacePreferenceStoreError("malformed_state");
    agentBindings.push(candidate as unknown as PrivateAgentBinding);
  }
  return { schemaVersion: value.schemaVersion, preferences, agentBindings };
}

/** Atomic owner of per-user selection and private path-to-opaque-id bindings. */
export class StudioWorkspacePreferenceStore {
  private state: PersistedPreferences | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<PersistedPreferences> {
    if (this.state) return this.state;
    try {
      this.state = parseState(
        JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.state = emptyState();
      else if (error instanceof StudioWorkspacePreferenceStoreError)
        throw error;
      else if (error instanceof SyntaxError)
        throw new StudioWorkspacePreferenceStoreError("malformed_state");
      else throw new StudioWorkspacePreferenceStoreError("storage_unavailable");
    }
    return this.state;
  }

  private async persist(state: PersistedPreferences): Promise<void> {
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        temporary,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporary, this.filePath);
      this.state = state;
    } catch {
      throw new StudioWorkspacePreferenceStoreError("storage_unavailable");
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private reconcile(
    state: PersistedPreferences,
    projectId: StudioProjectId,
    roots: readonly string[],
    workflows: readonly SelectableWorkflow[],
    scanComplete: boolean,
  ): {
    state: PersistedPreferences;
    agents: StudioWorkspaceAgentSummary[];
    changed: boolean;
  } {
    const timestamp = this.now().toISOString();
    const next: PersistedPreferences = {
      ...state,
      preferences: [...state.preferences],
      agentBindings: state.agentBindings.map((binding) => ({ ...binding })),
    };
    let changed = false;
    const eligible = workflows.filter((workflow) =>
      roots.some(
        (root) => workspaceRelativeLocalKey(root, workflow.path) !== null,
      ),
    );
    const agents = eligible.map((workflow) => {
      let binding = next.agentBindings.find(
        (candidate) =>
          candidate.projectId === projectId && candidate.path === workflow.path,
      );
      if (!binding) {
        binding = {
          projectId,
          agentId: `agent_${randomUUID()}`,
          path: workflow.path,
          name: workflow.name,
          definitionId: workflow.definitionId,
          updatedAt: timestamp,
        };
        next.agentBindings.push(binding);
        changed = true;
      } else if (
        binding.path !== workflow.path ||
        binding.name !== workflow.name ||
        binding.definitionId !== workflow.definitionId
      ) {
        Object.assign(binding, {
          path: workflow.path,
          name: workflow.name,
          definitionId: workflow.definitionId,
          updatedAt: timestamp,
        });
        changed = true;
      }
      return {
        agentId: binding.agentId,
        name: binding.name,
        definitionId: binding.definitionId,
      };
    });
    agents.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.agentId.localeCompare(right.agentId),
    );
    if (scanComplete) {
      const activeAgentIds = new Set(agents.map((agent) => agent.agentId));
      const retained = next.agentBindings.filter(
        (binding) =>
          binding.projectId !== projectId ||
          activeAgentIds.has(binding.agentId),
      );
      if (retained.length !== next.agentBindings.length) {
        next.agentBindings = retained;
        changed = true;
      }
    }
    return { state: next, agents, changed };
  }

  async current(
    userId: string,
    projectId: StudioProjectId,
    roots: readonly string[],
    workflows: readonly SelectableWorkflow[],
    scanComplete: boolean,
  ): Promise<StudioCurrentWorkspaceResponse> {
    return this.enqueue(async () => {
      const reconciled = this.reconcile(
        await this.load(),
        projectId,
        roots,
        workflows,
        scanComplete,
      );
      const preference = reconciled.state.preferences.find(
        (candidate) =>
          candidate.userId === userId && candidate.projectId === projectId,
      );
      const requested = preference?.selection;
      const valid =
        !requested ||
        requested.kind !== "agent" ||
        reconciled.agents.some((agent) => agent.agentId === requested.agentId);
      const repaired = Boolean(preference && !valid && scanComplete);
      const selection: StudioWorkspaceSelection =
        preference && valid
          ? preference.selection
          : { kind: "agent-map", projectId };
      let changed = reconciled.changed;
      if (repaired) {
        const index = reconciled.state.preferences.indexOf(preference!);
        reconciled.state.preferences[index] = {
          userId,
          projectId,
          selection,
          updatedAt: this.now().toISOString(),
        };
        changed = true;
      }
      if (changed) await this.persist(reconciled.state);
      return { projectId, selection, agents: reconciled.agents, repaired };
    });
  }

  async put(
    userId: string,
    projectId: StudioProjectId,
    requested: StudioWorkspaceSelection,
    roots: readonly string[],
    workflows: readonly SelectableWorkflow[],
    scanComplete: boolean,
  ): Promise<StudioCurrentWorkspaceResponse> {
    return this.enqueue(async () => {
      const reconciled = this.reconcile(
        await this.load(),
        projectId,
        roots,
        workflows,
        scanComplete,
      );
      const normalized: StudioWorkspaceSelection =
        requested.kind === "agent"
          ? {
              kind: "agent",
              projectId: requested.projectId,
              agentId: requested.agentId,
            }
          : { kind: "agent-map", projectId: requested.projectId };
      const index = reconciled.state.preferences.findIndex(
        (candidate) =>
          candidate.userId === userId && candidate.projectId === projectId,
      );
      const sameProject = normalized.projectId === projectId;
      const visibleAgent =
        normalized.kind === "agent" &&
        reconciled.agents.some((agent) => agent.agentId === normalized.agentId);
      const privatelyKnownAgent =
        normalized.kind === "agent" &&
        reconciled.state.agentBindings.some(
          (binding) =>
            binding.projectId === projectId &&
            binding.agentId === normalized.agentId,
        );
      // A degraded scan cannot disprove a server-issued opaque id. Accept a
      // binding the private store still knows, and leave an unknown request's
      // previous durable preference untouched until a complete scan can judge
      // it. This is the PUT twin of current()'s non-destructive read fallback.
      const accepted =
        sameProject &&
        (normalized.kind === "agent-map" ||
          visibleAgent ||
          (!scanComplete && privatelyKnownAgent));
      const absenceUnproven =
        sameProject && normalized.kind === "agent" && !scanComplete;
      const selection: StudioWorkspaceSelection = accepted
        ? normalized
        : absenceUnproven
          ? (reconciled.state.preferences[index]?.selection ?? {
              kind: "agent-map",
              projectId,
            })
          : { kind: "agent-map", projectId };
      if (!absenceUnproven || accepted) {
        const nextPreference: StudioWorkspacePreference = {
          userId,
          projectId,
          selection,
          updatedAt: this.now().toISOString(),
        };
        if (index < 0) reconciled.state.preferences.push(nextPreference);
        else reconciled.state.preferences[index] = nextPreference;
        await this.persist(reconciled.state);
      } else if (reconciled.changed) {
        await this.persist(reconciled.state);
      }
      return {
        projectId,
        selection,
        agents: reconciled.agents,
        repaired: !accepted && !absenceUnproven,
      };
    });
  }

  /** Server-only join used to annotate the already-pathful workflow list. */
  async agentIds(
    projectId: StudioProjectId,
    roots: readonly string[],
    workflows: readonly SelectableWorkflow[],
    scanComplete: boolean,
  ): Promise<Map<string, string>> {
    return this.enqueue(async () => {
      const reconciled = this.reconcile(
        await this.load(),
        projectId,
        roots,
        workflows,
        scanComplete,
      );
      if (reconciled.changed) await this.persist(reconciled.state);
      const byId = new Map(
        reconciled.agents.map((agent) => [agent.agentId, agent]),
      );
      return new Map(
        reconciled.state.agentBindings
          .filter(
            (binding) =>
              binding.projectId === projectId && byId.has(binding.agentId),
          )
          .map((binding) => [binding.path, binding.agentId]),
      );
    });
  }

  /**
   * Moves private reconciliation evidence inside the authenticated disk-move
   * transaction. The public move request never supplies an identity: the
   * route resolves both paths from its registry and allow-listed target first.
   */
  async moveAgentBindings(from: string, to: string): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.load();
      const source = path.resolve(from);
      const target = path.resolve(to);
      let changed = false;
      const agentBindings = state.agentBindings.map((binding) => {
        const relative = path.relative(source, path.resolve(binding.path));
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return binding;
        }
        changed = true;
        return {
          ...binding,
          path: relative === "" ? target : path.join(target, relative),
          updatedAt: this.now().toISOString(),
        };
      });
      if (!changed) return;
      await this.persist({ ...state, agentBindings });
    });
  }
}
