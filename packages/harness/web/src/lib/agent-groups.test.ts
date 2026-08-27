import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import {
  addMember,
  applyGroupDrop,
  buildGroupTree,
  canResetToDetected,
  copyMemberToGroup,
  createGroup,
  deleteGroup,
  deriveOrStored,
  EMPTY_RAIL_STATE,
  isMaterialized,
  materialize,
  parseRailState,
  pruneRailState,
  railStateWrite,
  readRailState,
  removeFromAllGroups,
  removeMember,
  renameGroup,
  resetToDetected,
  serializeRailState,
  ungroupedAgents,
  UNGROUPED_ID,
  type LaunchEdge,
  type MaterializedRailState,
  type RailState,
} from "./agent-groups";

const ROOT = "/Users/dev/polsia";

const agent = (name: string, path = `${ROOT}/${name}`): WorkflowInfo => ({
  name,
  path,
  definitionId: null,
  definitionSlug: name,
  source: "scan",
});

/** `trend-loop` launches `scraper` and `post-to-tiktok`; `mailer` launches
 *  nothing and nothing launches it. */
const TREND: LaunchEdge[] = [
  { parent: "trend-loop", child: "scraper" },
  { parent: "trend-loop", child: "post-to-tiktok" },
];
const WORKFLOWS = [
  agent("trend-loop"),
  agent("scraper"),
  agent("post-to-tiktok"),
  agent("mailer"),
];

const pathOf = (name: string): string => `${ROOT}/${name}`;
const names = (paths: readonly string[]): string[] => paths.map((p) => p.split("/").pop() ?? p);

/** The state the rail is in the moment before a user's first edit. */
const materialized = (
  workflows: WorkflowInfo[] = WORKFLOWS,
  edges: LaunchEdge[] = TREND,
): MaterializedRailState => materialize(EMPTY_RAIL_STATE, workflows, edges, "name");

