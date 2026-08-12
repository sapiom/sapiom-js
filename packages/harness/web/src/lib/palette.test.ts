import { describe, expect, it } from "vitest";
import type { HarnessSession, SessionSummary, WorkflowInfo } from "@shared/types";

import {
  buildPaletteItems,
  buildPathItems,
  GLOBAL_CAP,
  type PaletteAction,
  paletteActivation,
  type PaletteFilter,
  type PaletteItem,
  type PaletteSources,
  rankPaletteItems,
  recencyBonus,
  SECTION_QUERIED_CAP,
} from "./palette";

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

const session = (over: Partial<HarnessSession> & { id: string }): HarnessSession => ({
  agentSessionId: null,
  boundWorkflowPath: null,
  harness: "claude-code",
  cwd: "/Users/demo/acme-app",
  title: "acme-app",
  status: "running",
  createdAt: minutesAgo(60),
  lastActiveAt: minutesAgo(30),
  ready: true,
  ...over,
});

const summary = (over: Partial<SessionSummary> & { agentSessionId: string }): SessionSummary => ({
  harness: "claude-code",
  cwd: "/Users/demo/acme-app",
  title: "Untitled",
  lastActiveAt: minutesAgo(30),
  source: "transcript",
  resumeMode: "rehydrate",
  ...over,
});

const workflow = (over: Partial<WorkflowInfo> & { name: string; path: string }): WorkflowInfo => ({
  definitionId: null,
  definitionSlug: null,
  source: "scan",
  ...over,
});

const action = (over: Partial<PaletteAction> & { id: string; label: string }): PaletteAction => ({
  run: () => undefined,
  ...over,
});

const sources = (over: Partial<PaletteSources>): PaletteSources => ({
  sessions: [],
  workflows: [],
  history: [],
  recentDirs: [],
  sessionNames: {},
  actions: [],
  templates: [],
  ...over,
});

const rank = (query: string, over: Partial<PaletteSources>, filter: PaletteFilter = "all"): PaletteItem[] =>
  rankPaletteItems(query, buildPaletteItems(sources(over)), { filter, now: NOW });

describe("buildPaletteItems display names", () => {
  it("agents carry the rail's display name, not the raw scoped package name", () => {
    const items = buildPaletteItems(
      sources({
        workflows: [workflow({ name: "@sapiom/example-slack-notifier", path: "/Users/demo/team-tools/slack-notifier" })],
      }),
    );
    const agent = items.find((item) => item.kind === "agent");
    expect(agent?.label).toBe("slack-notifier");
    expect(agent?.path).toBe("/Users/demo/team-tools/slack-notifier");
    expect(agent?.meta).toBe("/Users/demo/team-tools/slack-notifier");
  });

  it("live sessions get the rail's numbered default names", () => {
    const first = session({ id: "s1", createdAt: minutesAgo(90) });
    const second = session({ id: "s2", createdAt: minutesAgo(10) });
    const items = buildPaletteItems(sources({ sessions: [first, second] }));
    expect(items.filter((item) => item.kind === "session").map((item) => item.label)).toEqual([
      "acme-app",
      "acme-app 2",
    ]);
  });

  it("session renames apply to registry rows and to their history summaries", () => {
    const renamed = session({ id: "s1" });
    const items = buildPaletteItems(
      sources({
        sessions: [renamed],
        history: [summary({ agentSessionId: "a9", harnessSessionId: "h9", title: "raw prompt text" })],
        sessionNames: { s1: "Leasing revamp", h9: "Digest tuning" },
      }),
    );
    expect(items.find((item) => item.kind === "session")?.label).toBe("Leasing revamp");
    expect(items.find((item) => item.kind === "past")?.label).toBe("Digest tuning");
  });

  it("actions and docs become searchable rows with their own icons and metas", () => {
    const items = buildPaletteItems(
      sources({ actions: [action({ id: "toggle-theme", label: "Toggle theme", meta: "Light and dark", icon: "Sun" })] }),
    );
    const command = items.find((item) => item.kind === "command");
    expect(command).toMatchObject({ id: "command:toggle-theme", label: "Toggle theme", icon: "Sun" });
    expect(command?.run).toBeTypeOf("function");
    const docs = items.filter((item) => item.kind === "doc");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].href).toMatch(/^https:\/\/docs\.sapiom\.ai\//);
  });
});

