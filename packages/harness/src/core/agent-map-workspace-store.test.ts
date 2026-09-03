import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DraftRef, PlanningSessionIdentity } from "../shared/agent-map.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { emptyBuildPlanningAggregate } from "../shared/build-plan.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";

describe("AgentMapWorkspaceStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-store-"));
    roots.push(root);
    return root;
  }

  it("lazily creates exactly one empty record under concurrent reads and survives restart", async () => {
    const root = await fixture();
    const onEvent = vi.fn();
    const store = new AgentMapWorkspaceStore(root, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      onEvent,
    });

    const records = await Promise.all(
      Array.from({ length: 20 }, () => store.readOrCreate(projectId)),
    );
    const restarted = await new AgentMapWorkspaceStore(root).readOrCreate(
      projectId,
    );

    expect(new Set(records.map((record) => JSON.stringify(record))).size).toBe(
      1,
    );
    expect(restarted).toEqual(records[0]);
    expect(restarted).toEqual({
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      name: "agent_map.workspace_initialized",
      projectId,
    });
  });

  it("selects one winner across independent store instances", async () => {
    const root = await fixture();
    const firstEvent = vi.fn();
    const secondEvent = vi.fn();
    const first = new AgentMapWorkspaceStore(root, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
      onEvent: firstEvent,
    });
    const second = new AgentMapWorkspaceStore(root, {
      now: () => new Date("2026-09-01T12:00:01.000Z"),
      onEvent: secondEvent,
    });

    const [left, right] = await Promise.all([
      first.readOrCreate(projectId),
      second.readOrCreate(projectId),
    ]);
    const restarted = await new AgentMapWorkspaceStore(root).readOrCreate(
      projectId,
    );

    expect(left).toEqual(right);
    expect(restarted).toEqual(left);
    expect(firstEvent.mock.calls.length + secondEvent.mock.calls.length).toBe(
      1,
    );
  });

  it("does not treat a leftover temporary file as workspace state", async () => {
    const root = await fixture();
    const directory = path.join(root, "projects", projectId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "workspace.json.tmp-stale"),
      "partial",
    );
    await expect(
      new AgentMapWorkspaceStore(root).readOrCreate(projectId),
    ).resolves.toMatchObject({
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
    });
  });

  it("migrates the exact E1 record into the aggregate without changing its public projection", async () => {
    const root = await fixture();
    const workspacePath = path.join(
      root,
      "projects",
      projectId,
      "workspace.json",
    );
    const workspace = {
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    };
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, `${JSON.stringify(workspace)}\n`);

    await expect(
      new AgentMapWorkspaceStore(root).readOrCreate(projectId),
    ).resolves.toEqual(workspace);
    expect(JSON.parse(await fs.readFile(workspacePath, "utf8"))).toEqual({
      storageSchemaVersion: 2,
      workspace,
      proposal: null,
      receipts: [],
      buildPlanning: emptyBuildPlanningAggregate(),
    });
  });

  it("migrates an E2 aggregate without changing architecture state", async () => {
    const root = await fixture();
    const workspacePath = path.join(
      root,
      "projects",
      projectId,
      "workspace.json",
    );
    const store = new AgentMapWorkspaceStore(root, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });
    const service = new AgentMapProposalService(store, {
      now: () => new Date("2026-09-01T12:01:00.000Z"),
    });
    const identity: PlanningSessionIdentity = {
      projectId,
      userId: "user-1",
      sessionId: "session-1",
      role: "map-planner",
    };
    await service.propose(identity, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "request-1",
      operations: [
        {
          kind: "add-node",
          draftRef: "draft-1" as DraftRef,
          node: {
            kind: "agent",
            name: "Builder",
            purpose: "Build the system",
            ownerAgent: null,
            contractRefs: ["contract-1"],
          },
        },
      ],
    });
    const current = JSON.parse(await fs.readFile(workspacePath, "utf8")) as {
      workspace: unknown;
      proposal: { history: unknown[] };
      receipts: unknown[];
    };
    const legacy = {
      storageSchemaVersion: 1,
      workspace: current.workspace,
      proposal: current.proposal,
      receipts: current.receipts,
    };
    await fs.writeFile(workspacePath, `${JSON.stringify(legacy)}\n`);

    const aggregate = await new AgentMapWorkspaceStore(root).readAggregate(
      projectId,
    );

    expect(aggregate).toEqual({
      storageSchemaVersion: 2,
      workspace: current.workspace,
      proposal: current.proposal,
      receipts: current.receipts,
      buildPlanning: emptyBuildPlanningAggregate(),
    });
    expect(current.proposal.history).toHaveLength(1);
    expect(current.receipts).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(workspacePath, "utf8"))).toEqual(
      aggregate,
    );
  });

  it("rejects future aggregate schemas without rewriting them", async () => {
    const root = await fixture();
    const workspacePath = path.join(
      root,
      "projects",
      projectId,
      "workspace.json",
    );
    const raw = `${JSON.stringify({ storageSchemaVersion: 99, workspace: {}, proposal: null, receipts: [] })}\n`;
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, raw);
    await expect(
      new AgentMapWorkspaceStore(root).readOrCreate(projectId),
    ).rejects.toMatchObject({
      code: "unsupported_schema",
      schemaVersion: 99,
    });
    expect(await fs.readFile(workspacePath, "utf8")).toBe(raw);
  });

  it.each(["write", "file-sync", "rename", "directory-sync"] as const)(
    "does not expose a partial aggregate when %s fails",
    async (failedStep) => {
      const root = await fixture();
      let fail = false;
      const store = new AgentMapWorkspaceStore(root, {
        beforePersistStep: (step) => {
          if (fail && step === failedStep) throw new Error("injected failure");
        },
      });
      await store.readOrCreate(projectId);
      fail = true;
      await expect(
        store.transact(projectId, async (aggregate) => ({
          value: undefined,
          next: {
            ...aggregate,
            workspace: { ...aggregate.workspace, recordVersion: 2 },
          },
        })),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      const restarted = await new AgentMapWorkspaceStore(root).readOrCreate(
        projectId,
      );
      expect(restarted.recordVersion).toBe(
        failedStep === "directory-sync" ? 2 : 1,
      );
    },
  );

  it.each([
    ["malformed JSON", "{", "malformed_state"],
    [
      "future schema",
      JSON.stringify({
        projectId,
        schemaVersion: 99,
        recordVersion: 1,
        confirmedRevisionId: null,
        activeProposalId: null,
        projectBuildPlanId: null,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:00:00.000Z",
        futureField: "allowed only because this schema is unsupported",
      }),
      "unsupported_schema",
    ],
    [
      "project mismatch",
      JSON.stringify({
        projectId: "project_00000000-0000-4000-8000-000000000002",
        schemaVersion: 1,
        recordVersion: 1,
        confirmedRevisionId: null,
        activeProposalId: null,
        projectBuildPlanId: null,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:00:00.000Z",
      }),
      "malformed_state",
    ],
  ])(
    "bounds %s failures without repairing the file",
    async (_name, raw, code) => {
      const root = await fixture();
      const workspacePath = path.join(
        root,
        "projects",
        projectId,
        "workspace.json",
      );
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      await fs.writeFile(workspacePath, raw);
      const onEvent = vi.fn();

      await expect(
        new AgentMapWorkspaceStore(root, { onEvent }).readOrCreate(projectId),
      ).rejects.toMatchObject({ code });
      expect(await fs.readFile(workspacePath, "utf8")).toBe(raw);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "agent_map.workspace_read_failed",
          projectId,
          errorCode: code,
        }),
      );
    },
  );

  it("reports storage unavailability without leaking an underlying path", async () => {
    const root = await fixture();
    const blocker = path.join(root, "not-a-directory");
    await fs.writeFile(blocker, "file");
    let error: (Error & { code?: string }) | undefined;
    try {
      await new AgentMapWorkspaceStore(blocker).readOrCreate(projectId);
    } catch (failure) {
      error = failure as Error & { code?: string };
    }
    expect(error).toBeDefined();
    expect(error!.code).toBe("storage_unavailable");
    expect(error!.message).toBe("Agent Map storage is unavailable");
    expect(error!.message).not.toContain(root);
  });
});
