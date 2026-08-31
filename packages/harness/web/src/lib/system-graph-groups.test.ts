import { describe, expect, it } from "vitest";
import type { AgentKey, SystemGraphNode } from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

import {
  EMPTY_RAIL_STATE,
  deriveOrStored,
  materialize,
  parseRailState,
  type LaunchEdge,
  type RailState,
} from "./agent-groups";
import { systemGraphNodeGroups } from "./system-graph-groups";

const ROOT = "/repo";

const agent = (name: string): WorkflowInfo => ({
  name,
  path: `${ROOT}/${name}`,
  definitionId: null,
  definitionSlug: name,
  activeBuildRunId: null,
  activeBuildRunStatus: null,
  source: "scan",
});

const node = (name: string): SystemGraphNode => ({
  id: `agent:${name}`,
  agentKey: name,
  label: name,
});

/** The server-owned navigation join: agent key to workflow path. */
const navigationFor = (
  workflows: readonly WorkflowInfo[],
): ReadonlyMap<AgentKey, string> =>
  new Map(workflows.map((workflow) => [workflow.name, workflow.path]));

/** gateway launches queue and worker; mailer launches sender; loner nothing. */
const WORKFLOWS = [
  agent("gateway"),
  agent("queue"),
  agent("worker"),
  agent("mailer"),
  agent("sender"),
  agent("loner"),
];
const NODES = WORKFLOWS.map((workflow) => node(workflow.name));
const EDGES: LaunchEdge[] = [
  { parent: "gateway", child: "queue" },
  { parent: "gateway", child: "worker" },
  { parent: "mailer", child: "sender" },
];

/** What the RAIL renders for a state — the map is handed exactly this. */
const railRows = (state: RailState) =>
  deriveOrStored(WORKFLOWS, state, EDGES, "name");

const containers = (state: RailState) =>
  systemGraphNodeGroups(NODES, railRows(state), navigationFor(WORKFLOWS));

const shape = (state: RailState) =>
  containers(state).map((container) => [container.label, container.nodeIds]);

