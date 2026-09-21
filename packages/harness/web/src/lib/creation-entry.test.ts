import { describe, expect, it } from "vitest";

import {
  AGENT_AUTHORING_SKILL,
  deriveAgentName,
  planningInstructions,
  templateIdea,
} from "./creation-entry";

describe("deriveAgentName", () => {
  it("keeps the first two content words, kebab-cased", () => {
    expect(
      deriveAgentName(
        "Build an agent that watches my competitors and sends a sourced digest every Monday.",
      ),
    ).toBe("competitors-digest");
  });

  it("drops the verbs an idea is phrased with and -ed adjectives", () => {
    expect(deriveAgentName("Triage incoming support tickets by urgency")).toBe(
      "incoming-support",
    );
    expect(deriveAgentName("Write a personalized first line for each lead")).toBe(
      "line-lead",
    );
  });

  it("returns an empty name when nothing usable is left, for the server to refuse", () => {
    expect(deriveAgentName("Build an agent")).toBe("");
    expect(deriveAgentName("   ")).toBe("");
  });

  it("never emits a character the server would refuse as a folder name", () => {
    expect(deriveAgentName("Sync ../secrets/*.env to S3!")).toMatch(
      /^[a-z0-9-]*$/,
    );
  });
});

describe("planningInstructions", () => {
  const text = planningInstructions({
    agentName: "competitors-digest",
    projectLabel: "acme-app",
  });

  it("says the scaffold is done and never asks for one", () => {
    expect(text).toContain("already scaffolded");
    expect(text).toContain("do not scaffold or clone it again");
    expect(text).not.toContain("sapiom_dev_agents_scaffold");
  });

  it("orders the planning steps: read, restate, ask (at most three, with defaults, then stop), framings when thin, propose, go, skill, gates", () => {
    const order = [
      "Read every attached file and linked source",
      "Restate the outcome and the proof of success in two lines",
      "at most three clarifying questions",
      "stop for my answer",
      "ask nothing and say so",
      "three framings",
      "Propose the shape in this conversation",
      "Build only after I say go",
      AGENT_AUTHORING_SKILL,
      "sapiom_dev_agents_check and sapiom_dev_agents_run_local before calling anything built",
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = text.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("does not mention the Agent Map (out of scope for this batch, Q11)", () => {
    expect(text.toLowerCase()).not.toContain("agent map");
  });

  it("names a gallery template as the starting point to bring in at build time", () => {
    const withTemplate = planningInstructions({
      agentName: "research-digest",
      projectLabel: "acme-app",
      template: {
        kind: "gallery",
        id: "web-research-digest",
        name: "Web research digest",
        description: "Search and publish.",
        category: null,
        tags: [],
        capabilities: [],
        stepCount: 3,
        complexity: null,
      } as never,
    });
    expect(withTemplate).toContain('templateId "web-research-digest"');
    expect(withTemplate).toContain("sapiom_dev_agents_clone");
  });
});

describe("templateIdea", () => {
  it("phrases the template as the idea, editable before send", () => {
    expect(
      templateIdea({
        kind: "starter",
        id: "coding-pause",
        name: "Coding pause",
        description: "The launch + pauseUntilSignal + resume pattern.",
      }),
    ).toBe(
      "Start from the Coding pause template. The launch + pauseUntilSignal + resume pattern.",
    );
  });
});
