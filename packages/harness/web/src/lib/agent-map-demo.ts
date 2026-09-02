/**
 * Browser-only state for the `?mockFixtures=agent-map` concept walkthrough.
 *
 * This is deliberately not a SystemGraph adapter. The map describes a plan —
 * including a resource, connector, contract-bearing handoff, and owned
 * subagent — while SystemGraph describes discovered project agents. Keeping a
 * small view model here prevents an experiment from widening a production
 * contract or teaching the legacy graph to author architecture.
 */

export const AGENT_MAP_DEMO_FIXTURE = "agent-map";

export const GOLDEN_PATH_REQUEST =
  "Build a research agent that finds the top ten stocks trading today. Store the research report, then give it to a marketing agent connected to TikTok that turns it into a news-format video and publishes it.";

export const EDITOR_FOLLOW_UP =
  "Before marketing receives the report, have an LLM select the strongest points.";

export const BUILD_PLAN_REQUEST = "Show me the build plan.";

export const LAUNCH_BUILDERS_REQUEST = "Approve and launch the builders.";

export type AgentMapDemoPhase =
  | "opening"
  | "proposal"
  | "subagent-proposal"
  | "confirmed"
  | "build-plan"
  | "builders-launched";

export type AgentMapDemoTurnKind =
  | "opening"
  | "proposal"
  | "confirmed"
  | "build-plan"
  | "builders-launched"
  | "bounded";

export interface AgentMapDemoTurn {
  id: string;
  role: "planner" | "user";
  body: string;
  kind?: AgentMapDemoTurnKind;
}

export interface AgentMapDemoState {
  phase: AgentMapDemoPhase;
  revision: 0 | 1 | 2;
  editorIncluded: boolean;
  projectExpanded: boolean;
  selectedNodeId: AgentMapDemoNodeId | null;
  selectedBuilderId: AgentMapDemoBuilderSessionId | null;
  turns: AgentMapDemoTurn[];
}

export type AgentMapDemoAction =
  | { type: "submit"; text: string }
  | { type: "toggle-project" }
  | { type: "select-node"; nodeId: AgentMapDemoNodeId | null }
  | { type: "select-builder"; builderId: AgentMapDemoBuilderSessionId }
  | { type: "reset" };

export type AgentMapDemoNodeId =
  | "market-research"
  | "marketing-publisher"
  | "research-database"
  | "tiktok"
  | "news-editor";

export type AgentMapDemoNodeKind =
  | "Agent"
  | "Resource"
  | "Connector"
  | "Owned subagent";

export interface AgentMapDemoNode {
  id: AgentMapDemoNodeId;
  label: string;
  kind: AgentMapDemoNodeKind;
  purpose: string;
  ownerId?: AgentMapDemoNodeId;
}

export type AgentMapDemoRelationshipType =
  | "feeds"
  | "writes"
  | "reads"
  | "uses";

export interface AgentMapDemoRelationship {
  id: string;
  from: AgentMapDemoNodeId;
  to: AgentMapDemoNodeId;
  type: AgentMapDemoRelationshipType;
  contract?: string;
}

export type AgentMapDemoBuilderSessionId =
  | "market-research-builder"
  | "marketing-publisher-builder";

export type AgentMapDemoBuilderContextLayerId =
  | "role"
  | "project-context"
  | "assignment"
  | "contracts"
  | "boundaries"
  | "operating-rule"
  | "reconciliation-rule"
  | "provenance";

export interface AgentMapDemoBuilderContextLayer {
  id: AgentMapDemoBuilderContextLayerId;
  label: string;
  items: readonly string[];
}

export type AgentMapDemoBuilderStepKind =
  | "contract"
  | "data"
  | "decision"
  | "report"
  | "resource-boundary"
  | "owned-subagent"
  | "story"
  | "media"
  | "connector-boundary";

export interface AgentMapDemoBuilderStep {
  id: string;
  label: string;
  kind: AgentMapDemoBuilderStepKind;
  kindLabel: string;
  owner: string;
}

export interface AgentMapDemoBuilderSession {
  id: AgentMapDemoBuilderSessionId;
  agentId: "market-research" | "marketing-publisher";
  agentLabel: string;
  railLabel: string;
  contextLayers: readonly AgentMapDemoBuilderContextLayer[];
  firstReply: string;
  steps: readonly AgentMapDemoBuilderStep[];
}