describe("systemGraphNodeGroups", () => {
  it("draws one container per rail row, in the rail's order, labelled identically", () => {
    // The whole ticket in one assertion: the sub-structure the rail shows is
    // the sub-structure the map draws. Two names for one group is the failure.
    expect(shape(EMPTY_RAIL_STATE)).toEqual([
      ["gateway", ["agent:gateway", "agent:queue", "agent:worker"]],
      ["mailer", ["agent:mailer", "agent:sender"]],
      ["Ungrouped", ["agent:loner"]],
    ]);
    expect(containers(EMPTY_RAIL_STATE).map((c) => c.label)).toEqual(
      railRows(EMPTY_RAIL_STATE).map((row) => row.label),
    );
  });

  it("keeps `groups: null` and `groups: []` different answers", () => {
    /* THE REGRESSION THIS PROJECT KEEPS HAVING. `null` is "nothing stored,
       detection owns this"; `[]` is "the user materialized groups and then
       deleted every one". Collapsing them dumped every agent into Ungrouped,
       permanently, in a reference prototype — and the map is a NEW read path
       for the same file, so the distinction has to survive this module too.

       Fails if the map ever reaches past `deriveOrStored` for its own opinion
       of the edges: an implementation that re-derived from launch edges would
       return the detected containers for BOTH states. */
    const nothingStored = parseRailState(
      JSON.stringify({ version: 1, groups: null, renames: {} }),
    );
    const allDeleted = parseRailState(
      JSON.stringify({ version: 1, groups: [], renames: {} }),
    );
    expect(nothingStored.groups).toBeNull();
    expect(allDeleted.groups).toEqual([]);

    expect(shape(nothingStored)).toEqual(shape(EMPTY_RAIL_STATE));
    expect(shape(allDeleted)).toEqual([
      [
        "Ungrouped",
        // Name order: the rail sorts an Ungrouped bucket, and the map carries
        // its rows through untouched.
        [
          "agent:gateway",
          "agent:loner",
          "agent:mailer",
          "agent:queue",
          "agent:sender",
          "agent:worker",
        ],
      ],
    ]);
    expect(shape(allDeleted)).not.toEqual(shape(nothingStored));
  });

  it("follows the user's edited groups rather than re-detecting", () => {
    // Derived until touched: once materialized and renamed, the map must say
    // what the rail says, not what a fresh scan would.
    const edited = materialize(EMPTY_RAIL_STATE, WORKFLOWS, EDGES, "name");
    const renamed: RailState = {
      ...edited,
      groups: edited.groups.map((group) =>
        group.label === "gateway" ? { ...group, label: "Ingest" } : group,
      ),
    };
    expect(shape(renamed)).toEqual([
      ["Ingest", ["agent:gateway", "agent:queue", "agent:worker"]],
      ["mailer", ["agent:mailer", "agent:sender"]],
      ["Ungrouped", ["agent:loner"]],
    ]);
  });

  it("draws a shared agent once, under the first group that names it", () => {
    // Group membership is many-to-many by design — a shared subagent belongs to
    // every system that calls it — and the rail prints it in each. A map has
    // one card per agent, so a second mention must not draw a second card in a
    // second container.
    const shared: RailState = {
      version: 1,
      renames: {},
      groups: [
        { id: "g_one", label: "One", members: [`${ROOT}/gateway`, `${ROOT}/queue`] },
        { id: "g_two", label: "Two", members: [`${ROOT}/queue`, `${ROOT}/worker`] },
      ],
    };
    const drawn = containers(shared);
    expect(drawn.map((c) => [c.label, c.nodeIds])).toEqual([
      ["One", ["agent:gateway", "agent:queue"]],
      ["Two", ["agent:worker"]],
      ["Ungrouped", ["agent:loner", "agent:mailer", "agent:sender"]],
    ]);
    expect(drawn.flatMap((c) => c.nodeIds)).toHaveLength(NODES.length);
  });

  it("drops a container whose members this graph has none of", () => {
    // Chrome around nothing: a group naming only agents the projection did not
    // produce would draw an empty labelled box.
    const stale: RailState = {
      version: 1,
      renames: {},
      groups: [{ id: "g_gone", label: "Gone", members: [`${ROOT}/deleted`] }],
    };
    expect(containers(stale).map((c) => c.label)).toEqual(["Ungrouped"]);
  });

  it("files a node no row resolved into Ungrouped rather than losing it", () => {
    /* A graph node missing from the navigation sidecar cannot be joined to a
       rail row. Its CARD still exists, and a card outside every container is a
       card the layout has nowhere to put. */
    const ambiguous = navigationFor(
      WORKFLOWS.filter((workflow) => workflow.name !== "sender"),
    );
    const drawn = systemGraphNodeGroups(
      NODES,
      railRows(EMPTY_RAIL_STATE),
      ambiguous,
    );
    expect(drawn.map((c) => [c.label, c.nodeIds])).toEqual([
      ["gateway", ["agent:gateway", "agent:queue", "agent:worker"]],
      ["mailer", ["agent:mailer"]],
      ["Ungrouped", ["agent:loner", "agent:sender"]],
    ]);
    expect(drawn.flatMap((c) => c.nodeIds).sort()).toEqual(
      NODES.map((n) => n.id).sort(),
    );
  });

  it("covers every node exactly once for every arrangement", () => {
    // The layout is handed this as a partition. A node claimed twice draws two
    // cards; a node claimed by nobody vanishes from the map.
    for (const state of [
      EMPTY_RAIL_STATE,
      materialize(EMPTY_RAIL_STATE, WORKFLOWS, EDGES, "name"),
      { version: 1 as const, groups: [], renames: {} },
    ]) {
      const claimed = containers(state).flatMap((c) => c.nodeIds);
      expect([...claimed].sort()).toEqual(NODES.map((n) => n.id).sort());
    }
  });

  it("renders a single-group project as that group, not as an extra frame", () => {
    const onlyOne: RailState = {
      version: 1,
      renames: {},
      groups: [
        {
          id: "g_all",
          label: "Everything",
          members: WORKFLOWS.map((workflow) => workflow.path),
        },
      ],
    };
    const drawn = containers(onlyOne);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.label).toBe("Everything");
    expect(drawn[0]!.nodeIds).toHaveLength(NODES.length);
  });

  it("does not mistake a group the user NAMED `Ungrouped` for the bucket", () => {
    /* `renameGroup` only trims — nothing stops a user calling a real system
       `Ungrouped`. Recognising the bucket by its LABEL would then file every
       card that failed the navigation join inside that system, and move it to
       the end of the map, breaking the rail order this feature is about.
       `isUngrouped` is carried from the rail instead. */
    const collision: RailState = {
      version: 1,
      renames: {},
      groups: [
        {
          id: "g_named",
          label: "Ungrouped",
          members: [`${ROOT}/gateway`, `${ROOT}/queue`],
        },
        { id: "g_second", label: "Second", members: [`${ROOT}/worker`] },
      ],
    };
    const rows = railRows(collision);
    // The rail itself draws two rows called `Ungrouped`: the user's, and the
    // real bucket. That is the shape the map has to survive.
    expect(rows.map((row) => [row.label, row.isUngrouped])).toEqual([
      ["Ungrouped", false],
      ["Second", false],
      ["Ungrouped", true],
    ]);

    const drawn = systemGraphNodeGroups(
      NODES,
      rows,
      // `sender` drops out of the navigation join, so its card is unclaimed.
      navigationFor(WORKFLOWS.filter((workflow) => workflow.name !== "sender")),
    );
    expect(drawn.map((c) => [c.label, c.isUngrouped, c.nodeIds])).toEqual([
      ["Ungrouped", false, ["agent:gateway", "agent:queue"]],
      ["Second", false, ["agent:worker"]],
      [
        "Ungrouped",
        true,
        ["agent:loner", "agent:mailer", "agent:sender"],
      ],
    ]);
    // The user's group keeps its position and its exact membership.
    expect(drawn[0]!.nodeIds).not.toContain("agent:sender");
  });
});
