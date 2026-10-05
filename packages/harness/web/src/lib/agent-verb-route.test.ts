import { describe, expect, it } from "vitest";

import type { MacroDef, WorkflowInfo } from "@shared/types";
import { agentMacroFirstMessage } from "./agent-session-macro";
import { agentVerbRoute } from "./agent-verb-route";

const agent = (overrides: Partial<WorkflowInfo> = {}): WorkflowInfo => ({
  path: "/work/proj/agents/intake",
  name: "intake",
  definitionId: null,
  definitionSlug: null,
  source: "connect",
  ...overrides,
});

const macro = (id: string, action: MacroDef["action"], extra: Partial<MacroDef> = {}): MacroDef => ({
  id,
  label: id,
  icon: "Play",
  requiresWorkflow: true,
  action,
  ...extra,
});

const VISUALIZE = macro("visualize", { kind: "render-canvas" }, { requiresWorkflow: false });
const DEPLOY = macro("deploy", { kind: "inject", text: "cd {{workflow.path}} && sapiom agents deploy" });
const RUN_LOCAL = macro("run_local", { kind: "inject", text: "cd {{workflow.path}} && sapiom agents run --target local" });
const PROD_RUN = macro("prod_run", { kind: "inject", text: "cd {{workflow.path}} && sapiom agents run --target prod" });
const DESCRIBE = macro("describe", { kind: "inject", text: "{{subject}}" }, { execution: "background" });
const OPEN_PROD = macro("open_prod", { kind: "open-url", url: "https://app.sapiom.ai/agents/{{workflow.definitionId}}" });

describe("agentVerbRoute: every verb by agent path, none by session", () => {
  it("Visualize and render-error Retry refetch the agent's graph route", () => {
    expect(agentVerbRoute(VISUALIZE, agent())).toEqual({
      kind: "reload-graph",
      agentPath: "/work/proj/agents/intake",
    });
  });

  it("Deploy and Run locally go to their direct routes by path", () => {
    expect(agentVerbRoute(DEPLOY, agent())).toEqual({ kind: "deploy", agentPath: "/work/proj/agents/intake" });
    expect(agentVerbRoute(RUN_LOCAL, agent())).toEqual({ kind: "run-local", agentPath: "/work/proj/agents/intake" });
  });

  it("Run goes to the runs route with the ready definition, as a string", () => {
    const ready = agent({ definitionId: 42, activeBuildRunId: "b1", activeBuildRunStatus: "ready" });
    expect(agentVerbRoute(PROD_RUN, ready)).toEqual({
      kind: "prod-run",
      agentPath: "/work/proj/agents/intake",
      definitionId: "42",
    });
  });

  it("Run without a ready build is refused with the reason, never run", () => {
    expect(agentVerbRoute(PROD_RUN, agent())).toEqual({
      kind: "refuse",
      reason: "This agent isn't deployed yet — deploy it first.",
    });
    expect(agentVerbRoute(PROD_RUN, agent(), "Deploy failed: x")).toEqual({
      kind: "refuse",
      reason: "Last deploy failed — retry Deploy.",
    });
  });

  it("no agent: refused with a reason (no session fallback exists to take over)", () => {
    for (const m of [VISUALIZE, DEPLOY, RUN_LOCAL, DESCRIBE])
      expect(agentVerbRoute(m, null)).toEqual({ kind: "refuse", reason: "Select an agent first." });
    expect(agentVerbRoute(PROD_RUN, null)).toEqual({
      kind: "refuse",
      reason: "This agent isn't deployed yet — deploy it first.",
    });
  });

  it("Describe with AI is a session macro, not a headless task in a bound session", () => {
    expect(agentVerbRoute(DESCRIBE, agent())).toEqual({ kind: "session-macro", job: "describe", text: "" });
  });

  it("any other inject macro is an Ask session with the agent's placeholders filled", () => {
    const explain = macro("explain", { kind: "inject", text: "Explain {{workflow.name}} at {{workflow.path}}{{subject}}" });
    expect(agentVerbRoute(explain, agent())).toEqual({
      kind: "session-macro",
      job: "ask",
      text: "Explain intake at /work/proj/agents/intake",
    });
  });

  it("open-url resolves the agent's definition id", () => {
    expect(agentVerbRoute(OPEN_PROD, agent({ definitionId: 7 }))).toEqual({
      kind: "open-url",
      url: "https://app.sapiom.ai/agents/7",
    });
  });

  it("no route carries a session id", () => {
    const routes = [VISUALIZE, DEPLOY, RUN_LOCAL, PROD_RUN, DESCRIBE, OPEN_PROD].map((m) =>
      agentVerbRoute(m, agent({ definitionId: 1, activeBuildRunId: "b", activeBuildRunStatus: "ready" })),
    );
    for (const route of routes)
      expect(Object.keys(route).filter((key) => /session/i.test(key))).toEqual([]);
  });
});

describe("agentMacroFirstMessage: the tuned first message of a macro session", () => {
  it("names the agent and keeps the surface's text verbatim", () => {
    const text = `Walk me through the "intake" step of this agent.`;
    const message = agentMacroFirstMessage("ask", agent(), text);
    expect(message.startsWith(`Agent: "intake", at /work/proj/agents/intake\n`)).toBe(true);
    expect(message.endsWith(`\n\n${text}`)).toBe(true);
  });

  it("tunes the instruction to the job", () => {
    const lines = (["ask", "modify", "fix", "debug"] as const).map(
      (job) => agentMacroFirstMessage(job, agent(), "x").split("\n")[1],
    );
    expect(new Set(lines).size).toBe(4);
    expect(lines[0]).toContain("change no files");
    expect(lines[1]).toContain("before editing");
    expect(lines[2]).toContain("smallest change");
    expect(lines[3]).toContain("run details");
  });

  it("describe carries the describe prompt for this agent", () => {
    const message = agentMacroFirstMessage("describe", agent());
    expect(message).toContain(`Add human-readable descriptions to the "intake" agent`);
    expect(message).toContain("under /work/proj/agents/intake");
  });

  it("an empty text leaves no trailing blank body", () => {
    expect(agentMacroFirstMessage("fix", agent(), "  ").split("\n")).toHaveLength(2);
  });
});