const BASE_NODES: readonly AgentMapDemoNode[] = [
  {
    id: "market-research",
    label: "Market Research",
    kind: "Agent",
    purpose:
      "Finds and ranks the ten strongest stocks trading today, then owns the research handoff.",
  },
  {
    id: "marketing-publisher",
    label: "Marketing / Publisher",
    kind: "Agent",
    purpose:
      "Turns approved research into a news-format video and owns publishing.",
  },
  {
    id: "research-database",
    label: "Research Database",
    kind: "Resource",
    purpose:
      "Persists the ResearchReport between research and publishing responsibilities.",
  },
  {
    id: "tiktok",
    label: "TikTok",
    kind: "Connector",
    purpose:
      "The publishing destination used by Marketing / Publisher for the finished video.",
  },
];

const NEWS_EDITOR_NODE: AgentMapDemoNode = {
  id: "news-editor",
  label: "News Editor",
  kind: "Owned subagent",
  purpose:
    "Selects the strongest report points and shapes the editorial brief before production.",
  ownerId: "marketing-publisher",
};

const BASE_RELATIONSHIPS: readonly AgentMapDemoRelationship[] = [
  {
    id: "research-writes-report",
    from: "market-research",
    to: "research-database",
    type: "writes",
    contract: "ResearchReport",
  },
  {
    id: "report-feeds-marketing",
    from: "research-database",
    to: "marketing-publisher",
    type: "feeds",
    contract: "ResearchReport",
  },
  {
    id: "marketing-uses-tiktok",
    from: "marketing-publisher",
    to: "tiktok",
    type: "uses",
  },
];

const EDITOR_RELATIONSHIPS: readonly AgentMapDemoRelationship[] = [
  BASE_RELATIONSHIPS[0],
  {
    id: "report-feeds-editor",
    from: "research-database",
    to: "news-editor",
    type: "feeds",
    contract: "ResearchReport",
  },
  {
    id: "editor-feeds-marketing",
    from: "news-editor",
    to: "marketing-publisher",
    type: "feeds",
    contract: "EditorialBrief",
  },
  BASE_RELATIONSHIPS[2],
];

const CONFIRMED_PROJECT_CONTEXT = [
  "Project: Stock video desk",
  "Confirmed architecture: Agent Map revision 2",
  "Project agents: Market Research; Marketing / Publisher",
  "Resource: Research Database",
  "Connector: TikTok",
  "Persisted handoff: ResearchReport is written to Research Database and feeds Marketing / Publisher; the owned News Editor returns EditorialBrief inside Marketing’s ownership boundary.",
] as const;

const BUILDER_OPERATING_RULE =
  "Begin by planning the implementation with the user; do not silently change another agent’s scope.";

const BUILDER_RECONCILIATION_RULE =
  "If the user changes architecture in this child session, surface a proposed Agent Map revision back to the Planner instead of letting global project context drift.";

const BUILDER_PROVENANCE =
  "Injected by Planner from confirmed Agent Map revision 2. Mock startup context only; these strings are not a production prompt contract.";

function builderContextLayers({
  role,
  assignment,
  contracts,
  boundaries,
}: {
  role: string;
  assignment: readonly string[];
  contracts: readonly string[];
  boundaries: readonly string[];
}): readonly AgentMapDemoBuilderContextLayer[] {
  return [
    {
      id: "role",
      label: "Builder role",
      items: [role],
    },
    {
      id: "project-context",
      label: "Confirmed project context",
      items: CONFIRMED_PROJECT_CONTEXT,
    },
    {
      id: "assignment",
      label: "Agent-specific assignment and ownership",
      items: assignment,
    },
    {
      id: "contracts",
      label: "Inputs / outputs / contracts and dependencies",
      items: contracts,
    },
    {
      id: "boundaries",
      label: "Scope boundaries / non-goals",
      items: boundaries,
    },
    {
      id: "operating-rule",
      label: "Operating rule",
      items: [BUILDER_OPERATING_RULE],
    },
    {
      id: "reconciliation-rule",
      label: "Reconciliation rule",
      items: [BUILDER_RECONCILIATION_RULE],
    },
    {
      id: "provenance",
      label: "Provenance",
      items: [BUILDER_PROVENANCE],
    },
  ];
}

