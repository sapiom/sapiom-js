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
    );
    const restarted = await new StudioWorkspacePreferenceStore(
      value.file,
    ).current("user-a", value.projectId, [projectRoot], value.workflows);
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

  it("isolates users and repairs deleted or foreign agent ids to map", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const current = await store.current(
      "user-a",
      value.projectId,
      [projectRoot],
      value.workflows,
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
    );
    expect(
      (
        await store.current(
          "user-b",
          value.projectId,
          [projectRoot],
          value.workflows,
        )
      ).selection.kind,
    ).toBe("agent-map");
    expect(
      await store.current("user-a", value.projectId, [projectRoot], []),
    ).toMatchObject({ repaired: true, selection: { kind: "agent-map" } });
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
      ),
    ).toMatchObject({ repaired: true, selection: { kind: "agent-map" } });
  });

  it("reconciles a moved workflow by definition id without changing its id", async () => {
    const value = await fixture();
    const projectRoot = path.join(value.root, "project");
    const store = new StudioWorkspacePreferenceStore(value.file);
    const original = [{ ...value.workflows[0]!, definitionId: 42 }];
    const first = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      original,
    );
    const moved = [
      { ...original[0]!, path: path.join(projectRoot, "renamed") },
    ];
    const second = await store.current(
      "user",
      value.projectId,
      [projectRoot],
      moved,
    );
    expect(second.agents[0]!.agentId).toBe(first.agents[0]!.agentId);
  });
});
