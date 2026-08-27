import { describe, expect, it } from "vitest";
import type {
  SystemGraphNode,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

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
});
