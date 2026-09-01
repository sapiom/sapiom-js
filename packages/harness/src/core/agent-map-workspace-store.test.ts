import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";

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