describe("past-session dedup", () => {
  it("collapses same-title same-folder rows to the newest", () => {
    const items = buildPaletteItems(
      sources({
        history: [
          summary({ agentSessionId: "a1", title: "Standup summary for #eng", lastActiveAt: daysAgo(4) }),
          summary({ agentSessionId: "a2", title: "Standup summary for #eng", lastActiveAt: daysAgo(2) }),
          summary({ agentSessionId: "a3", title: "Standup summary for #eng", lastActiveAt: daysAgo(5) }),
        ],
      }),
    );
    const past = items.filter((item) => item.kind === "past");
    expect(past).toHaveLength(1);
    expect(past[0].summary?.agentSessionId).toBe("a2");
  });

  it("keeps same-title rows apart when they live in different folders", () => {
    const items = buildPaletteItems(
      sources({
        history: [
          summary({ agentSessionId: "a1", title: "Standup", cwd: "/Users/demo/one" }),
          summary({ agentSessionId: "a2", title: "Standup", cwd: "/Users/demo/two" }),
        ],
      }),
    );
    expect(items.filter((item) => item.kind === "past")).toHaveLength(2);
  });

  it("on a recency tie the resumable registry row beats the transcript row", () => {
    const at = daysAgo(1);
    const items = buildPaletteItems(
      sources({
        sessions: [session({ id: "r1", status: "exited", title: "Old run", lastActiveAt: at })],
        history: [summary({ agentSessionId: "a1", title: "Old run", lastActiveAt: at, turnCount: 3 })],
      }),
    );
    const past = items.filter((item) => item.kind === "past");
    expect(past).toHaveLength(1);
    // Enter must resume the session, not downgrade to the review pane.
    expect(past[0].sessionId).toBe("r1");
  });

  it("between two transcripts on a recency tie the better-kept one wins", () => {
    const at = daysAgo(1);
    const items = buildPaletteItems(
      sources({
        history: [
          summary({ agentSessionId: "thin", title: "Old run", lastActiveAt: at, turnCount: 1 }),
          summary({ agentSessionId: "rich", title: "Old run", lastActiveAt: at, turnCount: 9 }),
        ],
      }),
    );
    const past = items.filter((item) => item.kind === "past");
    expect(past).toHaveLength(1);
    expect(past[0].summary?.agentSessionId).toBe("rich");
  });
});

describe("rankPaletteItems — the reported failures", () => {
  it('"daily" surfaces the agent, never rows matched via scattered path characters', () => {
    const results = rank("daily", {
      workflows: [
        workflow({
          name: "daily-activity-analyst",
          path: "/Users/demo/social-marketing/analytics-stack/daily-activity-analyst",
        }),
      ],
      history: [1, 2, 3, 4, 5].map((n) =>
        summary({
          agentSessionId: `noise-${n}`,
          title: "You are annotating an already-generated draft",
          cwd: `/Users/gwitwer/sapiom/hackathon-${n}`,
          lastActiveAt: minutesAgo(n),
        }),
      ),
    });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("agent");
    expect(results[0].label).toBe("daily-activity-analyst");
    expect(results[0].labelIndices).toEqual([0, 1, 2, 3, 4]);
  });

  it('"slack" dedups the session flood and drops path-scatter junk agents', () => {
    const results = rank("slack", {
      workflows: [
        workflow({ name: "@sapiom/example-slack-notifier", path: "/Users/demo/team-tools/slack-notifier" }),
        workflow({ name: "backlog-nudge", path: "/Users/gwitwer/sapiom/hackathon-local/workflows/backlog-nudge" }),
      ],
      history: [1, 2, 3, 4, 5, 6].map((n) =>
        summary({
          agentSessionId: `sb-${n}`,
          title: "slacksummarybot",
          cwd: "/Users/demo/wf-demo-testing/slacksummarybot",
          lastActiveAt: minutesAgo(n * 10),
        }),
      ),
    });
    expect(results.filter((item) => item.label === "slacksummarybot")).toHaveLength(1);
    const agent = results.find((item) => item.kind === "agent");
    expect(agent?.label).toBe("slack-notifier");
    expect(agent?.labelIndices).toEqual([0, 1, 2, 3, 4]);
    expect(results.some((item) => item.label === "backlog-nudge")).toBe(false);
  });
});