describe("buildGroupTree", () => {
  it("files a launch-connected component as ONE group named for its head (criterion 8)", () => {
    const groups = buildGroupTree(WORKFLOWS, TREND, "name");

    expect(groups.map((group) => group.label)).toEqual(["trend-loop", "Ungrouped"]);
    expect(groups[0].agents.map((a) => a.workflow.name)).toEqual([
      "post-to-tiktok",
      "scraper",
      "trend-loop",
    ]);
    // Unreached agents land in a LAST Ungrouped section, named.
    const last = groups[groups.length - 1];
    expect(last.isUngrouped).toBe(true);
    expect(last.id).toBe(UNGROUPED_ID);
    expect(last.agents.map((a) => a.workflow.name)).toEqual(["mailer"]);
  });

  it("forms NO group from an edge to an agent this install lacks (criterion 9)", () => {
    // `scraper` is here; `trend-loop`, the other end of its edge, is not. That
    // is not a group of one plus a ghost — it is not an edge you can draw.
    const groups = buildGroupTree([agent("scraper")], TREND, "name");
    expect(groups.map((group) => group.label)).toEqual(["Ungrouped"]);
    expect(groups[0].agents.map((a) => a.workflow.name)).toEqual(["scraper"]);
  });

  it("keeps an agent whose only edge points at a missing agent out of every group", () => {
    const workflows = [...WORKFLOWS, agent("outreach")];
    const edges = [...TREND, { parent: "outreach", child: "ghost-agent" }];
    const groups = buildGroupTree(workflows, edges, "name");

    expect(groups.map((group) => group.label)).toEqual(["trend-loop", "Ungrouped"]);
    expect(groups[1].agents.map((a) => a.workflow.name)).toEqual(["mailer", "outreach"]);
  });

  it("names a multi-level component for the agent nothing else launches", () => {
    const workflows = [agent("gateway"), agent("queue"), agent("worker")];
    const edges: LaunchEdge[] = [
      { parent: "queue", child: "worker" },
      { parent: "gateway", child: "queue" },
    ];
    const [group] = buildGroupTree(workflows, edges, "name");
    expect(group.label).toBe("gateway");
    expect(group.agents).toHaveLength(3);
  });

  it("still names a cycle, alphabetically, rather than leaving the group unnamed", () => {
    const workflows = [agent("beta"), agent("alpha")];
    const edges: LaunchEdge[] = [
      { parent: "alpha", child: "beta" },
      { parent: "beta", child: "alpha" },
    ];
    expect(buildGroupTree(workflows, edges, "name")[0].label).toBe("alpha");
  });

  it("matches a launch slug by definitionSlug as well as by folder name", () => {
    // A launch call names the DEPLOYED definition, which need not equal the
    // folder the project sits in.
    const workflows = [
      agent("trend-loop"),
      { ...agent("tiktok-poster"), definitionSlug: "post-to-tiktok" },
    ];
    const [group] = buildGroupTree(workflows, TREND, "name");
    expect(group.label).toBe("trend-loop");
    expect(group.agents.map((a) => a.workflow.name)).toEqual(["tiktok-poster", "trend-loop"]);
  });

  it("unions by PATH, so two agents sharing a name stay two agents", () => {
    // `ads` exists twice in the deep fixture. Unioning by name would merge two
    // unrelated systems into one group.
    const here = agent("ads", `${ROOT}/backend/ads`);
    const there = agent("ads", `${ROOT}/services/ads`);
    const groups = buildGroupTree([agent("gateway"), here, there], [{ parent: "gateway", child: "ads" }], "name");
    expect(groups.map((group) => group.label)).toEqual(["gateway", "Ungrouped"]);
    // The first spelling wins the name lookup; the other `ads` is untouched.
    expect(groups[0].agents.map((a) => a.workflow.path)).toEqual([here.path, pathOf("gateway")]);
    expect(groups[1].agents.map((a) => a.workflow.path)).toEqual([there.path]);
  });

  it("does not make a group out of one agent", () => {
    // One agent alone is not a relationship, and a rail of one-member groups
    // says nothing the Project axis did not already say.
    expect(buildGroupTree([agent("mailer")], [], "name").map((g) => g.isUngrouped)).toEqual([true]);
  });

  it("ignores a self-launch and a duplicate edge", () => {
    const edges: LaunchEdge[] = [
      { parent: "mailer", child: "mailer" },
      { parent: "trend-loop", child: "scraper" },
      { parent: "trend-loop", child: "scraper" },
    ];
    const groups = buildGroupTree(WORKFLOWS, edges, "name");
    expect(groups.map((group) => group.label)).toEqual(["trend-loop", "Ungrouped"]);
    expect(groups[0].agents).toHaveLength(2);
  });

  it("orders derived groups biggest-first, then by label, with Ungrouped last", () => {
    const workflows = [
      ...WORKFLOWS,
      agent("alpha-head"),
      agent("alpha-tail"),
      agent("zulu-head"),
      agent("zulu-tail"),
    ];
    const edges = [
      ...TREND,
      { parent: "zulu-head", child: "zulu-tail" },
      { parent: "alpha-head", child: "alpha-tail" },
    ];
    expect(buildGroupTree(workflows, edges, "name").map((group) => group.label)).toEqual([
      "trend-loop",
      "alpha-head",
      "zulu-head",
      "Ungrouped",
    ]);
  });

  it("gives group rows NO directory prefix — the axis is not about paths", () => {
    const [group] = buildGroupTree(WORKFLOWS, TREND, "name");
    expect(group.agents.every((a) => a.prefix === "" && a.prefixFull === "")).toBe(true);
  });

  it("renders nothing at all for no agents", () => {
    expect(buildGroupTree([], TREND, "name")).toEqual([]);
  });
});

