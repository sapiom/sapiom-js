import { describe, expect, it } from "vitest";
import type { SystemGraph } from "@shared/system-graph";

import {
  groupSystemGraphEdges,
  parseSystemGraphNavigation,
  parseSystemGraph,
  parseSystemGraphSnapshot,
} from "./system-graph";

const valid: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey: "workspace-test" },
  nodes: [
    { id: "agent:growth", agentKey: "growth", label: "Growth" },
    { id: "agent:research", agentKey: "research", label: "Research" },
  ],
  edges: [
    {
      from: "agent:research",
      to: "agent:growth",
      kind: "invokes",
      basis: "static-invocation",
      mode: "async",
    },
  ],
  warnings: [],
};

describe("parseSystemGraph", () => {
  it("accepts the system graph contract", () => {
    expect(parseSystemGraph(valid)).toEqual(valid);
  });

  it("rejects the obsolete static invocation basis spelling", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        edges: [{ ...valid.edges[0], basis: "static" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("accepts scoped package display labels", () => {
    const graph = {
      ...valid,
      nodes: [
        {
          id: "agent:growth",
          agentKey: "growth",
          label: "@sapiom/example-slack-notifier",
        },
        valid.nodes[1],
      ],
    };

    expect(parseSystemGraph(graph)).toEqual(graph);
  });

  it("accepts blocking edges and dynamic-target warnings", () => {
    const graph = {
      ...valid,
      edges: [{ ...valid.edges[0], mode: "blocking" }],
      warnings: [
        {
          code: "dynamic-target",
          agentKey: "research",
          message: "Research has a dynamic target.",
        },
      ],
    };

    expect(parseSystemGraph(graph)).toEqual(graph);
  });

  it("accepts typed duplicate and partial-inventory warnings", () => {
    const warnings = [
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared.",
      },
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message: "Could not inspect Reporting; using its local identity.",
      },
    ];

    expect(
      parseSystemGraph({
        ...valid,
        nodes: [
          ...valid.nodes,
          {
            id: "agent:local:reporting",
            agentKey: "local:reporting",
            label: "Reporting",
          },
        ],
        warnings,
      }).warnings,
    ).toEqual(warnings);
  });

  it("rejects an edge whose endpoint is absent", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        edges: [{ ...valid.edges[0], to: "agent:missing" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("rejects unexpected path-bearing fields and wrong graph kinds", () => {
    expect(() =>
      parseSystemGraph({ ...valid, root: "/private/workspace" }),
    ).toThrow();
    expect(() => parseSystemGraph({ ...valid, kind: "canvas" })).toThrow();
  });

  it("rejects unknown warning codes", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        warnings: [{ code: "inventory-broken", message: "Nope" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("rejects unsupported invocation modes", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        edges: [{ ...valid.edges[0], mode: "unknown" }],
      }),
    ).toThrow("Invalid system graph response");
  });

  it("rejects divergent, duplicate, and unsafe node identities", () => {
    for (const nodes of [
      [{ id: "agent:other", agentKey: "growth", label: "Growth" }],
      [
        { id: "agent:growth", agentKey: "growth", label: "Growth" },
        { id: "agent:other", agentKey: "growth", label: "Other" },
      ],
      [
        {
          id: "agent:local:../private",
          agentKey: "local:../private",
          label: "Private",
        },
      ],
      [
        {
          id: "agent:local:C:/private",
          agentKey: "local:C:/private",
          label: "Private",
        },
      ],
    ]) {
      expect(() => parseSystemGraph({ ...valid, nodes, edges: [] })).toThrow(
        "Invalid system graph response",
      );
    }
  });

  it("rejects path-bearing/control display data and duplicate edges", () => {
    for (const label of [
      "/private/agent",
      "private/agent",
      "C:/private/agent",
      "\\\\server\\share",
      "private\\agent",
      "agent\u0085name",
    ]) {
      expect(() =>
        parseSystemGraph({
          ...valid,
          nodes: [{ id: "agent:growth", agentKey: "growth", label }],
          edges: [],
        }),
      ).toThrow("Invalid system graph response");
    }
    for (const message of [
      "Failed at /private/agent",
      "Failed at C:\\private\\agent",
      "failed:/private/agent",
      "failed[/private/agent]",
      "file:///private/agent",
      "Failed\u009f",
    ]) {
      expect(() =>
        parseSystemGraph({
          ...valid,
          warnings: [
            { code: "projection-failed", agentKey: "growth", message },
          ],
        }),
      ).toThrow("Invalid system graph response");
    }
    expect(() =>
      parseSystemGraph({ ...valid, edges: [valid.edges[0], valid.edges[0]] }),
    ).toThrow("Invalid system graph response");

    const ratioWarning = {
      code: "projection-failed" as const,
      agentKey: "growth",
      message: "Success/failure ratio was 3/4.",
    };
    expect(
      parseSystemGraph({ ...valid, warnings: [ratioWarning] }).warnings,
    ).toEqual([ratioWarning]);
  });

  it("rejects warning identities without valid provenance", () => {
    expect(() =>
      parseSystemGraph({
        ...valid,
        warnings: [
          {
            code: "projection-failed",
            agentKey: "ghost",
            message: "Could not inspect Ghost.",
          },
        ],
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraph({
        ...valid,
        warnings: [
          {
            code: "duplicate-agent-key",
            agentKey: "local:shared",
            message: "Multiple agents use shared.",
          },
        ],
      }),
    ).toThrow("Invalid system graph response");
  });
});

describe("parseSystemGraphSnapshot", () => {
  it("accepts every honest lifecycle shape", () => {
    expect(
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "building",
        graph: null,
      }),
    ).toEqual({
      workspaceKey: "workspace-test",
      revision: 1,
      state: "building",
      graph: null,
    });
    for (const state of ["ready", "stale", "degraded"] as const) {
      expect(
        parseSystemGraphSnapshot({
          workspaceKey: "workspace-test",
          revision: 2,
          state,
          graph: valid,
        }).state,
      ).toBe(state);
    }
    expect(
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 3,
        state: "degraded",
        graph: null,
      }).graph,
    ).toBeNull();
  });

  it("rejects cross-workspace, path-bearing, and impossible snapshots", () => {
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-other",
        revision: 1,
        state: "ready",
        graph: valid,
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "stale",
        graph: null,
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "ready",
        graph: valid,
        root: "/private/workspace",
      }),
    ).toThrow("Invalid system graph response");
    expect(() =>
      parseSystemGraphSnapshot({
        workspaceKey: "workspace-test",
        revision: 1,
        state: "building",
        graph: valid,
      }),
    ).toThrow("Invalid system graph response");
    for (const unsafeWorkspaceKey of [
      "",
      " workspace-test",
      "workspace\u0085test",
    ]) {
      expect(() =>
        parseSystemGraphSnapshot({
          workspaceKey: unsafeWorkspaceKey,
          revision: 1,
          state: "building",
          graph: null,
        }),
      ).toThrow("Invalid system graph response");
      expect(() =>
        parseSystemGraph({
          ...valid,
          scope: {
            kind: "working-tree",
            workspaceKey: unsafeWorkspaceKey,
          },
        }),
      ).toThrow("Invalid system graph response");
    }
  });
});