describe("rankPaletteItems ordering", () => {
  it("a name match can never rank below a path-only match, even a maximally fresh one", () => {
    const results = rank("acme", {
      history: [
        summary({ agentSessionId: "label-hit", title: "acme rollout", cwd: "/Users/demo/misc", lastActiveAt: daysAgo(60) }),
        summary({ agentSessionId: "meta-hit", title: "Something else", cwd: "/Users/demo/acme-app", lastActiveAt: minutesAgo(1) }),
      ],
    });
    expect(results.map((item) => item.summary?.agentSessionId)).toEqual(["label-hit", "meta-hit"]);
    expect(results[0].labelIndices).toBeDefined();
    expect(results[1].metaIndices).toBeDefined();
  });

  it("home-prefix path segments are searchable (metas are the raw cwd)", () => {
    const results = rank("demo", {
      history: [summary({ agentSessionId: "a1", title: "Something", cwd: "/Users/demo/acme-app" })],
    });
    expect(results).toHaveLength(1);
    expect(results[0].metaIndices).toBeDefined();
  });

  it("recency boost lifts a fresh near-exact match over a stale exact match", () => {
    const results = rank("leasing", {
      history: [
        summary({ agentSessionId: "stale-exact", title: "leasing", cwd: "/Users/demo/one", lastActiveAt: daysAgo(60) }),
        summary({ agentSessionId: "fresh-prefix", title: "leasing-v2", cwd: "/Users/demo/two", lastActiveAt: minutesAgo(5) }),
      ],
    });
    expect(results.map((item) => item.summary?.agentSessionId)).toEqual(["fresh-prefix", "stale-exact"]);
  });

  it("equal matches order newest-first", () => {
    const results = rank("digest", {
      history: [
        summary({ agentSessionId: "older", title: "digest run", cwd: "/Users/demo/one", lastActiveAt: daysAgo(3) }),
        summary({ agentSessionId: "newer", title: "digest run", cwd: "/Users/demo/two", lastActiveAt: daysAgo(2) }),
      ],
    });
    expect(results.map((item) => item.summary?.agentSessionId)).toEqual(["newer", "older"]);
  });

  it("on a dead-even best hit, Agents rank above Past sessions", () => {
    const results = rank("slack", {
      workflows: [workflow({ name: "slack-notifier", path: "/Users/demo/team-tools/slack-notifier" })],
      history: [
        summary({
          agentSessionId: "old",
          title: "slacksummarybot",
          cwd: "/Users/demo/wf-demo-testing/slacksummarybot",
          lastActiveAt: daysAgo(60),
        }),
      ],
    });
    expect(results.map((item) => item.kind)).toEqual(["agent", "past"]);
  });

  it("caps each section when several kinds match, but a lone section fills the window", () => {
    const many = (count: number): SessionSummary[] =>
      Array.from({ length: count }, (_, n) =>
        summary({
          agentSessionId: `m-${n}`,
          title: `meeting notes ${n}`,
          cwd: `/Users/demo/dir-${n}`,
          lastActiveAt: daysAgo(n + 1),
        }),
      );
    // Only past sessions match: the per-section cap lifts.
    expect(rank("meeting", { history: many(10) })).toHaveLength(10);

    // Two kinds match: each is capped so neither starves the other.
    const mixed = rank("dir", {
      history: many(10),
      workflows: Array.from({ length: 10 }, (_, n) =>
        workflow({ name: `dir-agent-${n}`, path: `/opt/agents/dir-agent-${n}` }),
      ),
    });
    expect(mixed.length).toBeLessThanOrEqual(GLOBAL_CAP);
    expect(mixed.filter((item) => item.kind === "agent")).toHaveLength(SECTION_QUERIED_CAP);
    expect(mixed.filter((item) => item.kind === "past")).toHaveLength(SECTION_QUERIED_CAP);
  });
});

