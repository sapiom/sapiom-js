import { describe, expect, it } from "vitest";

import {
  BUILD_PLAN_REQUEST,
  EDITOR_FOLLOW_UP,
  GOLDEN_PATH_REQUEST,
  LAUNCH_BUILDERS_REQUEST,
  agentMapDemoFixtureEnabled,
  agentMapDemoNodes,
  agentMapDemoReducer,
  agentMapDemoRelationships,
  createInitialAgentMapDemoState,
  type AgentMapDemoState,
} from "./agent-map-demo";

function createLaunchedState(): AgentMapDemoState {
  let state = createInitialAgentMapDemoState();
  state = agentMapDemoReducer(state, {
    type: "submit",
    text: GOLDEN_PATH_REQUEST,
  });
  state = agentMapDemoReducer(state, {
    type: "submit",
    text: EDITOR_FOLLOW_UP,
  });
  state = agentMapDemoReducer(state, { type: "submit", text: "yes" });
  state = agentMapDemoReducer(state, {
    type: "submit",
    text: BUILD_PLAN_REQUEST,
  });
  return agentMapDemoReducer(state, {
    type: "submit",
    text: LAUNCH_BUILDERS_REQUEST,
  });
}

describe("Agent Map demo fixture gate", () => {
  it("requires both mock mode and the exact agent-map fixture", () => {
    expect(agentMapDemoFixtureEnabled("1", "?mockFixtures=agent-map")).toBe(
      true,
    );
    expect(
      agentMapDemoFixtureEnabled(undefined, "?mockFixtures=agent-map"),
    ).toBe(false);
    expect(agentMapDemoFixtureEnabled("0", "?mockFixtures=agent-map")).toBe(
      false,
    );
    expect(agentMapDemoFixtureEnabled("1", "?mockFixtures=deep")).toBe(false);
    expect(agentMapDemoFixtureEnabled("1", "")).toBe(false);
  });
});

describe("Agent Map demo reducer", () => {
  it("walks the golden path through proposal, owned editor, confirmation, plan, and simulated builders", () => {
    let state = createInitialAgentMapDemoState();
    expect(state.phase).toBe("opening");
    expect(agentMapDemoNodes(state)).toEqual([]);
    expect(state.turns).toHaveLength(1);

    state = agentMapDemoReducer(state, {
      type: "submit",
      text: GOLDEN_PATH_REQUEST,
    });
    expect(state.phase).toBe("proposal");
    expect(state.revision).toBe(1);
    expect(agentMapDemoNodes(state).map((node) => node.label)).toEqual([
      "Market Research",
      "Marketing / Publisher",
      "Research Database",
      "TikTok",
    ]);
    expect(agentMapDemoRelationships(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "writes",
          contract: "ResearchReport",
        }),
        expect.objectContaining({
          type: "feeds",
          contract: "ResearchReport",
        }),
        expect.objectContaining({ type: "uses", to: "tiktok" }),
      ]),
    );

    state = agentMapDemoReducer(state, {
      type: "submit",
      text: EDITOR_FOLLOW_UP,
    });
    expect(state.phase).toBe("subagent-proposal");
    expect(state.revision).toBe(2);
    expect(agentMapDemoNodes(state).at(-1)).toMatchObject({
      label: "News Editor",
      kind: "Owned subagent",
      ownerId: "marketing-publisher",
    });
    expect(agentMapDemoRelationships(state)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "research-database",
          to: "news-editor",
          type: "feeds",
          contract: "ResearchReport",
        }),
        expect.objectContaining({
          from: "news-editor",
          to: "marketing-publisher",
          type: "feeds",
          contract: "EditorialBrief",
        }),
      ]),
    );

    state = agentMapDemoReducer(state, { type: "submit", text: "yes" });
    expect(state.phase).toBe("confirmed");
    expect(state.revision).toBe(2);

    state = agentMapDemoReducer(state, {
      type: "submit",
      text: BUILD_PLAN_REQUEST,
    });
    expect(state.phase).toBe("build-plan");

    state = agentMapDemoReducer(state, {
      type: "submit",
      text: LAUNCH_BUILDERS_REQUEST,
    });
    expect(state.phase).toBe("builders-launched");
    expect(state.turns.at(-1)?.body).toContain("no repository");
  });

  it("does not treat ambiguous conversation as architecture confirmation", () => {
    let state = createInitialAgentMapDemoState();
    state = agentMapDemoReducer(state, {
      type: "submit",
      text: GOLDEN_PATH_REQUEST,
    });
    state = agentMapDemoReducer(state, {
      type: "submit",
      text: "Maybe that sounds good?",
    });

    expect(state.phase).toBe("proposal");
    expect(state.turns.at(-1)?.kind).toBe("bounded");
  });

  it("rejects builder navigation until the simulated builders are launched", () => {
    const state = createInitialAgentMapDemoState();
    const attemptedNavigation = agentMapDemoReducer(state, {
      type: "select-builder",
      builderId: "market-research-builder",
    });

    expect(attemptedNavigation).toBe(state);
    expect(attemptedNavigation.selectedBuilderId).toBeNull();
  });

  it("keeps builder and map inspection navigation mutually exclusive", () => {
    let state = createLaunchedState();
    state = agentMapDemoReducer(state, {
      type: "select-node",
      nodeId: "market-research",
    });
    expect(state.selectedNodeId).toBe("market-research");

    state = agentMapDemoReducer(state, {
      type: "select-builder",
      builderId: "market-research-builder",
    });
    expect(state.selectedBuilderId).toBe("market-research-builder");
    expect(state.selectedNodeId).toBeNull();

    const builderTurns = state.turns;
    const ignoredBuilderSubmit = agentMapDemoReducer(state, {
      type: "submit",
      text: "Change the other agent too.",
    });
    expect(ignoredBuilderSubmit).toBe(state);
    expect(ignoredBuilderSubmit.turns).toBe(builderTurns);

    state = agentMapDemoReducer(state, {
      type: "select-builder",
      builderId: "marketing-publisher-builder",
    });
    expect(state.selectedBuilderId).toBe("marketing-publisher-builder");

    state = agentMapDemoReducer(state, {
      type: "select-node",
      nodeId: "marketing-publisher",
    });
    expect(state.selectedBuilderId).toBeNull();
    expect(state.selectedNodeId).toBe("marketing-publisher");

    state = agentMapDemoReducer(state, {
      type: "select-builder",
      builderId: "market-research-builder",
    });
    state = agentMapDemoReducer(state, {
      type: "select-node",
      nodeId: null,
    });
    expect(state.selectedBuilderId).toBeNull();
    expect(state.selectedNodeId).toBeNull();
  });

  it("resets the complete local walkthrough to its expanded empty opening", () => {
    let state = createLaunchedState();
    state = agentMapDemoReducer(state, {
      type: "select-builder",
      builderId: "marketing-publisher-builder",
    });
    state = agentMapDemoReducer(state, { type: "toggle-project" });
    state = agentMapDemoReducer(state, { type: "reset" });

    expect(state).toEqual(createInitialAgentMapDemoState());
    expect(state.projectExpanded).toBe(true);
    expect(state.selectedNodeId).toBeNull();
    expect(state.selectedBuilderId).toBeNull();
    expect(agentMapDemoNodes(state)).toEqual([]);
  });
});