describe("parseSystemGraphNavigation", () => {
  const navigation = {
    workspaceKey: "workspace-test",
    revision: 7,
    targets: [
      { agentKey: "research", workflowPath: "/repo/research" },
      {
        agentKey: "local:tools/reporting",
        workflowPath: "C:\\repo\\tools\\reporting",
      },
    ],
  };

  it("accepts a strict resolver response for the expected graph revision", () => {
    expect(
      parseSystemGraphNavigation(navigation, {
        workspaceKey: "workspace-test",
        revision: 7,
      }),
    ).toEqual(navigation);
  });

  it("rejects duplicate keys, malformed targets, and unknown fields", () => {
    expect(() =>
      parseSystemGraphNavigation({
        ...navigation,
        targets: [navigation.targets[0], navigation.targets[0]],
      }),
    ).toThrow("Invalid system graph navigation response");
    for (const target of [
      { agentKey: "", workflowPath: "/repo/research" },
      { agentKey: "research\u0085", workflowPath: "/repo/research" },
      { agentKey: "private/research", workflowPath: "/repo/research" },
      { agentKey: "local:../research", workflowPath: "/repo/research" },
      { agentKey: "local:C:/research", workflowPath: "/repo/research" },
      { agentKey: "research", workflowPath: "relative/research" },
      { agentKey: "research", workflowPath: "/repo/research", alias: "old" },
    ]) {
      expect(() =>
        parseSystemGraphNavigation({ ...navigation, targets: [target] }),
      ).toThrow("Invalid system graph navigation response");
    }
    expect(() =>
      parseSystemGraphNavigation({ ...navigation, root: "/repo" }),
    ).toThrow("Invalid system graph navigation response");
    expect(() =>
      parseSystemGraphNavigation({
        ...navigation,
        workspaceKey: " workspace-test",
      }),
    ).toThrow("Invalid system graph navigation response");
    expect(() =>
      parseSystemGraphNavigation({
        ...navigation,
        workspaceKey: "workspace\u009ftest",
      }),
    ).toThrow("Invalid system graph navigation response");
  });

  it("rejects a resolver for another workspace or displayed revision", () => {
    expect(() =>
      parseSystemGraphNavigation(navigation, {
        workspaceKey: "workspace-other",
      }),
    ).toThrow("Mismatched system graph navigation response");
    expect(() =>
      parseSystemGraphNavigation(navigation, {
        workspaceKey: "workspace-test",
        revision: 8,
      }),
    ).toThrow("Mismatched system graph navigation response");
  });
});

describe("groupSystemGraphEdges", () => {
  it("groups mode-specific records into one stable visible connector", () => {
    expect(
      groupSystemGraphEdges([
        { ...valid.edges[0], mode: "async" },
        { ...valid.edges[0], mode: "blocking" },
        { ...valid.edges[0], mode: "async" },
      ]),
    ).toEqual([
      {
        from: "agent:research",
        to: "agent:growth",
        modes: ["blocking", "async"],
      },
    ]);
  });
});
