import { describe, expect, it } from "vitest";

import { PROJECT_AGENT_PROMPT_APPENDIX } from "./project-agent.js";

describe("project-agent operating guidance", () => {
  const prompt = PROJECT_AGENT_PROMPT_APPENDIX;

  it("keeps delivery primary and project coordination out of the approval path", () => {
    expect(prompt).toContain("Building, testing, and delivering the requested agent is the primary task");
    expect(prompt).toContain("no role, approval, confirmation, or mode transition");
    expect(prompt).toContain("clear initial request");
  });

  it("distinguishes the shared map from automatic per-agent rendering", () => {
    expect(prompt).toContain("agent-map");
    expect(prompt).toContain("not the automatically rendered per-agent Canvas");
    expect(prompt).toContain("does not update itself from code edits");
    expect(prompt).toContain("summary.md");
    expect(prompt).toContain("Before reporting completion");
  });

  it("teaches discovery, empty-map creation, and conflict-safe persistence", () => {
    expect(prompt).toContain("discover their schemas");
    expect(prompt).toContain("proposalId: null");
    expect(prompt).toContain("expectedVersion: 0");
    expect(prompt).toContain("draftRef");
    expect(prompt).toContain("agent_map_validate");
    expect(prompt).toContain("agent_map_propose");
    expect(prompt).toContain("Re-read and reconcile");
  });

  it("covers the plan lifecycle without requiring a plan for small edits", () => {
    for (const name of ["build_plan_read", "build_plan_validate", "build_plan_apply",
      "build_plan_rebase", "build_plan_brief_refresh"]) expect(prompt).toContain(name);
    expect(prompt).toContain("Small edits do not need a new plan");
    expect(prompt).toContain('kind: "current"');
  });

  it("describes writable delegation and its actual completion boundary", () => {
    expect(prompt).toContain("project_subsession_delegate");
    expect(prompt).toContain("share the working directory");
    expect(prompt).toContain("not completed work");
    expect(prompt).toContain("Never relabel, close");
    expect(prompt).toContain("release-dormant");
  });
});
