import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMapImplementationBindings,
  AgentMapBindingError,
  type ImplementationInventory,
} from "./agent-map-implementation-bindings.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import {
  AgentMapProposalService,
  UuidV7AgentMapIdAllocator,
} from "./agent-map-proposal-service.js";
import {
  restoreAgentMapVersion,
  agentMapVersionRef,
} from "./agent-map-version.js";
import type { MapOperationInput } from "../shared/agent-map.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const projectId = "project_00000000-0000-4000-8000-000000000001";
const agentId = "agent_00000000-0000-4000-8000-000000000001";
const secondId = "agent_00000000-0000-4000-8000-000000000002";
const actor = { projectId, userId: "user", sessionId: "session" };
const authorize = () => {};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(initial = false, refs = [`studio-agent:${agentId}`]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "map-bindings-"));
  roots.push(root);
  const store = new AgentMapWorkspaceStore(root);
  const proposals = new AgentMapProposalService(store);
  const inventory: ImplementationInventory = {
    discoveryComplete: true,
    candidates: [
      { agentId, name: "Same", path: "/private/a", definitionId: 42 },
      { agentId: secondId, name: "Same", path: "/private/b", definitionId: 42 },
    ],
  };
  const lookup = vi.fn(async () => inventory);
  const service = new AgentMapImplementationBindings(store, lookup);
  const file = path.join(
    root,
    "projects",
    projectId,
    "implementation-bindings.json",
  );
  const workspace = path.join(path.dirname(file), "workspace.json");
  await expect(service.projection(projectId, authorize)).resolves.toMatchObject(
    { mapVersionId: null, bindings: [] },
  );
  await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  const attemptId = randomUUID();
  if (initial)
    await store.inspectInitialization(projectId, async (_, journal) =>
      journal.write({
        schemaVersion: 1,
        projectId,
        userId: actor.userId,
        attemptId,
        status: "running",
        ownerId: randomUUID(),
        ownerPid: process.pid,
        provider: "codex",
        errorCode: null,
        updatedAt: new Date().toISOString(),
      }),
    );
  const request = {
    schemaVersion: 1,
    proposalId: null,
    expectedVersion: 0,
    requestId: "first",
    operations: ["agent", "agent", "resource"].map((kind, index) => ({
      kind: "add-node",
      draftRef: `n${index}`,
      node: {
        kind,
        name: `Node ${index}`,
        purpose: "Test",
        ownerAgent: null,
        contractRefs: index === 0 ? refs : [],
      },
    })),
  };
  if (initial)
    await proposals.createInitial(
      { ...actor, sessionId: `map-initialization-${attemptId}` },
      request,
      attemptId,
      async () => true,
    );
  else await proposals.propose(actor, request);
  const nodes = (await store.readAggregate(projectId)).mapVersions[0].graph
    .nodes;
  const nodeId = nodes.find((node) => node.name === "Node 0")!.id;
  const otherNodeId = nodes.find((node) => node.name === "Node 1")!.id;
  const resourceId = nodes.find((node) => node.kind === "resource")!.id;
  const read = () => service.projection(projectId, authorize);
  const bind = async (id: string | null, revision = 0, node = nodeId) =>
    service.bind(
      projectId,
      {
        expectedMapVersionId: (await read()).mapVersionId,
        expectedRevision: revision,
        nodeId: node,
        agentId: id,
      },
      authorize,
    );
  const edit = async (operations: MapOperationInput[]) => {
    const { proposal } = await proposals.read(projectId);
    return proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: proposal!.id,
      expectedVersion: proposal!.version,
      requestId: randomUUID(),
      operations,
    });
  };
  return {
    root,
    store,
    service,
    inventory,
    lookup,
    file,
    workspace,
    nodeId,
    otherNodeId,
    resourceId,
    read,
    bind,
    edit,
  };
}

