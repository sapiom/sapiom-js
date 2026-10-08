import { describe, expect, it } from "vitest";

import {
  agentFolder,
  agentDisplayName,
  agentRole,
  displayNames,
  drawnRef,
  chipKind,
  chipLabel,
  deploymentLabel,
  edgeId,
  edgeLabel,
  systemDisplayName,
  edgeTitle,
  foldChips,
  mapStructureKey,
  workflowForAgent,
  type AgentMap,
  type MapAgent,
  type MapEdge,
} from "./project-map";

const agent = (slug: string, over: Partial<MapAgent> = {}): MapAgent => ({
  slug,
  path: slug,
  description: "",
  deployed: null,
  changedSinceRef: false,
  shared: [],
  triggers: [],
  ...over,
});
const edge = (from: string, to: string, over: Partial<MapEdge> = {}): MapEdge => ({
  from,
  to,
  kind: "launch",
  evidence: [],
  ...over,
});
const mapOf = (over: Partial<AgentMap> = {}): AgentMap => ({
  root: "/work/proj",
  systems: [],
  agents: [],
  edges: [],
  unresolved: [],
  platform: "skipped",
  labels: "unavailable",
  ...over,
});

describe("agentRole and edgeLabel", () => {
  it("return the label's value when the map tool attached one", () => {
    expect(agentRole({ ...agent("a"), role: { value: "Intake" } } as unknown as MapAgent)).toBe("Intake");
    expect(edgeLabel({ ...edge("a", "b"), label: { value: "starts screening" } } as unknown as MapEdge)).toBe(
      "starts screening",
    );
  });
  it("return null when absent", () => {
    expect(agentRole(agent("a"))).toBeNull();
    expect(edgeLabel(edge("a", "b"))).toBeNull();
  });
  it("return null when blank or malformed", () => {
    expect(agentRole({ ...agent("a"), role: { value: "   " } } as unknown as MapAgent)).toBeNull();
    expect(edgeLabel({ ...edge("a", "b"), label: { value: "" } } as unknown as MapEdge)).toBeNull();
    expect(edgeLabel({ ...edge("a", "b"), label: { value: 3 } } as unknown as MapEdge)).toBeNull();
    expect(agentRole({ ...agent("a"), role: null } as unknown as MapAgent)).toBeNull();
  });
});

