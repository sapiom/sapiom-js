import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StudioWorkspaceSelection } from "../shared/agent-map.js";
import { StudioWorkspacePreferenceStore } from "./studio-workspace-preferences.js";

describe("StudioWorkspacePreferenceStore", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "studio-workspace-pref-"),
    );
    roots.push(root);
    return {
      root,
      file: path.join(root, "preferences.json"),
      projectId: "project_00000000-0000-4000-8000-000000000001",
      workflows: [
        {
          name: "Planner",
          path: path.join(root, "project", "planner"),
          definitionId: null,
        },
      ],
    };
  }

  it("defaults to map and restores an opaque agent selection after restart", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const first = await store.current(
      "user-a",
      value.projectId,
      [projectRoot],
      value.workflows,
      true,
    );
    expect(first.selection).toEqual({
      kind: "agent-map",
      projectId: value.projectId,
    });
    expect(first.agents[0]?.agentId).toMatch(/^agent_/);

    await store.put(
      "user-a",
      value.projectId,
      {
        kind: "agent",
        projectId: value.projectId,
        agentId: first.agents[0]!.agentId,
        privatePath: value.workflows[0]!.path,
      } as StudioWorkspaceSelection,
      [projectRoot],
      value.workflows,
      true,
    );
    const restarted = await new StudioWorkspacePreferenceStore(
      value.file,
    ).current("user-a", value.projectId, [projectRoot], value.workflows, true);
    expect(restarted.selection).toEqual({
      kind: "agent",
      projectId: value.projectId,
      agentId: first.agents[0]!.agentId,
    });
    expect(JSON.stringify(restarted)).not.toContain(value.workflows[0]!.path);
    expect(await fs.readFile(value.file, "utf8")).toContain(
      value.workflows[0]!.path,
    );
    const persisted = JSON.parse(
      await fs.readFile(value.file, "utf8"),
    ) as { preferences: Array<{ selection: unknown }> };
    expect(persisted.preferences[0]!.selection).toEqual({
      kind: "agent",
      projectId: value.projectId,
      agentId: first.agents[0]!.agentId,
    });
  });

  it("isolates users, keeps transient absence in memory, and durably repairs proven deletion", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const current = await store.current(
      "user-a",
      value.projectId,
      [projectRoot],
      value.workflows,
      true,
    );
    await store.put(
      "user-a",
      value.projectId,
      {
        kind: "agent",
        projectId: value.projectId,
        agentId: current.agents[0]!.agentId,
      },
      [projectRoot],
      value.workflows,
      true,
    );
    expect(
      (
        await store.current(
          "user-b",
          value.projectId,
          [projectRoot],
          value.workflows,
          true,
        )
      ).selection.kind,
    ).toBe("agent-map");

    expect(
      await store.current("user-a", value.projectId, [projectRoot], [], false),
    ).toMatchObject({ repaired: false, selection: { kind: "agent-map" } });
    expect(
      await new StudioWorkspacePreferenceStore(value.file).current(
        "user-a",
        value.projectId,
        [projectRoot],
        value.workflows,
        true,
      ),
    ).toMatchObject({
      repaired: false,
      selection: { kind: "agent", agentId: current.agents[0]!.agentId },
    });

    expect(
      await store.current("user-a", value.projectId, [projectRoot], [], true),
    ).toMatchObject({ repaired: true, selection: { kind: "agent-map" } });
    expect(await fs.readFile(value.file, "utf8")).not.toContain(
      value.workflows[0]!.path,
    );
    expect(
      await store.put(
        "user-a",
        value.projectId,
        {
          kind: "agent",
          projectId: value.projectId,
          agentId: "agent_00000000-0000-4000-8000-999999999999",
        },
        [projectRoot],
        value.workflows,
        true,
      ),
    ).toMatchObject({ repaired: true, selection: { kind: "agent-map" } });
  });

  it("preserves an agent preference when PUT races a degraded empty inventory", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const first = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      value.workflows,
      true,
    );
    const selection: StudioWorkspaceSelection = {
      kind: "agent",
      projectId: value.projectId,
      agentId: first.agents[0]!.agentId,
    };
    await store.put(
      "user",
      value.projectId,
      selection,
      [projectRoot],
      value.workflows,
      true,
    );

    const degradedPut = await store.put(
      "user",
      value.projectId,
      selection,
      [projectRoot],
      [],
      false,
    );
    expect(degradedPut).toMatchObject({
      agents: [],
      repaired: false,
      selection: { kind: "agent", agentId: first.agents[0]!.agentId },
    });

    const restarted = new StudioWorkspacePreferenceStore(value.file);
    expect(
      await restarted.current(
        "user",
        value.projectId,
        [projectRoot],
        [],
        false,
      ),
    ).toMatchObject({ repaired: false, selection: { kind: "agent-map" } });
    expect(
      await restarted.current(
        "user",
        value.projectId,
        [projectRoot],
        value.workflows,
        true,
      ),
    ).toMatchObject({
      repaired: false,
      selection: { kind: "agent", agentId: first.agents[0]!.agentId },
    });
  });

  it("preserves a null-definition agent id and remembered selection across an authenticated move and restart", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const first = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      value.workflows,
      true,
    );
    await store.put(
      "user",
      value.projectId,
      {
        kind: "agent",
        projectId: value.projectId,
        agentId: first.agents[0]!.agentId,
      },
      [projectRoot],
      value.workflows,
      true,
    );
    const movedPath = path.join(projectRoot, "archive", "planner");
    await store.moveAgentBindings(value.workflows[0]!.path, movedPath);
    const moved = [
      { ...value.workflows[0]!, path: movedPath },
    ];
    const second = await new StudioWorkspacePreferenceStore(value.file).current(
      "user",
      value.projectId,
      [projectRoot],
      moved,
      true,
    );
    expect(second.agents[0]!.agentId).toBe(first.agents[0]!.agentId);
    expect(second.selection).toMatchObject({
      kind: "agent",
      agentId: first.agents[0]!.agentId,
    });
    const persisted = await fs.readFile(value.file, "utf8");
    expect(persisted).toContain(movedPath);
    expect(persisted).not.toContain(value.workflows[0]!.path);
  });

  it("never repoints an old binding to a different checkout with the same definition id", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const original = [{ ...value.workflows[0]!, definitionId: 42 }];
    const first = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      original,
      true,
    );
    await store.put(
      "user",
      value.projectId,
      {
        kind: "agent",
        projectId: value.projectId,
        agentId: first.agents[0]!.agentId,
      },
      [projectRoot],
      original,
      true,
    );
    const duplicateCheckout = [
      {
        ...original[0]!,
        path: path.join(projectRoot, "other-checkout", "planner"),
      },
    ];
    const reconciled = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      duplicateCheckout,
      true,
    );
    expect(reconciled.selection).toMatchObject({ kind: "agent-map" });
    expect(reconciled.repaired).toBe(true);
    expect(reconciled.agents[0]!.agentId).not.toBe(first.agents[0]!.agentId);
  });
});