const BUILDER_SESSIONS: Record<
  AgentMapDemoBuilderSessionId,
  AgentMapDemoBuilderSession
> = {
  "market-research-builder": {
    id: "market-research-builder",
    agentId: "market-research",
    agentLabel: "Market Research",
    railLabel: "Research builder",
    contextLayers: builderContextLayers({
      role: "You are the Market Research builder: a child implementation session, distinct from the project planning agent.",
      assignment: [
        "Own finding and ranking today’s top ten stocks.",
        "Produce an evidence-backed ResearchReport and write it to Research Database.",
      ],
      contracts: [
        "Input: today’s active market data and supporting evidence.",
        "Output: an evidence-backed ResearchReport containing the ranked top ten.",
        "Contract: preserve the confirmed ResearchReport handoff.",
        "Dependency: Research Database must accept and verify the persisted report.",
      ],
      boundaries: [
        "Do not own editorial selection.",
        "Do not own news-format script or video generation.",
        "Do not own TikTok publishing.",
      ],
    }),
    firstReply:
      "I received the **confirmed Agent Map revision 2** and the **Market Research** assignment. I’ll start in **planning mode**; I am not claiming implementation has begun.\n\nHere is my proposed five-step breakdown before implementation:",
    steps: [
      {
        id: "define-research-report",
        label: "Define ResearchReport contract",
        kind: "contract",
        kindLabel: "Contract",
        owner: "Market Research",
      },
      {
        id: "fetch-active-market-data",
        label: "Fetch today’s active market data",
        kind: "data",
        kindLabel: "Data intake",
        owner: "Market Research",
      },
      {
        id: "rank-top-ten",
        label: "Rank and select the top ten",
        kind: "decision",
        kindLabel: "Decision",
        owner: "Market Research",
      },
      {
        id: "compose-research-report",
        label: "Compose the evidence-backed report",
        kind: "report",
        kindLabel: "Report",
        owner: "Market Research",
      },
      {
        id: "persist-research-handoff",
        label: "Persist and verify the Research Database handoff",
        kind: "resource-boundary",
        kindLabel: "Resource boundary",
        owner: "Market Research → Research Database",
      },
    ],
  },
  "marketing-publisher-builder": {
    id: "marketing-publisher-builder",
    agentId: "marketing-publisher",
    agentLabel: "Marketing / Publisher",
    railLabel: "Publisher builder",
    contextLayers: builderContextLayers({
      role: "You are the Marketing / Publisher builder: a child implementation session, distinct from the project planning agent.",
      assignment: [
        "Consume ResearchReport / EditorialBrief and own the downstream publishing path.",
        "Own News Editor as a subagent with a distinct editorial responsibility.",
        "Create the news-format script and video, then publish through TikTok.",
      ],
      contracts: [
        "Inputs: persisted ResearchReport and the owned News Editor’s EditorialBrief.",
        "Outputs: news-format script, video, and TikTok publish result.",
        "Contract: validate the upstream ResearchReport before editorial work begins.",
        "Dependencies: Research Database, owned News Editor, and TikTok connector.",
      ],
      boundaries: [
        "Do not redo market research.",
        "Do not alter Market Research’s upstream ranking responsibility.",
      ],
    }),
    firstReply:
      "I received the **confirmed Agent Map revision 2** and the **Marketing / Publisher** assignment. I’ll start in **planning mode**; I am not claiming implementation has begun.\n\nHere is my proposed five-step breakdown before implementation:",
    steps: [
      {
        id: "validate-research-report",
        label: "Read and validate ResearchReport",
        kind: "contract",
        kindLabel: "Contract",
        owner: "Marketing / Publisher",
      },
      {
        id: "news-editor-selection",
        label: "Have owned News Editor select the strongest points",
        kind: "owned-subagent",
        kindLabel: "Owned subagent",
        owner: "News Editor · owned by Marketing / Publisher",
      },
      {
        id: "draft-news-storyboard",
        label: "Draft the news script/storyboard",
        kind: "story",
        kindLabel: "Story",
        owner: "Marketing / Publisher",
      },
      {
        id: "generate-news-video",
        label: "Generate the news-format video",
        kind: "media",
        kindLabel: "Media",
        owner: "Marketing / Publisher",
      },
      {
        id: "publish-tiktok",
        label: "Publish through TikTok and report the result",
        kind: "connector-boundary",
        kindLabel: "Connector boundary",
        owner: "Marketing / Publisher → TikTok",
      },
    ],
  },
};