describe("derive vs stored", () => {
  it("shows the derived groups while nothing is stored", () => {
    expect(deriveOrStored(WORKFLOWS, EMPTY_RAIL_STATE, TREND, "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("lets stored groups win once they exist", () => {
    const state = createGroup(materialized(), "hand made", [pathOf("mailer")]);
    const groups = deriveOrStored(WORKFLOWS, state, TREND, "name");

    expect(groups.map((g) => g.label)).toEqual(["trend-loop", "hand made"]);
    // `mailer` was the derived Ungrouped bucket's only member; now grouped, the
    // bucket is gone rather than rendered empty.
    expect(groups.some((g) => g.isUngrouped)).toBe(false);
  });

  it("keeps the user's group order, and Ungrouped last", () => {
    let state = materialized();
    state = createGroup(state, "zebra");
    state = createGroup(state, "apple");
    const groups = deriveOrStored(WORKFLOWS, state, TREND, "name");

    expect(groups.map((g) => g.label)).toEqual(["trend-loop", "zebra", "apple", "Ungrouped"]);
    expect(groups[groups.length - 1].id).toBe(UNGROUPED_ID);
  });

  it("skips member paths with no agent when rendering unpruned state", () => {
    const state: RailState = {
      version: 1,
      groups: [{ id: "g_x", label: "x", members: [pathOf("mailer"), pathOf("ghost")] }],
      renames: {},
    };
    const [group] = deriveOrStored(WORKFLOWS, state, TREND, "name");
    expect(group.agents.map((a) => a.workflow.name)).toEqual(["mailer"]);
  });
});

describe("materialize", () => {
  it("freezes the derived set so a later scan cannot overwrite an edit", () => {
    const state = materialized();
    expect(isMaterialized(state)).toBe(true);
    expect(state.groups.map((g) => g.label)).toEqual(["trend-loop"]);
    expect(names(state.groups[0].members)).toEqual(["post-to-tiktok", "scraper", "trend-loop"]);

    // The edge that seeded the group disappears; the group does not.
    expect(deriveOrStored(WORKFLOWS, state, [], "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("does not store Ungrouped — it is the absence of membership", () => {
    expect(materialized().groups.some((g) => g.id === UNGROUPED_ID)).toBe(false);
  });

  it("is idempotent, so every operation can front it", () => {
    const once = materialized();
    expect(materialize(once, WORKFLOWS, TREND, "name")).toBe(once);
  });

  it("preserves renames it does not interpret", () => {
    const state: RailState = { version: 1, groups: null, renames: { [pathOf("mailer")]: "Mail" } };
    expect(materialize(state, WORKFLOWS, TREND, "name").renames).toEqual({
      [pathOf("mailer")]: "Mail",
    });
  });
});

describe("membership operations", () => {
  it("puts one agent in TWO groups (criterion 10)", () => {
    let state = materialized();
    state = createGroup(state, "shared");
    const shared = state.groups[state.groups.length - 1].id;
    state = addMember(state, shared, pathOf("post-to-tiktok"));

    const holders = state.groups.filter((g) => g.members.includes(pathOf("post-to-tiktok")));
    expect(holders.map((g) => g.label)).toEqual(["trend-loop", "shared"]);
    // In two groups is not the same as ungrouped.
    expect(ungroupedAgents(WORKFLOWS, state.groups).map((w) => w.name)).toEqual(["mailer"]);
  });

  it("treats adding the same agent to one group twice as a NO-OP (criterion 10)", () => {
    const state = materialized();
    const trend = state.groups[0].id;
    const once = addMember(state, trend, pathOf("mailer"));
    const twice = addMember(once, trend, pathOf("mailer"));

    expect(twice.groups[0].members.filter((m) => m === pathOf("mailer"))).toHaveLength(1);
    expect(names(twice.groups[0].members)).toEqual(names(once.groups[0].members));
    // And it RENDERS once, not twice: two identical rows in one group are
    // unresolvable by looking at them.
    const [group] = deriveOrStored(WORKFLOWS, twice, TREND, "name");
    expect(group.agents.map((a) => a.workflow.name)).toEqual([
      "mailer",
      "post-to-tiktok",
      "scraper",
      "trend-loop",
    ]);
  });

  it("ignores an add or remove aimed at a group that is not there", () => {
    const state = materialized();
    expect(addMember(state, "g_nope", pathOf("mailer")).groups).toEqual(state.groups);
    expect(removeMember(state, "g_nope", pathOf("scraper")).groups).toEqual(state.groups);
  });

  it("removes a member from one group only", () => {
    let state = materialized();
    state = createGroup(state, "shared", [pathOf("scraper")]);
    const shared = state.groups[1].id;
    state = removeMember(state, shared, pathOf("scraper"));

    expect(state.groups[1].members).toEqual([]);
    expect(state.groups[0].members).toContain(pathOf("scraper"));
  });

  it("copies a member into another group, keeping the original", () => {
    let state = materialized();
    state = createGroup(state, "tiktok things");
    const target = state.groups[1].id;
    const source = state.groups[0].id;
    state = copyMemberToGroup(state, source, target, pathOf("post-to-tiktok"));

    expect(state.groups[0].members).toContain(pathOf("post-to-tiktok"));
    expect(state.groups[1].members).toEqual([pathOf("post-to-tiktok")]);
  });

  it("refuses a copy whose source no longer holds the agent", () => {
    let state = materialized();
    state = createGroup(state, "target");
    const source = state.groups[0].id;
    const target = state.groups[1].id;
    state = removeMember(state, source, pathOf("scraper"));

    expect(copyMemberToGroup(state, source, target, pathOf("scraper")).groups[1].members).toEqual([]);
    expect(copyMemberToGroup(state, "g_nope", target, pathOf("scraper")).groups[1].members).toEqual(
      [],
    );
  });

  it("makes a copy into the source group the same no-op as adding twice", () => {
    const state = materialized();
    const trend = state.groups[0].id;
    expect(copyMemberToGroup(state, trend, trend, pathOf("scraper")).groups[0].members).toEqual(
      state.groups[0].members,
    );
  });

  it("takes an agent out of EVERY group at once", () => {
    let state = materialized();
    state = createGroup(state, "also here", [pathOf("scraper")]);
    state = removeFromAllGroups(state, pathOf("scraper"));
    expect(state.groups.flatMap((g) => g.members)).not.toContain(pathOf("scraper"));
  });
});

describe("applyGroupDrop", () => {
  /** trend-loop{post-to-tiktok, scraper, trend-loop} + shared{} */
  const withTarget = (): { state: MaterializedRailState; trend: string; shared: string } => {
    const state = createGroup(materialized(), "shared");
    return { state, trend: state.groups[0].id, shared: state.groups[1].id };
  };

  it("MOVES on a plain drag: joins the target, leaves the source", () => {
    const { state, trend, shared } = withTarget();
    const next = applyGroupDrop(state, {
      path: pathOf("scraper"),
      fromGroupId: trend,
      toGroupId: shared,
      copy: false,
    });
    expect(next.groups[0].members).not.toContain(pathOf("scraper"));
    expect(next.groups[1].members).toEqual([pathOf("scraper")]);
  });

  it("COPIES on Option-drag: the shared-subagent case, in both groups", () => {
    const { state, trend, shared } = withTarget();
    const next = applyGroupDrop(state, {
      path: pathOf("post-to-tiktok"),
      fromGroupId: trend,
      toGroupId: shared,
      copy: true,
    });
    expect(next.groups[0].members).toContain(pathOf("post-to-tiktok"));
    expect(next.groups[1].members).toEqual([pathOf("post-to-tiktok")]);
  });

  it("leaves EVERY group on a drop onto Ungrouped", () => {
    let { state, trend, shared } = withTarget();
    state = addMember(state, shared, pathOf("scraper"));
    const next = applyGroupDrop(state, {
      path: pathOf("scraper"),
      fromGroupId: trend,
      toGroupId: UNGROUPED_ID,
      copy: false,
    });
    expect(next.groups.flatMap((g) => g.members)).not.toContain(pathOf("scraper"));
    expect(ungroupedAgents(WORKFLOWS, next.groups).map((w) => w.name)).toContain("scraper");
  });

  it("changes nothing when the agent is dropped where it already is", () => {
    const { state, trend } = withTarget();
    expect(
      applyGroupDrop(state, {
        path: pathOf("scraper"),
        fromGroupId: trend,
        toGroupId: trend,
        copy: false,
      }),
    ).toBe(state);
    expect(
      applyGroupDrop(state, {
        path: pathOf("mailer"),
        fromGroupId: UNGROUPED_ID,
        toGroupId: UNGROUPED_ID,
        copy: false,
      }),
    ).toBe(state);
  });

  it("joins without leaving when the drag started in Ungrouped", () => {
    const { state, shared } = withTarget();
    const next = applyGroupDrop(state, {
      path: pathOf("mailer"),
      fromGroupId: UNGROUPED_ID,
      toGroupId: shared,
      copy: false,
    });
    expect(next.groups[1].members).toEqual([pathOf("mailer")]);
  });

  it("ignores a drop carrying no agent path", () => {
    // A payload read from component state instead of `dataTransfer` arrives
    // blank exactly when the drop needs it; the model must not act on that.
    const { state, trend, shared } = withTarget();
    expect(
      applyGroupDrop(state, { path: "", fromGroupId: trend, toGroupId: shared, copy: false }),
    ).toBe(state);
  });

  it("moves NOTHING on disk: every agent's path is untouched by every drop", () => {
    const { state, trend, shared } = withTarget();
    const before = WORKFLOWS.map((w) => w.path);
    for (const copy of [false, true]) {
      for (const toGroupId of [shared, UNGROUPED_ID]) {
        const next = applyGroupDrop(state, {
          path: pathOf("scraper"),
          fromGroupId: trend,
          toGroupId,
          copy,
        });
        // A group is a label OVER agents: the only paths in play are the ones
        // already on disk, and no operation invents or rewrites one.
        for (const member of next.groups.flatMap((g) => g.members)) {
          expect(before).toContain(member);
        }
      }
    }
    expect(WORKFLOWS.map((w) => w.path)).toEqual(before);
  });
});

describe("group lifecycle", () => {
  it("creates, renames and deletes without touching the other groups", () => {
    let state = createGroup(materialized(), "ads");
    expect(state.groups.map((g) => g.label)).toEqual(["trend-loop", "ads"]);

    const id = state.groups[1].id;
    state = renameGroup(state, id, "  paid ads  ");
    expect(state.groups[1].label).toBe("paid ads");
    expect(state.groups[1].id).toBe(id);

    state = deleteGroup(state, id);
    expect(state.groups.map((g) => g.label)).toEqual(["trend-loop"]);
  });

  it("discards an empty or whitespace-only name", () => {
    const state = materialized();
    expect(createGroup(state, "   ")).toBe(state);
    expect(createGroup(state, "")).toBe(state);
    expect(renameGroup(state, state.groups[0].id, "  ").groups[0].label).toBe("trend-loop");
  });

  it("drops a deleted group's members to Ungrouped unless another group has them", () => {
    let state = materialized();
    state = createGroup(state, "keepers", [pathOf("scraper")]);
    state = deleteGroup(state, state.groups[0].id);

    const groups = deriveOrStored(WORKFLOWS, state, TREND, "name");
    expect(groups.map((g) => g.label)).toEqual(["keepers", "Ungrouped"]);
    expect(groups[1].agents.map((a) => a.workflow.name)).toEqual([
      "mailer",
      "post-to-tiktok",
      "trend-loop",
    ]);
  });

  it("keeps deleting the last group meaning NO groups, not derive again", () => {
    const state = deleteGroup(materialized(), materialized().groups[0].id);
    expect(state.groups).toEqual([]);
    expect(deriveOrStored(WORKFLOWS, state, TREND, "name").map((g) => g.label)).toEqual([
      "Ungrouped",
    ]);
  });

  it("gives colliding labels distinct ids", () => {
    let state = materialized();
    state = createGroup(state, "ads");
    state = createGroup(state, "Ads!");
    expect(state.groups.slice(1).map((g) => g.id)).toEqual(["g_ads", "g_ads-2"]);
  });

  it("dedupes members handed to createGroup", () => {
    const state = createGroup(materialized(), "dupes", [pathOf("mailer"), pathOf("mailer")]);
    expect(state.groups[1].members).toEqual([pathOf("mailer")]);
  });

  it("never mutates the state it was given", () => {
    const state = materialized();
    const before = structuredClone(state);
    addMember(state, state.groups[0].id, pathOf("mailer"));
    removeMember(state, state.groups[0].id, pathOf("scraper"));
    removeFromAllGroups(state, pathOf("scraper"));
    renameGroup(state, state.groups[0].id, "other");
    deleteGroup(state, state.groups[0].id);
    createGroup(state, "more");
    applyGroupDrop(state, {
      path: pathOf("scraper"),
      fromGroupId: state.groups[0].id,
      toGroupId: UNGROUPED_ID,
      copy: false,
    });
    expect(state).toEqual(before);
  });
});

describe("resetToDetected", () => {
  it("hands a hand-made arrangement back to detection", () => {
    let state = materialized();
    state = createGroup(state, "mine", [pathOf("mailer")]);
    const reset = resetToDetected(state);

    expect(isMaterialized(reset)).toBe(false);
    expect(deriveOrStored(WORKFLOWS, reset, TREND, "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("rescues the stuck state: materialized, no groups, everything Ungrouped", () => {
    const stuck = deleteGroup(materialized(), materialized().groups[0].id);
    expect(deriveOrStored(WORKFLOWS, stuck, TREND, "name").map((g) => g.label)).toEqual([
      "Ungrouped",
    ]);

    const reset = resetToDetected(stuck);
    expect(deriveOrStored(WORKFLOWS, reset, TREND, "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("is a no-op on a state that is already derived", () => {
    expect(resetToDetected(EMPTY_RAIL_STATE)).toBe(EMPTY_RAIL_STATE);
    const parsed = parseRailState(null);
    expect(resetToDetected(parsed)).toBe(parsed);
  });

  it("keeps renames — they name agents, not groups", () => {
    const state = { ...materialized(), renames: { [pathOf("mailer")]: "Mail" } };
    expect(resetToDetected(state).renames).toEqual({ [pathOf("mailer")]: "Mail" });
  });

  it("ERASES the stored file instead of writing the stuck state back", () => {
    const reset = resetToDetected({ ...materialized(), renames: { [pathOf("mailer")]: "Mail" } });

    // Removing rather than skipping the write is what makes the reset persist:
    // skipping it would let the old arrangement outlive the reset.
    expect(railStateWrite(reset)).toEqual({ kind: "remove" });
    // And `groups: []` here would mean "the user deleted every group" and put
    // the rail straight back where the reset rescued it from.
    expect(JSON.parse(serializeRailState(reset)).groups).toBeNull();

    const reloaded = readRailState(null, WORKFLOWS);
    expect(isMaterialized(reloaded)).toBe(false);
    expect(deriveOrStored(WORKFLOWS, reloaded, TREND, "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("offers itself only where it would do something", () => {
    expect(canResetToDetected(EMPTY_RAIL_STATE)).toBe(false);
    // Offered with real groups too: being stuck with a bad arrangement is the
    // same trap, and nobody should have to delete their groups to escape it.
    expect(canResetToDetected(materialized())).toBe(true);
    expect(canResetToDetected(deleteGroup(materialized(), materialized().groups[0].id))).toBe(true);
  });
});

describe("persistence (criterion 11)", () => {
  it("survives a reload and moves nothing on disk", () => {
    let state = materialized();
    state = createGroup(state, "shared subagents", [pathOf("post-to-tiktok")]);
    state = removeMember(state, state.groups[0].id, pathOf("mailer"));

    const reloaded = readRailState(serializeRailState(state), WORKFLOWS);
    expect(reloaded).toEqual(state);
    // A group is a label over agents: every agent still sits where it did.
    expect(WORKFLOWS.map((w) => w.path)).toEqual([
      pathOf("trend-loop"),
      pathOf("scraper"),
      pathOf("post-to-tiktok"),
      pathOf("mailer"),
    ]);
    expect(deriveOrStored(WORKFLOWS, reloaded, TREND, "name").map((g) => g.label)).toEqual(
      deriveOrStored(WORKFLOWS, state, TREND, "name").map((g) => g.label),
    );
  });

  it("writes the documented file shape", () => {
    const state = createGroup(materialized(), "trend", [pathOf("mailer")]);
    const written = JSON.parse(serializeRailState({ ...state, renames: { a: "b" } }));
    expect(written.version).toBe(1);
    expect(written.renames).toEqual({ a: "b" });
    expect(written.groups[1]).toEqual({
      id: "g_trend",
      label: "trend",
      members: [pathOf("mailer")],
    });
  });

  it("reads an absent file as nothing stored", () => {
    expect(parseRailState(null)).toEqual(EMPTY_RAIL_STATE);
    expect(parseRailState(undefined)).toEqual(EMPTY_RAIL_STATE);
    expect(parseRailState("")).toEqual(EMPTY_RAIL_STATE);
    expect(isMaterialized(parseRailState(null))).toBe(false);
  });

  it("degrades malformed or unknown files to nothing stored instead of throwing", () => {
    for (const raw of [
      "{ not json",
      "[]",
      '"a string"',
      "null",
      "42",
      '{"version":2,"groups":[{"id":"g","label":"g","members":[]}]}',
      "{}",
      '{"version":1}',
      '{"version":1,"groups":"nope","renames":7}',
    ]) {
      expect(parseRailState(raw), raw).toEqual(EMPTY_RAIL_STATE);
    }
  });

  it("keeps an empty stored groups array DISTINCT from nothing stored", () => {
    const parsed = parseRailState('{"version":1,"groups":[],"renames":{}}');
    expect(parsed.groups).toEqual([]);
    expect(isMaterialized(parsed)).toBe(true);
    // …and it must NOT resurrect detection: the user deleted those groups.
    expect(deriveOrStored(WORKFLOWS, parsed, TREND, "name").map((g) => g.label)).toEqual([
      "Ungrouped",
    ]);
  });

  it("never serializes an un-materialized state as an empty array", () => {
    // THE regression this ticket is about. A persistence effect that ran on
    // mount wrote `groups: []` for a `groups: null` state, converting "detection
    // owns this" into "the user deleted everything" — and from the second load
    // onward every agent fell into Ungrouped, in every project, permanently.
    expect(railStateWrite(EMPTY_RAIL_STATE)).toEqual({ kind: "remove" });
    expect(railStateWrite(parseRailState(null))).toEqual({ kind: "remove" });
    expect(JSON.parse(serializeRailState(EMPTY_RAIL_STATE)).groups).toBeNull();

    // Round-tripping an un-materialized state as "no file" keeps it un-materialized.
    const reloaded = readRailState(null, WORKFLOWS);
    expect(isMaterialized(reloaded)).toBe(false);
    expect(deriveOrStored(WORKFLOWS, reloaded, TREND, "name").map((g) => g.label)).toEqual([
      "trend-loop",
      "Ungrouped",
    ]);
  });

  it("writes a materialized state, empty groups included", () => {
    const emptied = deleteGroup(materialized(), materialized().groups[0].id);
    const write = railStateWrite(emptied);
    expect(write.kind).toBe("write");
    expect(JSON.parse(write.kind === "write" ? write.raw : "{}").groups).toEqual([]);
  });

  it("salvages the readable groups in a partly-broken file", () => {
    const parsed = parseRailState(
      JSON.stringify({
        version: 1,
        groups: [
          "not a group",
          { label: "no id" },
          { id: "g_ok", label: "ok", members: [pathOf("mailer"), 7, pathOf("mailer")] },
          { id: "g_bare" },
        ],
        renames: { [pathOf("mailer")]: "Mail", [pathOf("scraper")]: 9 },
      }),
    );
    expect(parsed.groups).toEqual([
      { id: "g_ok", label: "ok", members: [pathOf("mailer")] },
      // A group with no label is still addressable, so it keeps its id as one
      // rather than becoming an unnamed row.
      { id: "g_bare", label: "g_bare", members: [] },
    ]);
    expect(parsed.renames).toEqual({ [pathOf("mailer")]: "Mail" });
  });

  it("drops member paths no known agent claims, silently", () => {
    const stored = serializeRailState({
      version: 1,
      groups: [
        { id: "g_x", label: "x", members: [pathOf("mailer"), `${ROOT}/moved/mailer`] },
        { id: "g_gone", label: "gone", members: [`${ROOT}/deleted`] },
      ],
      renames: { [`${ROOT}/deleted`]: "Gone" },
    });
    const state = readRailState(stored, WORKFLOWS);

    expect(state.groups?.[0].members).toEqual([pathOf("mailer")]);
    // The group itself stays — the user made it, and it is a place to drag to.
    expect(state.groups?.[1].members).toEqual([]);
    // A rename for an agent that is merely out of view is not an error either.
    expect(state.renames).toEqual({ [`${ROOT}/deleted`]: "Gone" });
  });

  it("leaves state identity alone when there is nothing to prune", () => {
    const state = materialized();
    expect(pruneRailState(state, WORKFLOWS)).toBe(state);
    expect(pruneRailState(EMPTY_RAIL_STATE, WORKFLOWS)).toBe(EMPTY_RAIL_STATE);
  });
});
