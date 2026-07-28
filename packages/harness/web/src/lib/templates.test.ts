import { describe, expect, it } from "vitest";

import type { TemplateComplexity, TemplateDetailView, TemplateSummary } from "@shared/types";

import {
  STARTER_TEMPLATES,
  categoryLabel,
  complexityBasisParts,
  complexityBasisSummary,
  formatComplexity,
  groupByCategory,
  matchesQuery,
  templateDirSuggestion,
  templateGraph,
  useTemplatePrompt,
  type GalleryTemplate,
} from "./templates";

/** A complexity band as core would serve it. */
function complexity(over: Partial<TemplateComplexity> = {}): TemplateComplexity {
  return {
    score: 3,
    label: "Moderate",
    basis: {
      llmSteps: 1,
      chainedLlmSteps: 0,
      mediaCapabilities: 0,
      capabilityCount: 1,
      stepCount: 2,
      maxFanOut: 1,
    },
    ...over,
  };
}

/** A catalog summary as core would serve it. */
function summary(over: Partial<TemplateSummary> = {}): GalleryTemplate {
  return {
    kind: "gallery",
    id: "web-research-digest",
    name: "Web Research Digest",
    description: "Search the web for a topic and return a concise, sourced digest.",
    tags: ["research", "search"],
    category: "data-knowledge",
    cadence: "on-demand",
    stepCount: 2,
    capabilities: ["web.search"],
    complexity: complexity(),
    ...over,
  };
}

describe("bundled starters", () => {
  it("carries exactly the bundled template directory names `init -t` resolves", () => {
    // These ids are a contract with @sapiom/agent-core's templates/ dir, not
    // fixtures — unlike the gallery, they are NOT fetched.
    expect(STARTER_TEMPLATES.map((t) => t.id)).toEqual(["default", "coding-pause"]);
  });

  it("never carries an em dash into starter copy (house style)", () => {
    // Only the local copy can be held to this; catalog descriptions come from
    // the upstream registry verbatim.
    expect(JSON.stringify(STARTER_TEMPLATES)).not.toContain("—");
  });
});

describe("formatComplexity", () => {
  it("renders the band and its position on the scale", () => {
    expect(formatComplexity(complexity())).toBe("Moderate 3/5");
  });

  it("renders an em dash when the response carried no band, rather than throwing", () => {
    // Core types `complexity` required, so this is unreachable against a current
    // backend. It is NOT unreachable in the field: the Studio is published to
    // npm, so a copy can be pointed at a stack older than the field. One card
    // degrading beats the dialog crashing on an unguarded dereference.
    expect(formatComplexity(null)).toBe("—");
  });

  it("omits a score core did not send instead of printing 0/5", () => {
    // `0/5` would read as a real band at the bottom of the scale — the same
    // fabrication `$0.00` would have been for the cost this replaced.
    expect(formatComplexity(complexity({ score: 0 }))).toBe("Moderate");
  });
});

describe("complexityBasisParts", () => {
  it("leads with the signals that move the score and stays silent about the rest", () => {
    expect(
      complexityBasisParts(
        complexity({
          basis: {
            llmSteps: 2,
            chainedLlmSteps: 1,
            mediaCapabilities: 0,
            capabilityCount: 1,
            stepCount: 5,
            maxFanOut: 2,
          },
        }),
      ),
      // No "0 media generators" — a signal that contributed nothing is omitted.
    ).toBe("2 model steps, 1 chained, 5 steps, 1 capability");
  });

  it("names a wholly deterministic template as such", () => {
    // The reason an elaborate saga can score below a two-step pipeline, so it is
    // said outright rather than left to be inferred from an absence.
    expect(
      complexityBasisParts(
        complexity({
          label: "Simple",
          score: 2,
          basis: {
            llmSteps: 0,
            chainedLlmSteps: 0,
            mediaCapabilities: 0,
            capabilityCount: 2,
            stepCount: 7,
            maxFanOut: 5,
          },
        }),
      ),
    ).toBe("7 steps, 2 capabilities · deterministic");
  });

  it("counts media generators, which carry weight without being model steps", () => {
    expect(
      complexityBasisParts(
        complexity({
          basis: {
            llmSteps: 1,
            chainedLlmSteps: 0,
            mediaCapabilities: 1,
            capabilityCount: 3,
            stepCount: 5,
            maxFanOut: 1,
          },
        }),
      ),
    ).toBe("1 model step, 1 media generator, 5 steps, 3 capabilities");
  });
});