describe("rankPaletteItems filters", () => {
  const filterSources: Partial<PaletteSources> = {
    sessions: [session({ id: "s1" }), session({ id: "s2", status: "exited", title: "Old run" })],
    workflows: [workflow({ name: "leasing", path: "/Users/demo/acme-app/leasing" })],
    recentDirs: ["/Users/demo/somewhere"],
    actions: [
      action({ id: "browse-templates", label: "Browse templates", meta: "Gallery and starters" }),
      action({ id: "toggle-theme", label: "Toggle theme", meta: "Light and dark" }),
    ],
    templates: [
      { id: "hello-agent", name: "Hello Agent", description: "The minimal single-step agent." },
      { id: "webhook-router", name: "Webhook Router", description: "Route inbound webhooks." },
    ],
  };

  it("the Actions tab lists every injected verb and nothing else", () => {
    const results = rank("", filterSources, "actions");
    expect(results.map((item) => item.kind)).toEqual(["command", "command"]);
    expect(results.map((item) => item.label)).toEqual(["Browse templates", "Toggle theme"]);
  });

  it("the Templates tab lists the catalog and matches within it", () => {
    const unqueried = rank("", filterSources, "templates");
    expect(unqueried.map((item) => item.label)).toEqual(["Hello Agent", "Webhook Router"]);
    const queried = rank("webhook", filterSources, "templates");
    expect(queried.map((item) => item.templateId)).toEqual(["webhook-router"]);
  });

  it("the Sessions tab scopes to live and past sessions", () => {
    const results = rank("", filterSources, "sessions");
    expect(results.map((item) => item.kind)).toEqual(["session", "past"]);
  });

  it("the Agents tab scopes to agents", () => {
    const results = rank("", filterSources, "agents");
    expect(results.map((item) => item.kind)).toEqual(["agent"]);
  });

  it("the Docs tab lists the doc links and matches within them", () => {
    const unqueried = rank("", filterSources, "docs");
    expect(unqueried.every((item) => item.kind === "doc")).toBe(true);
    const queried = rank("mcp", filterSources, "docs");
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((item) => item.kind === "doc")).toBe(true);
  });

  it("the Files tab lists folders only", () => {
    const results = rank("", filterSources, "files");
    expect(results.map((item) => item.kind)).toEqual(["recent"]);
  });

  it("a scoped tab never leaks other kinds for a broad query", () => {
    const results = rank("e", filterSources, "actions");
    expect(results.every((item) => item.kind === "command")).toBe(true);
  });

  it("template matches join the All tab's ranked results", () => {
    const results = rank("webhook", filterSources, "all");
    expect(results.some((item) => item.kind === "template")).toBe(true);
  });
});

describe("current session", () => {
  it("is badged and sorts last among live sessions unqueried, despite being the freshest", () => {
    const current = session({ id: "s-active", cwd: "/Users/demo/one", lastActiveAt: minutesAgo(0), createdAt: minutesAgo(10) });
    const other = session({ id: "s-other", cwd: "/Users/demo/two", lastActiveAt: minutesAgo(20), createdAt: minutesAgo(60) });
    const results = rank("", { sessions: [current, other], activeSessionId: "s-active" });
    const sessionRows = results.filter((item) => item.kind === "session");
    expect(sessionRows.map((item) => item.sessionId)).toEqual(["s-other", "s-active"]);
    expect(sessionRows[1].current).toBe(true);
    expect(sessionRows[0].current).toBeUndefined();
  });

  it("keeps its earned rank when queried — identification is the badge's job", () => {
    const current = session({ id: "s-active", title: "leasing pipeline", cwd: "/Users/demo/one", lastActiveAt: minutesAgo(0) });
    const results = rank("leasing pipeline", { sessions: [current], activeSessionId: "s-active" });
    expect(results[0].sessionId).toBe("s-active");
    expect(results[0].current).toBe(true);
  });
});

