import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type {
  SystemGraphNode,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import { workspaceRelativeLocalKey } from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

import { HarnessRegistryInventoryProvider } from "../../../src/core/system-graph-inventory";

import { mapSystemGraphNavigation } from "./system-graph-navigation";

const workflow = (
  name: string,
  path: string,
  definitionSlug: string | null,
): WorkflowInfo => ({
  name,
  path,
  definitionId: definitionSlug ? 1 : null,
  definitionSlug,
  source: "scan",
});

const graphNode = (agentKey: string, label = agentKey): SystemGraphNode => ({
  id: `agent:${agentKey}`,
  agentKey,
  label,
});

const scopes: WorkspaceScopeSummary[] = [
  { workspaceKey: "workspace-root", cwd: "/repo" },
  { workspaceKey: "workspace-nested", cwd: "/repo/nested" },
];

describe("workspaceRelativeLocalKey", () => {
  it("handles scope roots, outside paths, Windows paths, and UNC paths", () => {
    expect(workspaceRelativeLocalKey("/repo/agent", "/repo/agent")).toBe(
      "local:agent",
    );
    expect(workspaceRelativeLocalKey("/", "/")).toBe("local:root");
    expect(workspaceRelativeLocalKey("/repo", "/other/agent")).toBeNull();
    expect(
      workspaceRelativeLocalKey("C:\\Repo", "c:\\repo\\Tools\\Reporting"),
    ).toBe("local:Tools/Reporting");
    expect(
      workspaceRelativeLocalKey("C:\\Repo", "D:\\Repo\\Reporting"),
    ).toBeNull();
    expect(
      workspaceRelativeLocalKey(
        "\\\\Server\\Share\\Repo",
        "\\\\server\\share\\repo\\Reporting",
      ),
    ).toBe("local:Reporting");
  });
});

describe("mapSystemGraphNavigation", () => {
  it("maps authoritative definition slugs and workspace-relative local keys", () => {
    const deployed = workflow("Research", "/repo/research", "research-agent");
    const local = workflow("Reporting", "/repo/tools/reporting", null);
    const navigation = mapSystemGraphNavigation(
      [graphNode("research-agent"), graphNode("local:tools/reporting")],
      "workspace-root",
      [deployed, local],
      scopes,
    );

    expect(navigation.get("research-agent")).toBe(deployed);
    expect(navigation.get("local:tools/reporting")).toBe(local);
  });

  it("does not resolve by a display label and includes nested project agents", () => {
    const matchingLabel = workflow("Growth", "/repo/growth", null);
    const nested = workflow("Nested", "/repo/nested/agent", "nested-agent");
    const navigation = mapSystemGraphNavigation(
      [graphNode("manifest-name", "Growth"), graphNode("nested-agent")],
      "workspace-root",
      [matchingLabel, nested],
      scopes,
    );

    expect(navigation.has("manifest-name")).toBe(false);
    expect(navigation.get("nested-agent")).toBe(nested);
  });

  it("leaves duplicate slugs inert while retaining unambiguous local identities", () => {
    const first = workflow("First", "/repo/first", "shared");
    const second = workflow("Second", "/repo/second", "shared");
    const navigation = mapSystemGraphNavigation(
      [
        graphNode("shared"),
        graphNode("local:first"),
        graphNode("local:second"),
      ],
      "workspace-root",
      [first, second],
      scopes,
    );

    expect(navigation.has("shared")).toBe(false);
    expect(navigation.get("local:first")).toBe(first);
    expect(navigation.get("local:second")).toBe(second);
  });

  it("does not make one workflow ambiguous when two exact identities coincide", () => {
    const exact = workflow("Exact", "/repo/exact", "local:exact");
    const navigation = mapSystemGraphNavigation(
      [graphNode("local:exact")],
      "workspace-root",
      [exact],
      scopes,
    );

    expect(navigation.get("local:exact")).toBe(exact);
  });

  it("uses the same local identity as server inventory for a symlinked project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "system-graph-navigation-"));
    try {
      const source = path.join(root, "packages", "reporting");
      const linked = path.join(root, "reporting");
      await mkdir(source, { recursive: true });
      await symlink(
        source,
        linked,
        process.platform === "win32" ? "junction" : "dir",
      );
      const local = workflow("Reporting", linked, null);
      const workspaceKey = "workspace-symlink";
      const workspaceScopes = [{ workspaceKey, cwd: root }];
      const inventory = new HarnessRegistryInventoryProvider({
        listWorkflows: () => [local],
      });

      const result = await inventory.listAgents({ workspaceKey, root });
      expect(result.agents).toHaveLength(1);
      const agentKey = result.agents[0]!.agentKey;
      const navigation = mapSystemGraphNavigation(
        [graphNode(agentKey)],
        workspaceKey,
        [local],
        workspaceScopes,
      );

      expect(agentKey).toBe("local:reporting");
      expect(navigation.get(agentKey)).toBe(local);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
