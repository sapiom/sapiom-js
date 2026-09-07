import { z } from "zod";
import type {
  AgentMapImplementation,
  AgentMapImplementationsResponse,
  AgentMapVersionId,
  PlanNode,
} from "../shared/agent-map.js";
import { AGENT_MAP_UUID_V7_PATTERN } from "../shared/agent-map-codec.js";
import { planNodeIdSchema } from "./agent-map-proposal-schema.js";
import {
  AgentMapWorkspaceStore,
  AgentMapWorkspaceStoreError,
} from "./agent-map-workspace-store.js";

export const studioImplementationIdSchema = z
  .string()
  .regex(
    /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
export const agentMapBindingRequestSchema = z
  .object({
    expectedMapVersionId: z
      .string()
      .regex(new RegExp(`^mapv_${AGENT_MAP_UUID_V7_PATTERN}$`, "u")),
    nodeId: planNodeIdSchema,
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    agentId: studioImplementationIdSchema.nullable(),
  })
  .strict();
const rowSchema = z
  .object({
    nodeId: planNodeIdSchema,
    agentId: studioImplementationIdSchema.nullable(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const fileSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string(),
    bindings: z.array(rowSchema),
  })
  .strict();

export interface ImplementationCandidate {
  agentId: string;
  name: string;
  path: string;
  definitionId: number | null;
}
export interface ImplementationInventory {
  discoveryComplete: boolean;
  candidates: ImplementationCandidate[];
}
type BindingErrorCode =
  | "malformed_input"
  | "unauthorized"
  | "stale_map"
  | "stale_binding"
  | "project_not_found"
  | "node_not_found"
  | "invalid_node_kind"
  | "unbound"
  | "target_not_found"
  | "target_ambiguous"
  | "target_in_use"
  | "discovery_unavailable"
  | "malformed_state"
  | "unsupported_schema"
  | "storage_unavailable";
export class AgentMapBindingError extends Error {
  constructor(
    readonly code: BindingErrorCode,
    readonly current?: AgentMapImplementation,
  ) {
    super(code);
  }
  get detail() {
    const recovery =
      this.code === "discovery_unavailable"
        ? "retry"
        : [
              "storage_unavailable",
              "stale_map",
              "stale_binding",
              "target_in_use",
            ].includes(this.code)
          ? "reread"
          : "correct";
    return {
      ok: false as const,
      code: this.code,
      recovery,
      ...(this.current ? { current: this.current } : {}),
    };
  }
}
const eligible = (node: PlanNode) =>
  node.kind === "agent" || node.kind === "subagent";
function fail(code: BindingErrorCode): never {
  throw new AgentMapBindingError(code);
}

function checkAuthorization(authorize: () => void): void {
  try {
    authorize();
  } catch {
    fail("unauthorized");
  }
}

export class AgentMapImplementationBindings {
  constructor(
    private readonly store: AgentMapWorkspaceStore,
    private readonly lookup: (
      projectId: string,
    ) => Promise<ImplementationInventory | null>,
  ) {}

  private async readInventory(projectId: string) {
    let inventoryFailed = false;
    const inventory = await this.lookup(projectId).catch(() => {
      inventoryFailed = true;
      return { discoveryComplete: false, candidates: [] };
    });
    if (!inventory) fail("project_not_found");
    return { inventory, inventoryFailed };
  }

  private async inspect<T>(
    projectId: string,
    assertAuthorized: () => void,
    operation: (context: {
      projection: AgentMapImplementationsResponse;
      inventory: ImplementationInventory;
      inventoryFailed: boolean;
      nodes: PlanNode[];
      rows: z.infer<typeof rowSchema>[];
      write: (value: unknown) => Promise<void>;
    }) => Promise<T> | T,
    mode: "read" | "write" = "read",
  ): Promise<T> {
    try {
      checkAuthorization(assertAuthorized);
      const prefetched =
        mode === "read" ? await this.readInventory(projectId) : null;
      return await this.store.inspectImplementationBindings(
        projectId,
        async (aggregate, journal, sidecar) => {
          const raw = await sidecar.read();
          let rows: z.infer<typeof rowSchema>[] = [];
          if (raw !== undefined) {
            if (
              raw !== null &&
              typeof raw === "object" &&
              "schemaVersion" in raw &&
              raw.schemaVersion !== 1
            )
              fail("unsupported_schema");
            const parsed = fileSchema.safeParse(raw);
            if (!parsed.success || parsed.data.projectId !== projectId)
              fail("malformed_state");
            rows = parsed.data.bindings;
            if (new Set(rows.map((row) => row.nodeId)).size !== rows.length)
              fail("malformed_state");
          }
          const nodes = aggregate.mapVersions.at(-1)?.graph.nodes ?? [];
          const first = aggregate.mapVersions[0];
          let inherited = false,
            uncertain = false;
          if (
            first?.authoredBy.sessionId.startsWith("map-initialization-") &&
            nodes.some(
              (node) =>
                eligible(node) && !rows.some((row) => row.nodeId === node.id),
            )
          ) {
            try {
              const record = await journal.read();
              inherited =
                !!record &&
                first.authoredBy.sessionId ===
                  `map-initialization-${record.attemptId}` &&
                first.authoredBy.userId === record.userId;
            } catch {
              uncertain = true;
            }
          }
          const { inventory, inventoryFailed } =
            prefetched ?? (await this.readInventory(projectId));
          const bindings: AgentMapImplementation[] = nodes
            .filter(eligible)
            .map((node) => {
              const explicit = rows.find((row) => row.nodeId === node.id);
              const original = first?.graph.nodes.find(
                (entry) => entry.id === node.id && eligible(entry),
              );
              const refs = inherited
                ? (original?.contractRefs.filter((ref) =>
                    ref.startsWith("studio-agent:"),
                  ) ?? [])
                : [];
              const originalId =
                refs.length === 1
                  ? studioImplementationIdSchema.safeParse(refs[0].slice(13))
                  : null;
              const agentId = explicit
                ? explicit.agentId
                : originalId?.success
                  ? originalId.data
                  : null;
              const matches = inventory.candidates.filter(
                (candidate) => candidate.agentId === agentId,
              );
              const resolution =
                !explicit && uncertain
                  ? "unavailable"
                  : !explicit && refs.length > 0 && !originalId?.success
                    ? "ambiguous"
                    : agentId === null
                      ? "unbound"
                      : matches.length > 1
                        ? "ambiguous"
                        : matches.length === 1
                          ? "bound"
                          : inventory.discoveryComplete
                            ? "missing"
                            : "unavailable";
              return {
                nodeId: node.id,
                agentId,
                revision: explicit?.revision ?? 0,
                resolution,
              };
            });
          for (const binding of bindings) {
            if (
              binding.agentId &&
              bindings.filter((other) => other.agentId === binding.agentId)
                .length > 1
            )
              binding.resolution = "ambiguous";
          }
          checkAuthorization(assertAuthorized);
          return operation({
            projection: {
              projectId,
              mapVersionId: aggregate.current.map?.versionId ?? null,
              bindings,
            },
            inventory,
            inventoryFailed,
            nodes,
            rows,
            write: sidecar.write,
          });
        },
      );
    } catch (error) {
      if (error instanceof AgentMapBindingError) throw error;
      throw new AgentMapBindingError(
        error instanceof AgentMapWorkspaceStoreError
          ? error.code
          : "storage_unavailable",
      );
    }
  }

  inventory(projectId: string, assertAuthorized: () => void) {
    return this.inspect(
      projectId,
      assertAuthorized,
      ({ projection, inventory, inventoryFailed }) => {
        if (inventoryFailed) fail("discovery_unavailable");
        return { ...projection, ...inventory };
      },
    );
  }

  projection(projectId: string, assertAuthorized: () => void) {
    return this.inspect(
      projectId,
      assertAuthorized,
      ({ projection }) => projection,
    );
  }

  async target(
    projectId: string,
    nodeId: string,
    assertAuthorized: () => void,
  ) {
    if (!planNodeIdSchema.safeParse(nodeId).success) fail("malformed_input");
    return this.inspect(
      projectId,
      assertAuthorized,
      ({ projection, inventory, nodes }) => {
        const node = nodes.find((node) => node.id === nodeId);
        if (!node) fail("node_not_found");
        if (!eligible(node)) fail("invalid_node_kind");
        const binding = projection.bindings.find(
          (row) => row.nodeId === nodeId,
        )!;
        if (binding.resolution !== "bound")
          fail(
            {
              unbound: "unbound",
              missing: "target_not_found",
              ambiguous: "target_ambiguous",
              unavailable: "discovery_unavailable",
            }[binding.resolution] as BindingErrorCode,
          );
        const candidate = inventory.candidates.find(
          (candidate) => candidate.agentId === binding.agentId,
        )!;
        return {
          projectId,
          nodeId,
          agentId: candidate.agentId,
          workflowPath: candidate.path,
        };
      },
    );
  }

  async bind(projectId: string, input: unknown, assertAuthorized: () => void) {
    const parsed = agentMapBindingRequestSchema.safeParse(input);
    if (!parsed.success) fail("malformed_input");
    const request = parsed.data;
    return this.inspect(
      projectId,
      assertAuthorized,
      async ({ projection, inventory, nodes, rows, write }) => {
        if (request.expectedMapVersionId !== projection.mapVersionId)
          fail("stale_map");
        const node = nodes.find((node) => node.id === request.nodeId);
        if (!node) fail("node_not_found");
        if (!eligible(node)) fail("invalid_node_kind");
        const current = projection.bindings.find(
          (row) => row.nodeId === request.nodeId,
        )!;
        if (request.expectedRevision !== current.revision)
          throw new AgentMapBindingError("stale_binding", current);
        if (request.agentId !== null) {
          const candidates = inventory.candidates.filter(
            (candidate) => candidate.agentId === request.agentId,
          );
          if (candidates.length === 0)
            fail(
              inventory.discoveryComplete
                ? "target_not_found"
                : "discovery_unavailable",
            );
          if (candidates.length !== 1) fail("target_ambiguous");
          if (
            projection.bindings.some(
              (row) =>
                row.nodeId !== request.nodeId &&
                row.agentId === request.agentId,
            )
          )
            throw new AgentMapBindingError("target_in_use", current);
        }
        const explicit = rows.find((row) => row.nodeId === request.nodeId);
        const changed = !explicit || explicit.agentId !== request.agentId;
        if (changed && current.revision === Number.MAX_SAFE_INTEGER)
          fail("malformed_state");
        const row = {
          nodeId: request.nodeId,
          agentId: request.agentId,
          revision: current.revision + (changed ? 1 : 0),
        };
        if (changed) {
          checkAuthorization(assertAuthorized);
          await write({
            schemaVersion: 1,
            projectId,
            bindings: [
              ...rows.filter((row) => row.nodeId !== request.nodeId),
              row,
            ],
          });
        }
        return {
          ok: true as const,
          changed,
          mapVersionId: projection.mapVersionId as AgentMapVersionId,
          binding: {
            ...row,
            resolution:
              request.agentId === null
                ? ("unbound" as const)
                : ("bound" as const),
          },
        };
      },
      "write",
    );
  }
}