const OPENING_TURN: AgentMapDemoTurn = {
  id: "planner-opening",
  role: "planner",
  kind: "opening",
  body: "I’ll plan the project’s agents, responsibilities, data flow, resources, and connectors with you. What outcome do you want this project to create?",
};

export function agentMapDemoFixtureEnabled(
  mockMode: string | boolean | undefined,
  search: string,
): boolean {
  return (
    (mockMode === "1" || mockMode === true) &&
    new URLSearchParams(search).get("mockFixtures") === AGENT_MAP_DEMO_FIXTURE
  );
}

export function createInitialAgentMapDemoState(): AgentMapDemoState {
  return {
    phase: "opening",
    revision: 0,
    editorIncluded: false,
    projectExpanded: true,
    selectedNodeId: null,
    selectedBuilderId: null,
    turns: [{ ...OPENING_TURN }],
  };
}

function normalized(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

function isGoldenPathRequest(text: string): boolean {
  const value = normalized(text);
  return (
    /\bstocks?\b/.test(value) &&
    value.includes("research") &&
    value.includes("tiktok") &&
    (value.includes("marketing") || value.includes("video"))
  );
}

function isEditorFollowUp(text: string): boolean {
  const value = normalized(text);
  return (
    (value.includes("strongest") || value.includes("best")) &&
    (value.includes("point") || value.includes("editor")) &&
    (value.includes("llm") ||
      value.includes("model") ||
      value.includes("editor"))
  );
}

function isUnambiguousYes(text: string): boolean {
  return /^(yes|yes[,.]? please|yes[,.]? it does|yes[,.]? (that )?looks right|looks right|that looks right|the architecture looks right)[.!]?$/i.test(
    text.trim(),
  );
}

function requestsBuildPlan(text: string): boolean {
  const value = normalized(text);
  return value.includes("build") && value.includes("plan");
}

function approvesLaunch(text: string): boolean {
  const value = normalized(text).replace(/[.!]$/, "");
  return (
    isUnambiguousYes(text) ||
    value.includes("launch") ||
    value.includes("start the builders") ||
    value.includes("go ahead") ||
    (value.includes("approve") && value.includes("builder"))
  );
}

function appendExchange(
  state: AgentMapDemoState,
  userBody: string,
  plannerBody: string,
  kind: AgentMapDemoTurnKind,
  patch: Partial<AgentMapDemoState> = {},
): AgentMapDemoState {
  const index = state.turns.length;
  return {
    ...state,
    ...patch,
    turns: [
      ...state.turns,
      { id: `user-${index}`, role: "user", body: userBody },
      {
        id: `planner-${index + 1}`,
        role: "planner",
        body: plannerBody,
        kind,
      },
    ],
  };
}

function boundedResponse(
  state: AgentMapDemoState,
  text: string,
): AgentMapDemoState {
  const messageByPhase: Record<AgentMapDemoPhase, string> = {
    opening:
      "This concept demo is bounded to the stock-research walkthrough. Use the prepared brief to see its deterministic proposal.",
    proposal:
      "For this walkthrough, refine the draft with the editorial follow-up or answer with an unambiguous yes to confirm the current proposal.",
    "subagent-proposal":
      "The revised proposal is staged. Answer with an unambiguous yes to confirm this exact revision.",
    confirmed:
      "The architecture is confirmed. Ask to see the build plan to continue the scripted walkthrough.",
    "build-plan":
      "The build plan is staged. Approve or launch the builders conversationally to continue; no real session will be created.",
    "builders-launched":
      "The simulated builders are already visible in the rail. Reset the demo to replay the walkthrough from its empty opening state.",
  };
  return appendExchange(state, text, messageByPhase[state.phase], "bounded");
}

export function agentMapDemoReducer(
  state: AgentMapDemoState,
  action: AgentMapDemoAction,
): AgentMapDemoState {
  if (action.type === "reset") return createInitialAgentMapDemoState();

  if (action.type === "toggle-project") {
    return { ...state, projectExpanded: !state.projectExpanded };
  }

  if (action.type === "select-builder") {
    if (state.phase !== "builders-launched") return state;
    return {
      ...state,
      selectedBuilderId: action.builderId,
      selectedNodeId: null,
    };
  }

  if (action.type === "select-node") {
    return {
      ...state,
      selectedBuilderId: null,
      selectedNodeId: action.nodeId,
    };
  }

  // Builder snapshots never feed the planner conversation. The visible
  // builder composer is non-interactive, and this guard keeps an accidental
  // submit dispatch from mutating the preserved planner transcript.
  if (state.selectedBuilderId) return state;

  const text = action.text.trim();
  if (!text) return state;

  if (state.phase === "opening" && isGoldenPathRequest(text)) {
    return appendExchange(
      state,
      text,
      "I’ve drafted a two-agent plan with one persisted handoff. **Market Research** owns the daily ranking and writes a typed **ResearchReport** to **Research Database**. That report feeds **Marketing / Publisher**, which owns the news-format video and uses the **TikTok** connector to publish it.\n\n**Does this architecture look right?**",
      "proposal",
      {
        phase: "proposal",
        revision: 1,
        editorIncluded: false,
        selectedNodeId: null,
      },
    );
  }

  if (state.phase === "proposal" && isEditorFollowUp(text)) {
    return appendExchange(
      state,
      text,
      "That adds a distinct editorial responsibility, not an ordinary model call. I’ve proposed **News Editor** as an owned subagent inside **Marketing / Publisher**: it reads the persisted **ResearchReport**, selects the strongest points, and feeds an **EditorialBrief** to its owning agent. It is not an independently deployed project agent.\n\n**Does this revised architecture look right?**",
      "proposal",
      {
        phase: "subagent-proposal",
        revision: 2,
        editorIncluded: true,
        selectedNodeId: null,
      },
    );
  }

  if (
    (state.phase === "proposal" || state.phase === "subagent-proposal") &&
    isUnambiguousYes(text)
  ) {
    return appendExchange(
      state,
      text,
      `Revision ${state.revision} is now **confirmed**. The exact agents, ownership boundary, persisted handoff, and connector shown on the map are locked for this concept walkthrough. Ask me to show the build plan when you’re ready to continue.`,
      "confirmed",
      { phase: "confirmed", selectedNodeId: null },
    );
  }

  if (state.phase === "confirmed" && requestsBuildPlan(text)) {
    return appendExchange(
      state,
      text,
      "Here is the compact project build plan. Each builder stays scoped to one project agent, while the data contract and connector checks remain explicit handoff criteria. Approve the simulated launch in the conversation when you’re ready.",
      "build-plan",
      { phase: "build-plan", selectedNodeId: null },
    );
  }

  if (state.phase === "build-plan" && approvesLaunch(text)) {
    return appendExchange(
      state,
      text,
      "Simulated launch complete. Two scoped builder-session rows are now visible beneath their owning project agents. This remains a local concept fixture: no repository, agent, session, network request, or deployment was created.",
      "builders-launched",
      { phase: "builders-launched", selectedNodeId: null },
    );
  }

  return boundedResponse(state, text);
}

export function agentMapDemoHasProposal(state: AgentMapDemoState): boolean {
  return state.phase !== "opening";
}

export function agentMapDemoBuilderSession(
  builderId: AgentMapDemoBuilderSessionId,
): AgentMapDemoBuilderSession {
  return BUILDER_SESSIONS[builderId];
}

export function agentMapDemoNodes(
  state: AgentMapDemoState,
): readonly AgentMapDemoNode[] {
  if (!agentMapDemoHasProposal(state)) return [];
  return state.editorIncluded ? [...BASE_NODES, NEWS_EDITOR_NODE] : BASE_NODES;
}

export function agentMapDemoRelationships(
  state: AgentMapDemoState,
): readonly AgentMapDemoRelationship[] {
  if (!agentMapDemoHasProposal(state)) return [];
  return state.editorIncluded ? EDITOR_RELATIONSHIPS : BASE_RELATIONSHIPS;
}

export function agentMapDemoNodeStatus(
  state: AgentMapDemoState,
  node: AgentMapDemoNode,
): "planned" | "confirmed" | "builder staged" {
  if (state.phase === "builders-launched" && node.kind === "Agent") {
    return "builder staged";
  }
  if (
    state.phase === "confirmed" ||
    state.phase === "build-plan" ||
    state.phase === "builders-launched"
  ) {
    return "confirmed";
  }
  return "planned";
}
