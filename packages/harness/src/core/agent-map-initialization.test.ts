import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftRef } from "../shared/agent-map.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
import {
  AgentMapInitializationCoordinator,
  AgentMapInitializationFailure,
  type InitializationProject,
} from "./agent-map-initialization.js";
import {
  createEmptyProjectPlanningAggregate,
  computeProjectPlanningAggregateDigest,
  parseProjectPlanningAggregate,
} from "./agent-map-aggregate-migration.js";
import {
  collectAgentMapEvidence,
  initialMapRequest,
} from "./agent-map-initialization-evidence.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { emptyLegacyContainer } from "./test-fixtures/empty-legacy-container.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const otherId = "project_00000000-0000-4000-8000-000000000002";
const agentId = "agent_00000000-0000-4000-8000-000000000001";
const now = "2026-09-06T00:00:00.000Z";
const actor = { projectId, userId: "user-test", sessionId: "coding-session" };
const node = {
  kind: "add-node" as const,
  draftRef: "agent" as DraftRef,
  node: {
    kind: "agent" as const,
    name: "Research",
    purpose: "Research contracts",
    ownerAgent: null,
    contractRefs: [],
  },
};
const output = () => ({
  nodes: [
    {
      ref: "research",
      kind: "agent",
      agentId,
      name: "Research",
      purpose: "Research contracts",
      ownerRef: null,
      contractRefs: [`studio-agent:${agentId}`],
    },
  ],
  relationships: [],
});
const roots: string[] = [];
const coordinators: AgentMapInitializationCoordinator[] = [];
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((c) => c.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "map-init-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(
    path.join(source, "index.ts"),
    'throw new Error("MUST NEVER EXECUTE"); export const agent = defineAgent({ name: "Research", description: "Research contracts", inputSchema: z.object({ topic: z.string() }) });',
  );
  const file = path.join(root, "projects", projectId, "workspace.json");
  const store = new AgentMapWorkspaceStore(root);
  const proposals = new AgentMapProposalService(store);
  const project: InitializationProject = {
    userId: actor.userId,
    available: true,
    discoveryComplete: true,
    agents: [{ agentId, name: "Research", path: source }],
    provider: "claude-code",
  };
  const infer = vi.fn(async () => output());
  const create = (
    extra: Partial<
      ConstructorParameters<typeof AgentMapInitializationCoordinator>[0]
    > = {},
  ) => {
    const coordinator = new AgentMapInitializationCoordinator({
      store,
      proposals,
      project: async () => project,
      infer,
      ...extra,
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  const write = async (value: unknown, id = projectId) => {
    const destination = path.join(root, "projects", id, "workspace.json");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(value));
  };
  return {
    root,
    source,
    file,
    store,
    proposals,
    project,
    infer,
    create,
    write,
  };
}
async function finished(
  c: AgentMapInitializationCoordinator,
  status = "completed",
  id = projectId,
) {
  await vi.waitFor(async () =>
    expect((await c.status(id)).status).toBe(status),
  );
}

describe("format-1 reset", () => {
  it.each(["malformed", "null", "unreadable"])(
    "keeps an authored format-2 map readable with a %s reset marker",
    async (kind) => {
      const f = await fixture();
      await f.proposals.propose(actor, {
        schemaVersion: 1,
        proposalId: null,
        expectedVersion: 0,
        requestId: "authored-before-reset",
        operations: [node],
      });
      const marker = path.join(path.dirname(f.file), "legacy-reset.json");
      if (kind === "unreadable") await fs.mkdir(marker);
      else await fs.writeFile(marker, kind === "malformed" ? "{" : "null");
      const before = await fs.readFile(f.file);
      await f.store.resetLegacyMaps();
      await f.store.resetLegacyMaps();
      const snapshot = await f.store.readSnapshot(projectId);
      expect(snapshot.proposal?.nodes).toHaveLength(1);
      expect(await fs.readFile(f.file)).toEqual(before);
      await f.create().schedule(projectId);
      expect(f.infer).not.toHaveBeenCalled();
    },
  );

  it("does not let a corrupt reset marker change primary map classification", async () => {
    const f = await fixture();
    await fs.mkdir(path.dirname(f.file), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(f.file), "legacy-reset.json"),
      "{",
    );
    const c = f.create();
    await c.schedule(projectId);
    await finished(c);
    expect(f.infer).toHaveBeenCalledOnce();
    await f.write({ storageSchemaVersion: 2, workspace: { schemaVersion: 1 } });
    await expect(f.store.readSnapshot(projectId)).rejects.toMatchObject({
      code: "malformed_state",
    });
    await f.write({ storageSchemaVersion: 99 });
    await expect(f.store.readSnapshot(projectId)).rejects.toMatchObject({
      code: "unsupported_schema",
    });
  });

  it.each([null, { nodes: [{ name: "Legacy agent" }], relationships: [] }])(
    "deletes only the qualifying workspace and preserves neighboring state (%j)",
    async (proposal) => {
      const f = await fixture();
      await f.write({
        storageSchemaVersion: 1,
        workspace: { projectId },
        proposal,
      });
      const history = path.join(path.dirname(f.file), "history.json");
      await fs.writeFile(history, "conversation");
      const v2 = createEmptyProjectPlanningAggregate(otherId, now);
      await f.write(v2, otherId);
      const otherFile = path.join(
        f.root,
        "projects",
        otherId,
        "workspace.json",
      );
      const before = await fs.readFile(otherFile);
      await f.store.resetLegacyMaps();
      await f.store.resetLegacyMaps();
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(otherFile)).toEqual(before);
      expect(await fs.readFile(history, "utf8")).toBe("conversation");
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(path.dirname(f.file), "legacy-reset.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "completed" });
    },
  );
  it.each(["prepared", "deleted"] as const)(
    "recovers a reset interrupted after %s",
    async (step) => {
      const f = await fixture();
      await f.write({ storageSchemaVersion: 1, proposal: null });
      await new AgentMapWorkspaceStore(f.root, {
        beforeLegacyResetStep: (at) => {
          if (at === step) throw new Error("crash");
        },
      }).resetLegacyMaps();
      await f.store.resetLegacyMaps();
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(path.dirname(f.file), "legacy-reset.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "completed" });
    },
  );
  it.each([
    {
      storageSchemaVersion: 2,
      workspace: { schemaVersion: 1 },
      proposal: { nodes: ["legacy wrapped 2"] },
      buildPlanning: { plans: ["preserve"], briefs: ["preserve"] },
    },
    {
      ...createEmptyProjectPlanningAggregate(projectId, now),
      nested: { schemaVersion: 1 },
    },
    createEmptyProjectPlanningAggregate(projectId, now),
    { schemaVersion: 1, arbitrary: "not an outer version" },
  ])(
    "never writes format 2 or nested-version records during reset (%j)",
    async (value) => {
      const f = await fixture();
      await f.write(value);
      const before = await fs.readFile(f.file);
      await f.store.resetLegacyMaps();
      expect(await fs.readFile(f.file)).toEqual(before);
    },
  );
  it("rereads the version after acquiring a contended lock", async () => {
    const f = await fixture();
    await f.write({ storageSchemaVersion: 1 });
    const release = await new DurableFileLock(f.file).acquire();
    const reset = f.store.resetLegacyMaps();
    await f.write(createEmptyProjectPlanningAggregate(projectId, now));
    const before = await fs.readFile(f.file);
    await release();
    await reset;
    expect(await fs.readFile(f.file)).toEqual(before);
  });
  it("resets a late format-1 write instead of invoking the legacy converter", async () => {
    const f = await fixture();
    await f.store.resetLegacyMaps();
    await f.write({
      storageSchemaVersion: 1,
      proposal: { invalidLegacyGraph: true },
    });
    const aggregate = await f.store.readAggregate(projectId);
    expect(aggregate.mapVersions).toEqual([]);
    expect(aggregate.storageSchemaVersion).toBe(2);
  });
});

describe("initialization eligibility and ownership", () => {
  it("initializes an old empty container when dependencies are symlinked", async () => {
    const f = await fixture();
    const dependency = path.join(f.root, "external-dependency");
    await fs.mkdir(dependency);
    await fs.writeFile(
      path.join(dependency, "index.ts"),
      'const description = "EXTERNAL_SOURCE_MUST_NOT_ENTER_EVIDENCE";',
    );
    await fs.symlink(
      dependency,
      path.join(f.source, "node_modules"),
      "junction",
    );
    await f.write(emptyLegacyContainer(projectId));
    const c = f.create();
    await c.schedule(projectId);
    await finished(c);
    expect(f.infer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining(
          "EXTERNAL_SOURCE_MUST_NOT_ENTER_EVIDENCE",
        ),
      }),
    );
    expect(
      (await f.store.readSnapshot(projectId)).proposal?.nodes,
    ).toHaveLength(1);
  });

  it.each(["missing", "current", "legacy"])(
    "publishes a complete initial map only once (%s container)",
    async (kind) => {
      const f = await fixture();
      if (kind === "current") await f.store.readAggregate(projectId);
      if (kind === "legacy") await f.write(emptyLegacyContainer(projectId));
      const c = f.create();
      await c.schedule(projectId);
      await finished(c);
      const before = await fs.readFile(f.file);
      expect(
        (await f.store.readSnapshot(projectId)).proposal?.nodes,
      ).toHaveLength(1);
      await c.schedule(projectId);
      await c.schedule(projectId, true);
      await f.create().schedule(projectId);
      expect(f.infer).toHaveBeenCalledOnce();
      expect(await fs.readFile(f.file)).toEqual(before);
    },
  );
  it.each(["unavailable", "incomplete", "no-agents"])(
    "does not initialize %s projects",
    async (reason) => {
      const f = await fixture();
      if (reason === "unavailable") f.project.available = false;
      if (reason === "incomplete") f.project.discoveryComplete = false;
      if (reason === "no-agents") f.project.agents = [];
      expect((await f.create().schedule(projectId)).status).toBe("idle");
      expect(f.infer).not.toHaveBeenCalled();
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each([
    "{",
    '{"storageSchemaVersion":99}',
    '{"storageSchemaVersion":2,"workspace":{"schemaVersion":1}}',
  ])("does not interpret invalid state as absence: %s", async (raw) => {
    const f = await fixture();
    await fs.mkdir(path.dirname(f.file), { recursive: true });
    await fs.writeFile(f.file, raw);
    await expect(f.create().schedule(projectId)).rejects.toBeDefined();
    expect(f.infer).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(raw);
  });
  it("protects authored maps whose nodes have all been deleted", async () => {
    const f = await fixture();
    await f.proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "add-remove",
      operations: [node],
    });
    const first = await f.store.readSnapshot(projectId);
    await f.proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: first.proposal!.id,
      expectedVersion: 1,
      requestId: "remove",
      operations: [
        { kind: "remove-node", nodeId: first.proposal!.nodes[0]!.id },
      ],
    });
    const before = await fs.readFile(f.file);
    await f.store.migrateEmptyLegacyContainers();
    await f.create().schedule(projectId);
    expect(f.infer).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file)).toEqual(before);
  });
  it("protects a valid operation-history-only container with no map versions", async () => {
    const f = await fixture();
    await f.proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "add",
      operations: [node],
    });
    const first = await f.store.readSnapshot(projectId);
    await f.proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: first.proposal!.id,
      expectedVersion: 1,
      requestId: "remove",
      operations: [
        { kind: "remove-node", nodeId: first.proposal!.nodes[0]!.id },
      ],
    });
    const aggregate = await f.store.readAggregate(projectId);
    // Represent one accepted add/remove batch. Its final graph is unchanged,
    // so the format-2 history is valid without a semantic map version.
    aggregate.mapOperationHistory = aggregate.mapOperationHistory.map(
      (record) => ({
        ...record,
        acceptedVersion: 1,
        requestId: "neutral",
        acceptedAt: now,
      }),
    );
    aggregate.mapVersions = [];
    aggregate.current.map = null;
    aggregate.requestReceipts = [];
    aggregate.aggregateDigest =
      computeProjectPlanningAggregateDigest(aggregate);
    await f.write(parseProjectPlanningAggregate(aggregate, projectId));
    const before = await fs.readFile(f.file);
    await f.create().schedule(projectId);
    expect(f.infer).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file)).toEqual(before);
  });
  it("resumes queued jobs after restart without requiring a retry", async () => {
    const f = await fixture();
    const previous = f.create({ concurrency: 0 });
    await previous.schedule(projectId);
    await previous.close();
    const next = f.create();
    await next.schedule(projectId);
    await finished(next);
    expect(f.infer).toHaveBeenCalledOnce();
  });
  it("runs at most two projects concurrently and starts the third when a slot opens", async () => {
    const f = await fixture();
    const ids = [
      projectId,
      otherId,
      "project_00000000-0000-4000-8000-000000000003",
    ];
    const releases = new Map<string, () => void>();
    const infer = vi.fn(
      ({ projectId: id, signal }: { projectId: string; signal: AbortSignal }) =>
        new Promise<unknown>((resolve, reject) => {
          releases.set(id, () => resolve(output()));
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const c = f.create({ infer });
    await Promise.all(ids.map((id) => c.schedule(id)));
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
    expect(
      (await Promise.all(ids.map((id) => c.status(id)))).filter(
        (status) => status.status === "queued",
      ),
    ).toHaveLength(1);
    [...releases.values()][0]!();
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(3));
    for (const release of releases.values()) release();
    await Promise.all(ids.map((id) => finished(c, "completed", id)));
  });
  it.each([false, true])(
    "a map created before dispatch prevents provider execution (legacy=%s)",
    async (legacy) => {
      const f = await fixture();
      if (legacy) await f.write(emptyLegacyContainer(projectId));
      const c = f.create({ concurrency: 0 });
      await c.schedule(projectId);
      await f.proposals.propose(actor, {
        schemaVersion: 1,
        proposalId: null,
        expectedVersion: 0,
        requestId: "user",
        operations: [node],
      });
      await c.close();
      const next = f.create();
      await next.schedule(projectId);
      expect(f.infer).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "discards inference if an ordinary coding session writes first (legacy=%s)",
    async (legacy) => {
      const f = await fixture();
      if (legacy) await f.write(emptyLegacyContainer(projectId));
      let release!: (value: unknown) => void;
      const infer = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      );
      const c = f.create({ infer });
      await c.schedule(projectId);
      await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
      await f.proposals.propose(actor, {
        schemaVersion: 1,
        proposalId: null,
        expectedVersion: 0,
        requestId: "user",
        operations: [node],
      });
      const before = await fs.readFile(f.file);
      release(output());
      await vi.waitFor(async () => {
        const raw = JSON.parse(
          await fs.readFile(
            path.join(path.dirname(f.file), "initialization.json"),
            "utf8",
          ),
        );
        expect(raw.status).toBe("skipped");
      });
      expect(await fs.readFile(f.file)).toEqual(before);
    },
  );
  it.each([false, true])(
    "independent hosts cannot own the same running attempt (legacy=%s)",
    async (legacy) => {
      const f = await fixture();
      if (legacy) await f.write(emptyLegacyContainer(projectId));
      const a = f.create();
      const b = f.create({ store: new AgentMapWorkspaceStore(f.root) });
      await Promise.all([a.schedule(projectId), b.schedule(projectId)]);
      await finished(a);
      expect(f.infer).toHaveBeenCalledOnce();
    },
  );
  it("interrupted attempts require explicit retry", async () => {
    const f = await fixture();
    await f.create({ concurrency: 0 }).schedule(projectId);
    await f.store.inspectInitialization(projectId, async (_, journal) => {
      const record = (await journal.read())!;
      await journal.write({
        ...record,
        status: "running",
        ownerId: randomUUID(),
        ownerPid: 999999,
      });
    });
    const c = f.create({ isPidAlive: () => false });
    expect((await c.schedule(projectId)).errorCode).toBe("interrupted");
    expect(f.infer).not.toHaveBeenCalled();
    await c.schedule(projectId, true);
    await finished(c);
    expect(f.infer).toHaveBeenCalledOnce();
  });
  it("does not silently switch providers on failure and allows one explicit retry", async () => {
    const f = await fixture();
    f.project.provider = "codex";
    const infer = vi.fn(async (_input: { provider: string }) => {
      throw new AgentMapInitializationFailure("provider_failed");
    });
    const c = f.create({ infer });
    await c.schedule(projectId);
    await finished(c, "failed");
    await c.schedule(projectId);
    expect(infer).toHaveBeenCalledOnce();
    expect(infer.mock.calls[0]?.[0]).toMatchObject({ provider: "codex" });
    await c.schedule(projectId, true);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
  });
  it("bootstrap and initialization share one first-map reservation", async () => {
    const f = await fixture();
    const c = f.create({ concurrency: 0 });
    await c.schedule(projectId);
    expect(await c.reserveForBootstrap(projectId)).toBe(false);
    const other = f.create();
    expect(await other.reserveForBootstrap(otherId)).toBe(true);
    expect((await other.schedule(otherId)).status).toBe("skipped");
    expect(f.infer).not.toHaveBeenCalled();
  });
  it.each(["timeout", "cancelled"] as const)(
    "records %s without publishing a partial map",
    async (reason) => {
      const f = await fixture();
      const infer = vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<unknown>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      const c = f.create({
        infer,
        timeoutMs: reason === "timeout" ? 20 : 10000,
      });
      await c.schedule(projectId);
      await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
      if (reason === "cancelled") await c.close();
      await finished(c, "failed");
      expect((await c.status(projectId)).errorCode).toBe(reason);
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("collects contracts statically and rejects omitted agents or invented references", async () => {
    const f = await fixture();
    const evidence = await collectAgentMapEvidence(f.project.agents);
    expect(evidence.prompt).toContain("inputSchema");
    expect(evidence.prompt).not.toContain(f.source);
    expect(
      initialMapRequest(output(), evidence, randomUUID()).operations,
    ).toHaveLength(1);
    for (const bad of [
      { nodes: [], relationships: [] },
      {
        ...output(),
        relationships: [
          {
            from: "research",
            to: "missing",
            kind: "invokes",
            executionMode: null,
            contractRef: "invented",
            description: "",
          },
        ],
      },
    ])
      expect(() => initialMapRequest(bad, evidence, randomUUID())).toThrow(
        "invalid_output",
      );
  });
  it.each(["invokes", "uses"] as const)(
    "validates %s to a contract-backed connector before publishing",
    async (kind) => {
      const f = await fixture();
      const draft = output();
      const nodes = [
        ...draft.nodes,
        {
          ref: "service",
          kind: "connector",
          agentId: null,
          name: "External service",
          purpose: "Access an external API",
          ownerRef: null,
          contractRefs: [`contract:${agentId}:1`],
        },
      ];
      const infer = vi.fn(async () => ({
        nodes,
        relationships: [
          {
            from: "research",
            to: "service",
            kind,
            executionMode: null,
            contractRef: `contract:${agentId}:1`,
            description: "Access the declared API",
          },
        ],
      }));
      const c = f.create({ infer });
      await c.schedule(projectId);
      await finished(c, kind === "uses" ? "completed" : "failed");
      if (kind === "invokes") {
        expect((await c.status(projectId)).errorCode).toBe("invalid_output");
        await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const snapshot = await f.store.readSnapshot(projectId);
        expect(snapshot.proposal?.nodes).toHaveLength(2);
        expect(snapshot.proposal?.relationships).toHaveLength(1);
      }
    },
  );
});

describe("initialization shutdown fencing", () => {
  it("publishes state transitions once and stays silent for ineligible idle projects", async () => {
    const f = await fixture();
    const changed = vi.fn();
    const c = f.create({
      onChange: changed,
      infer: async () => {
        throw new AgentMapInitializationFailure("provider_failed");
      },
    });
    f.project.agents = [];
    await c.schedule(projectId);
    await c.schedule(projectId);
    expect(changed).not.toHaveBeenCalled();
    f.project.agents = [{ agentId, name: "Research", path: f.source }];
    await c.schedule(projectId);
    await finished(c, "failed");
    const transitions = changed.mock.calls.map(([status]) => status.status);
    expect(transitions).toEqual(["queued", "running", "failed"]);
    for (let i = 0; i < 5; i++) await c.schedule(projectId);
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it("does not commit if cancelled during the final project lookup", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let lookups = 0;
    const c = f.create({
      project: async () => {
        if (++lookups === 3) {
          entered();
          await held;
        }
        return f.project;
      },
    });
    await c.schedule(projectId);
    await arrived;
    const closing = c.close();
    release();
    await closing;
    expect(await c.status(projectId)).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
      retryable: true,
    });
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("waits for an in-flight eligibility read without writing after close", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = f.create({
      project: async () => {
        entered();
        await held;
        return f.project;
      },
    });
    const scheduled = c.schedule(projectId);
    await arrived;
    const closing = c.close();
    release();
    await Promise.all([scheduled, closing]);
    expect(f.infer).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(path.dirname(f.file), "initialization.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cancellation while waiting to commit remains a retryable failure", async () => {
    const f = await fixture();
    let complete!: (value: unknown) => void;
    const infer = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          complete = resolve;
        }),
    );
    const c = f.create({ infer });
    await c.schedule(projectId);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
    const release = await new DurableFileLock(f.file).acquire();
    complete(output());
    // The result is available, but its transaction cannot yet acquire the map lock.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closed = c.close();
    await release();
    await closed;
    expect(await c.status(projectId)).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
      retryable: true,
    });
  });
});

describe("terminal journal recovery", () => {
  it("restores explicit retry after a failed terminal write while the host remains alive", async () => {
    const f = await fixture();
    let unavailable = true;
    const store = new AgentMapWorkspaceStore(f.root, {
      beforeInitializationWrite: (status) => {
        if (status === "failed" && unavailable)
          throw new Error("temporary storage failure");
      },
    });
    const infer = vi.fn(async () => {
      throw new AgentMapInitializationFailure("provider_failed");
    });
    const c = f.create({
      store,
      proposals: new AgentMapProposalService(store),
      infer,
    });
    await c.schedule(projectId);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    unavailable = false;
    await finished(c, "failed");
    expect(await c.status(projectId)).toMatchObject({
      errorCode: "storage_unavailable",
      retryable: true,
    });
    await c.schedule(projectId);
    expect(infer).toHaveBeenCalledOnce();
    await c.schedule(projectId, true);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
  });
});