describe("complexityBasisSummary", () => {
  it("prefixes the label for a standalone tooltip, matching the dashboard's sentence", () => {
    // The card's tooltip has no band rendered beside it, so unlike the detail
    // pane's line it must name the band itself.
    expect(complexityBasisSummary(complexity())).toBe("Moderate: 1 model step, 2 steps, 1 capability");
  });
});

describe("categoryLabel", () => {
  it("maps known registry ids to the dashboard's labels", () => {
    expect(categoryLabel("revenue-marketing")).toBe("Revenue and marketing");
    expect(categoryLabel("finance-legal-people")).toBe("Finance, legal and people");
  });

  it("humanizes an unknown id rather than dropping it (the taxonomy is upstream)", () => {
    expect(categoryLabel("brand-new-axis")).toBe("Brand new axis");
  });

  it("names the absent category", () => {
    expect(categoryLabel(null)).toBe("Uncategorised");
  });
});

describe("groupByCategory", () => {
  it("orders known categories as the dashboard sidebar does, starters first", () => {
    const groups = groupByCategory([
      summary({ id: "a", category: "revenue-marketing" }),
      summary({ id: "b", category: "starter" }),
      summary({ id: "c", category: "product-engineering" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["starter", "product-engineering", "revenue-marketing"]);
  });

  it("sorts an unknown category after the known ones and uncategorised last", () => {
    const groups = groupByCategory([
      summary({ id: "a", category: null }),
      summary({ id: "b", category: "zzz-unknown" }),
      summary({ id: "c", category: "starter" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["starter", "zzz-unknown", null]);
  });

  it("keeps every template — grouping never drops a card", () => {
    const templates = [
      summary({ id: "a", category: "starter" }),
      summary({ id: "b", category: "starter" }),
      summary({ id: "c", category: null }),
    ];
    const total = groupByCategory(templates).reduce((sum, g) => sum + g.templates.length, 0);
    expect(total).toBe(3);
  });
});

describe("matchesQuery", () => {
  it("matches on name, tag, and capability, case-insensitively", () => {
    const template = summary();
    expect(matchesQuery(template, "RESEARCH")).toBe(true); // tag
    expect(matchesQuery(template, "web.search")).toBe(true); // capability
    expect(matchesQuery(template, "digest")).toBe(true); // name
    expect(matchesQuery(template, "kubernetes")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(matchesQuery(summary(), "   ")).toBe(true);
    expect(matchesQuery(STARTER_TEMPLATES[0], "")).toBe(true);
  });
});

describe("useTemplatePrompt", () => {
  it("gallery: names the real clone tool with dir and templateId, plus the auth fallback", () => {
    const prompt = useTemplatePrompt(summary(), "/tmp/web-research-digest");
    expect(prompt).toContain("sapiom_dev_agents_clone");
    expect(prompt).toContain('dir "/tmp/web-research-digest"');
    expect(prompt).toContain('templateId "web-research-digest"');
    expect(prompt).toContain("sapiom_authenticate");
  });

  it("works for any catalog id, not just the two once pinned in this module", () => {
    // clone's templateId is relayed to core's fork endpoint with no allowlist,
    // which is why fetching the full catalog needed no other change.
    const prompt = useTemplatePrompt(summary({ id: "cold-outreach-engine" }), "/tmp/x");
    expect(prompt).toContain('templateId "cold-outreach-engine"');
  });

  it("starter: names the real init command with the bundled template flag", () => {
    const prompt = useTemplatePrompt(STARTER_TEMPLATES[1], "/tmp/coding-pause");
    expect(prompt).toContain("sapiom agents init . -t coding-pause");
  });

  it("both paths end with the free local test continuation (use to run is one path)", () => {
    for (const template of [summary(), STARTER_TEMPLATES[1]]) {
      expect(useTemplatePrompt(template, "/tmp/x")).toContain(
        "free local test run (sapiom_dev_agents_run_local)",
      );
    }
  });
});

describe("templateGraph", () => {
  /** A detail payload as core serves it: steps plus explicit transitions. */
  function detail(over: Partial<TemplateDetailView> = {}): TemplateDetailView {
    const { kind: _kind, ...base } = summary();
    return {
      ...base,
      whatItDoes: "Searches and summarizes.",
      sourcePath: "examples/web-research-digest",
      steps: [
        { name: "search", description: "Query the web.", capabilities: ["web.search"], kind: "entry", sublabel: "entry" },
        {
          name: "summarize",
          description: "Condense the results.",
          capabilities: [],
          kind: "terminal-success",
          sublabel: "terminal · success",
        },
      ],
      transitions: [{ from: "search", to: "summarize", label: null, kind: "continue" as const }],
      author: { name: "Sapiom", url: "https://sapiom.ai/" },
      useCases: [],
      notes: null,
      examples: [],
      requiredSecrets: [],
      ...over,
    };
  }

  it("projects core's graph faithfully: entry first, transitions as edges, terminals marked", () => {
    const graph = templateGraph(detail());
    expect(graph.entry).toBe("search");
    expect(graph.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(["search:entry", "summarize:terminal-success"]);
    expect(graph.nodes[0].capabilities).toEqual(["web.search"]);
    expect(graph.edges).toEqual([{ from: "search", to: "summarize", kind: "sequential", label: "" }]);
  });

  it("a single terminal step yields one node and no edges", () => {
    const graph = templateGraph(
      detail({
        steps: [
          {
            name: "greet",
            description: "Say hi.",
            capabilities: [],
            kind: "terminal-success",
            sublabel: "terminal · success",
          },
        ],
        transitions: [],
      }),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].kind).toBe("terminal-success");
    expect(graph.edges).toEqual([]);
  });

  it("marks a fan-out as branching and preserves each exit's own kind", () => {
    // The pinned copy could not express this: it inferred edges from array
    // order, and had one terminal kind for every exit.
    const graph = templateGraph(
      detail({
        steps: [
          { name: "check", description: null, capabilities: [], kind: "entry", sublabel: "entry" },
          { name: "approve", description: null, capabilities: [], kind: "terminal-success", sublabel: "terminal · success" },
          { name: "reject", description: null, capabilities: [], kind: "terminal-warn", sublabel: "terminal · needs attention" },
        ],
        transitions: [
          { from: "check", to: "approve", label: null, kind: "continue" as const },
          { from: "check", to: "reject", label: null, kind: "continue" as const },
        ],
      }),
    );
    expect(graph.edges).toEqual([
      { from: "check", to: "approve", kind: "branching", label: "" },
      { from: "check", to: "reject", kind: "branching", label: "" },
    ]);
    // Kinds come straight from the server-side classifier — a fail-only exit
    // stays amber rather than being flattened into the success dot.
    expect(graph.nodes.map((n) => n.kind)).toEqual(["entry", "terminal-success", "terminal-warn"]);
  });
});

describe("templateDirSuggestion", () => {
  it("joins the launch dir with the template id", () => {
    expect(templateDirSuggestion(summary({ id: "hello-agent" }), "/Users/demo/acme-app")).toBe(
      "/Users/demo/acme-app/hello-agent",
    );
  });

  it("gives the 'default' starter a descriptive folder name", () => {
    expect(templateDirSuggestion(STARTER_TEMPLATES[0], "/Users/demo/acme-app")).toBe(
      "/Users/demo/acme-app/sapiom-agent",
    );
  });

  it("is empty without a launch dir (the field asks instead of guessing)", () => {
    expect(templateDirSuggestion(summary(), null)).toBe("");
  });
});