describe("edgeId", () => {
  it("is stable and distinguishes kind and event type for one pair", () => {
    expect(edgeId(edge("a", "b"))).toBe(edgeId(edge("a", "b")));
    const ids = [
      edge("a", "b"),
      edge("a", "b", { kind: "signal" }),
      edge("a", "b", { kind: "event", eventType: "x.done" }),
      edge("a", "b", { kind: "event", eventType: "x.failed" }),
      edge("b", "a"),
    ].map(edgeId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("ignores evidence", () => {
    const evidence = [{ file: "a.ts", line: 1, text: "x" }];
    expect(edgeId(edge("a", "b", { evidence }))).toBe(edgeId(edge("a", "b")));
  });
});

describe("edgeTitle", () => {
  it("names the kind", () => {
    expect(edgeTitle(edge("a", "b"))).toBe("a → b: launch");
  });
  it("names the event type for an event", () => {
    expect(edgeTitle(edge("a", "b", { kind: "event", eventType: "x.done" }))).toBe(
      "a → b: event x.done",
    );
  });
  it("falls back to the kind for an event with no type", () => {
    expect(edgeTitle(edge("a", "b", { kind: "event" }))).toBe("a → b: event");
  });
  it("appends the first evidence location", () => {
    const evidence = [
      { file: "a/index.ts", line: 34, text: "x" },
      { file: "a/other.ts", line: 2, text: "y" },
    ];
    expect(edgeTitle(edge("a", "b", { evidence }))).toBe("a → b: launch (a/index.ts:34)");
  });
});

describe("agentFolder", () => {
  it("is the root for path '.' or an empty path", () => {
    expect(agentFolder(mapOf(), agent("a", { path: "." }))).toBe("/work/proj");
    expect(agentFolder(mapOf(), agent("a", { path: "" }))).toBe("/work/proj");
  });
  it("joins nested POSIX paths and tolerates a trailing slash on the root", () => {
    expect(agentFolder(mapOf(), agent("a", { path: "agents/leasing" }))).toBe(
      "/work/proj/agents/leasing",
    );
    expect(agentFolder(mapOf({ root: "/work/proj/" }), agent("a", { path: "a" }))).toBe(
      "/work/proj/a",
    );
  });
  it("uses backslashes under a Windows root", () => {
    const map = mapOf({ root: "C:\\work\\proj" });
    expect(agentFolder(map, agent("a", { path: "agents/leasing" }))).toBe(
      "C:\\work\\proj\\agents\\leasing",
    );
    expect(agentFolder(map, agent("a", { path: "." }))).toBe("C:\\work\\proj");
  });
  it("is null with no root", () => {
    expect(agentFolder(mapOf({ root: null }), agent("a"))).toBeNull();
  });
});

describe("workflowForAgent", () => {
  const workflows = [{ path: "/work/proj/leasing" }, { path: "C:\\Work\\Proj\\screening" }];
  it("matches across a trailing slash", () => {
    expect(
      workflowForAgent(mapOf(), agent("leasing"), [{ path: "/work/proj/leasing/" }]),
    ).toEqual({ path: "/work/proj/leasing/" });
  });
  it("matches Windows paths across case and separator form", () => {
    const map = mapOf({ root: "c:/work/proj" });
    expect(workflowForAgent(map, agent("screening"), workflows)).toBe(workflows[1]);
  });
  it("keeps POSIX paths case-sensitive", () => {
    expect(workflowForAgent(mapOf(), agent("Leasing", { path: "Leasing" }), workflows)).toBeNull();
  });
  it("is null with no match or no root", () => {
    expect(workflowForAgent(mapOf(), agent("nope"), workflows)).toBeNull();
    expect(workflowForAgent(mapOf({ root: null }), agent("leasing"), workflows)).toBeNull();
  });
});

describe("deploymentLabel", () => {
  it("maps the three deploy states", () => {
    expect(deploymentLabel(agent("a", { deployed: true }))).toBe("Deployed");
    expect(deploymentLabel(agent("a", { deployed: false }))).toBe("Draft");
    expect(deploymentLabel(agent("a", { deployed: null }))).toBeNull();
  });
});

describe("chipLabel", () => {
  it("drops the resource kind prefix", () => {
    expect(chipLabel("vault:SLACK_TOKEN")).toBe("SLACK_TOKEN");
    expect(chipLabel("connector:slack:bot")).toBe("slack:bot");
  });
  it("leaves a chip with no prefix alone", () => {
    expect(chipLabel("SLACK_TOKEN")).toBe("SLACK_TOKEN");
    expect(chipLabel(":odd")).toBe(":odd");
  });
});

describe("mapStructureKey", () => {
  const base = (): AgentMap =>
    mapOf({
      systems: [{ id: "s1", name: "one", nameSource: "default", agents: ["a", "b"] }],
      agents: [agent("a"), agent("b"), agent("c")],
      edges: [edge("a", "b"), edge("b", "a", { kind: "event", eventType: "x" })],
    });
  const key = mapStructureKey(base());

  it("is unchanged by descriptions, deploy state, ref changes and evidence", () => {
    const map = base();
    map.agents = map.agents.map((a) => ({
      ...a,
      description: "new",
      deployed: true,
      changedSinceRef: true,
    }));
    map.edges = map.edges.map((e) => ({
      ...e,
      evidence: [{ file: "x.ts", line: 1, text: "t" }],
      fromStep: "s",
    }));
    map.systems[0]!.name = "renamed";
    expect(mapStructureKey(map)).toBe(key);
  });

  it("is unchanged when arrays are reordered", () => {
    const map = base();
    map.agents.reverse();
    map.edges.reverse();
    map.systems[0]!.agents.reverse();
    expect(mapStructureKey(map)).toBe(key);
  });

  it("changes when an agent is added or removed", () => {
    const added = base();
    added.agents.push(agent("d"));
    expect(mapStructureKey(added)).not.toBe(key);
    const removed = base();
    removed.agents.pop();
    expect(mapStructureKey(removed)).not.toBe(key);
  });

  it("changes when an edge changes", () => {
    const added = base();
    added.edges.push(edge("a", "c"));
    expect(mapStructureKey(added)).not.toBe(key);
    const kind = base();
    kind.edges[0] = edge("a", "b", { kind: "signal" });
    expect(mapStructureKey(kind)).not.toBe(key);
    const removed = base();
    removed.edges.pop();
    expect(mapStructureKey(removed)).not.toBe(key);
  });

  it("changes when a system's membership changes", () => {
    const joined = base();
    joined.systems[0]!.agents.push("c");
    expect(mapStructureKey(joined)).not.toBe(key);
    const left = base();
    left.systems[0]!.agents = ["a"];
    expect(mapStructureKey(left)).not.toBe(key);
  });

  it("changes when a node gains or loses its chip row", () => {
    const chip = base();
    chip.agents[2]!.shared = ["vault:K"];
    expect(mapStructureKey(chip)).not.toBe(key);
    const other = base();
    other.agents[2]!.shared = ["vault:K", "db:x"];
    expect(mapStructureKey(other)).toBe(mapStructureKey(chip));
  });
});

describe("foldChips", () => {
  it("shows every chip that fits on one line", () => {
    expect(foldChips(["vault:A", "db:b"], 160)).toEqual({ shown: ["vault:A", "db:b"], folded: [] });
  });

  it("folds the chips past the line into +N, keeping room for it", () => {
    const chips = ["db:support-desk", "connector:slack", "vault:PAGER_KEY"];
    const { shown, folded } = foldChips(chips, 160);
    expect(shown).toEqual(["db:support-desk"]);
    expect(folded).toEqual(["connector:slack", "vault:PAGER_KEY"]);
  });

  it("always shows the first chip, even one too long for the line", () => {
    expect(foldChips(["db:daily-activity-analyst-store", "vault:KEY"], 160)).toEqual({
      shown: ["db:daily-activity-analyst-store"],
      folded: ["vault:KEY"],
    });
  });
});

describe("chipKind", () => {
  it("names the resource from the map tool's prefix", () => {
    expect(chipKind("db:handle")).toBe("database");
    expect(chipKind("connector:slack")).toBe("connector");
    expect(chipKind("vault:KEY")).toBe("vault");
    expect(chipKind("bare")).toBeNull();
  });
});

describe("display names", () => {
  it("names an agent by its folder, falling back to its slug", () => {
    expect(agentDisplayName({ slug: "support-desk-intake", path: "agents/intake" })).toBe("intake");
    expect(agentDisplayName({ slug: "solo", path: "" })).toBe("solo");
  });
  it("names a default system after its hub agent's shown name, and keeps a name from map.json", () => {
    const names = displayNames([{ slug: "support-desk-controller", path: "agents/controller" }]);
    expect(systemDisplayName({ name: "support-desk-controller", nameSource: "default" }, names)).toBe("controller");
    expect(systemDisplayName({ name: "Support desk", nameSource: "file" }, names)).toBe("Support desk");
  });
  it("keeps full slugs for agents whose folders share a name", () => {
    const names = displayNames([
      { slug: "a-worker", path: "a/worker" },
      { slug: "b-worker", path: "b/worker" },
      { slug: "solo", path: "solo" },
    ]);
    expect([...names.values()]).toEqual(["a-worker", "b-worker", "solo"]);
  });
});

describe("drawnRef", () => {
  it("is null for the working copy, whether the tool says \"working\" or leaves ref out", () => {
    expect(drawnRef({ ref: "working" })).toBeNull();
    expect(drawnRef({})).toBeNull();
    expect(drawnRef({ ref: "HEAD" })).toBe("HEAD");
    expect(drawnRef({ ref: "feature/x" })).toBe("feature/x");
  });
});