describe("rankPaletteItems empty query (All tab)", () => {
  it("keeps the fixed section order with recency-sorted groups and the action rows pinned last", () => {
    const older = session({ id: "s1", cwd: "/Users/demo/one", lastActiveAt: minutesAgo(50), createdAt: minutesAgo(60) });
    const newer = session({ id: "s2", cwd: "/Users/demo/two", lastActiveAt: minutesAgo(5), createdAt: minutesAgo(10) });
    const results = rank("", {
      sessions: [older, newer],
      workflows: [workflow({ name: "leasing", path: "/Users/demo/two/leasing" })],
      history: Array.from({ length: 8 }, (_, n) =>
        summary({ agentSessionId: `p-${n}`, title: `run ${n}`, lastActiveAt: daysAgo(n + 1) }),
      ),
      recentDirs: ["/Users/demo/one"],
      actions: [action({ id: "browse-templates", label: "Browse templates" })],
    });
    expect(results[0].sessionId).toBe("s2");
    expect(results[1].sessionId).toBe("s1");
    expect(results.filter((item) => item.kind === "past")).toHaveLength(6);
    expect(results.at(-1)?.label).toBe("Browse templates");
    const kinds = results.map((item) => item.kind);
    expect(kinds.indexOf("past")).toBeGreaterThan(kinds.lastIndexOf("session"));
    expect(kinds.indexOf("agent")).toBeGreaterThan(kinds.lastIndexOf("past"));
  });
});

describe("recencyBonus", () => {
  it("tiers by age and ignores pseudo-recency", () => {
    expect(recencyBonus(NOW, NOW - 10 * 60_000)).toBe(30);
    expect(recencyBonus(NOW, NOW - 5 * 3_600_000)).toBe(20);
    expect(recencyBonus(NOW, NOW - 3 * 86_400_000)).toBe(12);
    expect(recencyBonus(NOW, NOW - 20 * 86_400_000)).toBe(6);
    expect(recencyBonus(NOW, NOW - 90 * 86_400_000)).toBe(0);
    expect(recencyBonus(NOW, 5)).toBe(0); // MRU rank, not a timestamp
    expect(recencyBonus(NOW, 0)).toBe(0);
  });
});

describe("paletteActivation", () => {
  const base: PaletteItem = { id: "x", kind: "past", label: "x", meta: "", recency: 0 };

  it("a past row prefers its live/registry id over the transcript summary", () => {
    const both = { ...base, sessionId: "s1", summary: summary({ agentSessionId: "a1" }) };
    expect(paletteActivation(both)).toEqual({ type: "select-session", sessionId: "s1" });
  });

  it("a transcript-only past row opens the review pane", () => {
    const only = { ...base, summary: summary({ agentSessionId: "a1" }) };
    expect(paletteActivation(only)).toEqual({ type: "review-summary", summary: only.summary });
  });

  it("a past row never falls through to open-path", () => {
    expect(paletteActivation({ ...base, path: "/Users/demo/x" })).toEqual({ type: "none" });
  });

  it("actions run their verb; docs open their page; paths open raw", () => {
    const run = (): void => undefined;
    expect(paletteActivation({ ...base, kind: "command", run })).toEqual({ type: "run", run });
    expect(paletteActivation({ ...base, kind: "doc", href: "https://docs.sapiom.ai/" })).toEqual({
      type: "open-href",
      href: "https://docs.sapiom.ai/",
    });
    expect(paletteActivation({ ...base, kind: "agent", path: "/p" })).toEqual({ type: "open-path", path: "/p" });
  });

  it("a template row opens the templates browser focused on it", () => {
    expect(paletteActivation({ ...base, kind: "template", templateId: "hello-agent" })).toEqual({
      type: "open-template",
      templateId: "hello-agent",
    });
  });
});

describe("buildPathItems", () => {
  it("offers the literal input first, then the listed dirs with raw metas", () => {
    const items = buildPathItems("/Users/demo", [
      { name: "acme-app", path: "/Users/demo/acme-app", hasAgentProject: false },
    ]);
    expect(items[0]).toMatchObject({ label: "/Users/demo", meta: "Open this path", path: "/Users/demo" });
    expect(items[1]).toMatchObject({ label: "acme-app", meta: "/Users/demo/acme-app" });
  });

  it("omits the confirm row for a blank query", () => {
    expect(buildPathItems("  ", [])).toEqual([]);
  });
});