describe("Agent Map implementation bindings", () => {
  it.each(["inventory", "projection", "target", "bind"] as const)(
    "does not hold the map lock while %s waits for inventory",
    async (method) => {
      const f = await fixture();
      await f.bind(agentId);
      const { mapVersionId } = await f.read();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.lookup.mockImplementationOnce(async () => {
        entered();
        await gate;
        return f.inventory;
      });
      const reading =
        method === "bind"
          ? expect(
              f.service.bind(
                projectId,
                {
                  expectedMapVersionId: mapVersionId,
                  nodeId: f.nodeId,
                  expectedRevision: 1,
                  agentId: secondId,
                },
                authorize,
              ),
            ).rejects.toMatchObject({ code: "stale_map" })
          : method === "target"
            ? f.service.target(projectId, f.nodeId, authorize)
            : f.service[method](projectId, authorize);
      await started;
      let completed = false;
      const writing = f
        .edit([
          {
            kind: "update-node",
            nodeId: f.nodeId,
            changes: { name: "Still writable" },
          },
        ])
        .then(() => {
          completed = true;
        });
      try {
        await vi.waitFor(() => expect(completed).toBe(true), {
          timeout: 1_000,
        });
      } finally {
        release();
        await Promise.all([reading, writing]);
      }
    },
  );

  it("persists exact identity without changing authored history, even for same-name cloud clones", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.workspace);
    await expect(f.bind(secondId)).resolves.toMatchObject({
      changed: true,
      binding: { agentId: secondId, revision: 1 },
    });
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).resolves.toMatchObject({ agentId: secondId, workflowPath: "/private/b" });
    expect(JSON.stringify(await f.read())).not.toContain("/private/");
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
    const restarted = new AgentMapImplementationBindings(
      new AgentMapWorkspaceStore(f.root),
      f.lookup,
    );
    expect(await restarted.projection(projectId, authorize)).toEqual(
      await f.read(),
    );
    expect(await fs.readFile(f.workspace)).toEqual(before);
    await expect(f.bind(secondId, 1)).resolves.toMatchObject({
      changed: false,
      binding: { revision: 1 },
    });
  });

  it("uses immutable initialization provenance and persists explicit revision-zero overrides", async () => {
    const f = await fixture(true);
    await f.store.inspectInitialization(projectId, async (_, journal) =>
      journal.write({ ...(await journal.read())!, status: "skipped" }),
    );
    await f.edit([
      {
        kind: "update-node",
        nodeId: f.nodeId,
        changes: { contractRefs: [`studio-agent:${secondId}`] },
      },
    ]);
    expect(
      (await f.read()).bindings.find((row) => row.nodeId === f.nodeId),
    ).toMatchObject({ agentId, revision: 0, resolution: "bound" });
    await expect(f.bind(agentId)).resolves.toMatchObject({
      changed: true,
      binding: { revision: 1 },
    });
    await expect(f.bind(null, 1)).resolves.toMatchObject({
      binding: { agentId: null, revision: 2, resolution: "unbound" },
    });
    expect(
      (await f.read()).bindings.find((row) => row.nodeId === f.nodeId)?.agentId,
    ).toBeNull();
  });

  it("requires provenance, refuses multiple initial references, and permits explicit repair", async () => {
    const f = await fixture(true, [
      `studio-agent:${agentId}`,
      `studio-agent:${secondId}`,
    ]);
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).rejects.toMatchObject({ code: "target_ambiguous" });
    const journalFile = path.join(path.dirname(f.file), "initialization.json");
    await fs.writeFile(journalFile, "broken");
    expect((await f.read()).bindings[0].resolution).toBe("unavailable");
    await expect(f.bind(agentId)).resolves.toMatchObject({ ok: true });
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).resolves.toMatchObject({ agentId });
    await fs.rm(journalFile);
    expect(
      (await f.read()).bindings.find((row) => row.nodeId === f.otherNodeId)
        ?.resolution,
    ).toBe("unbound");
    const authored = await fixture();
    await expect(
      authored.service.target(projectId, authored.nodeId, authorize),
    ).rejects.toMatchObject({ code: "unbound" });
    await expect(authored.bind(null)).resolves.toMatchObject({
      changed: true,
      binding: { revision: 1 },
    });
  });

  it("serializes independent writers, checks immutable map versions, and rejects duplicate claims", async () => {
    const f = await fixture();
    const input = {
      expectedMapVersionId: (await f.read()).mapVersionId,
      expectedRevision: 0,
      nodeId: f.nodeId,
      agentId,
    };
    const other = new AgentMapImplementationBindings(
      new AgentMapWorkspaceStore(f.root),
      f.lookup,
    );
    const results = await Promise.allSettled([
      f.service.bind(projectId, input, authorize),
      other.bind(projectId, { ...input, agentId: secondId }, authorize),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "stale_binding" } });
    const chosen = (await f.read()).bindings.find(
      (row) => row.nodeId === f.nodeId,
    )!.agentId;
    await expect(f.bind(chosen, 0, f.otherNodeId)).rejects.toMatchObject({
      code: "target_in_use",
    });
    await f.edit([
      { kind: "update-node", nodeId: f.nodeId, changes: { name: "Renamed" } },
    ]);
    await expect(
      f.service.bind(projectId, { ...input, expectedRevision: 1 }, authorize),
    ).rejects.toMatchObject({ code: "stale_map" });
    await expect(f.bind(agentId, 0, f.resourceId)).rejects.toMatchObject({
      code: "invalid_node_kind",
    });
  });

  it("reactivates the same node after restore and reports conflicting active claims", async () => {
    const f = await fixture(true);
    const initial = (await f.store.readAggregate(projectId)).mapVersions[0];
    await f.edit([{ kind: "remove-node", nodeId: f.nodeId }]);
    await f.bind(agentId, 0, f.otherNodeId);
    await f.store.transact(projectId, async (aggregate) => {
      const restored = restoreAgentMapVersion({
        projectId,
        current: aggregate.mapVersions.at(-1)!,
        historical: initial,
        versionId: new UuidV7AgentMapIdAllocator().allocateMapVersionId(),
        actor: { userId: actor.userId, sessionId: actor.sessionId },
        createdAt: new Date().toISOString(),
        origin: {
          kind: "request",
          requestDigest: `sha256:${"0".repeat(64)}`,
          operationIds: [],
          touchKeys: [],
        },
      });
      return {
        value: null,
        next: {
          ...aggregate,
          recordVersion: aggregate.recordVersion + 1,
          updatedAt: restored.createdAt,
          mapVersions: [...aggregate.mapVersions, restored],
          current: { ...aggregate.current, map: agentMapVersionRef(restored) },
        },
      };
    });
    expect(
      (await f.read()).bindings.every((row) => row.resolution === "ambiguous"),
    ).toBe(true);
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).rejects.toMatchObject({ code: "target_ambiguous" });
    await f.bind(null, 1, f.otherNodeId);
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).resolves.toMatchObject({ agentId });
  });

  it("retains missing links, follows ID-preserving moves and relinks changed identities explicitly", async () => {
    const f = await fixture();
    await f.bind(agentId);
    f.inventory.candidates[0].path = "/private/moved";
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).resolves.toMatchObject({ workflowPath: "/private/moved" });
    f.inventory.candidates.shift();
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).rejects.toMatchObject({ code: "target_not_found" });
    expect(
      (await f.read()).bindings.find((row) => row.nodeId === f.nodeId),
    ).toMatchObject({ agentId, revision: 1 });
    f.inventory.discoveryComplete = false;
    await expect(f.bind(agentId, 1)).rejects.toMatchObject({
      code: "discovery_unavailable",
    });
    f.lookup.mockRejectedValueOnce(new Error("private path"));
    await expect(
      f.service.inventory(projectId, authorize),
    ).rejects.toMatchObject({ code: "discovery_unavailable" });
    f.lookup.mockRejectedValueOnce(new Error("private path"));
    const version = (await f.store.readAggregate(projectId)).current.map!
      .versionId;
    await expect(
      f.service.bind(
        projectId,
        {
          expectedMapVersionId: version,
          nodeId: f.nodeId,
          agentId: null,
          expectedRevision: 1,
        },
        authorize,
      ),
    ).resolves.toMatchObject({ ok: true });
    await f.bind(secondId, 2);
    f.inventory.candidates.push({
      ...f.inventory.candidates[0],
      path: "/private/duplicate",
    });
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).rejects.toMatchObject({ code: "target_ambiguous" });
    await f.edit([{ kind: "remove-node", nodeId: f.nodeId }]);
    await expect(
      f.service.target(projectId, f.nodeId, authorize),
    ).rejects.toMatchObject({ code: "node_not_found" });
    expect(JSON.parse(await fs.readFile(f.file, "utf8")).bindings).toHaveLength(
      1,
    );
  });

  it.each([
    null,
    "broken",
    { schemaVersion: 2 },
    { schemaVersion: 1, projectId: "foreign", bindings: [] },
  ])("preserves invalid sidecar bytes: %j", async (value) => {
    const f = await fixture();
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    await fs.writeFile(f.file, bytes);
    await expect(f.bind(agentId)).rejects.toBeInstanceOf(AgentMapBindingError);
    expect(await fs.readFile(f.file, "utf8")).toBe(bytes);
  });

  it("rejects malformed inputs and duplicate stored node keys", async () => {
    const f = await fixture();
    await expect(
      f.service.bind(projectId, { projectId, agentId }, authorize),
    ).rejects.toMatchObject({ code: "malformed_input" });
    await f.bind(agentId);
    const file = JSON.parse(await fs.readFile(f.file, "utf8"));
    file.bindings.push(file.bindings[0]);
    await fs.writeFile(f.file, JSON.stringify(file));
    await expect(f.read()).rejects.toMatchObject({ code: "malformed_state" });
  });

  it.each(["bind", "inventory"] as const)(
    "rechecks authorization after an awaited %s lookup",
    async (operation) => {
      const f = await fixture();
      const version = (await f.read()).mapVersionId;
      let live = true;
      f.lookup.mockImplementationOnce(async () => {
        live = false;
        return f.inventory;
      });
      const check = () => {
        if (!live) throw new Error("Session authority was revoked");
      };
      const pending =
        operation === "bind"
          ? f.service.bind(
              projectId,
              {
                expectedMapVersionId: version,
                nodeId: f.nodeId,
                expectedRevision: 0,
                agentId,
              },
              check,
            )
          : f.service.inventory(projectId, check);
      await expect(pending).rejects.toMatchObject({ code: "unauthorized" });
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "recovers through reread when rename completion is %s",
    async (committed) => {
      const f = await fixture();
      await f.bind(agentId);
      const original = fs.rename;
      const spy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (from, to) => {
          if (to !== f.file) return original(from, to);
          if (committed) await original(from, to);
          throw new Error("simulated storage failure");
        });
      await expect(f.bind(secondId, 1)).rejects.toMatchObject({
        code: "storage_unavailable",
        detail: { recovery: "reread" },
      });
      spy.mockRestore();
      expect(
        (await f.read()).bindings.find((row) => row.nodeId === f.nodeId),
      ).toMatchObject({
        agentId: committed ? secondId : agentId,
        revision: committed ? 2 : 1,
      });
    },
  );
});
