import { describe, expect, it } from "vitest";

import type { TemplateDetailView, TemplateSummary } from "@shared/types";

import {
  STARTER_TEMPLATES,
  categoryLabel,
  formatEstCost,
  groupByCategory,
  matchesQuery,
  templateDirSuggestion,
  templateGraph,
  useTemplatePrompt,
  type GalleryTemplate,
} from "./templates";

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
    estCostPerRunUsd: 0.006,
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

describe("formatEstCost", () => {
  it("renders an em dash when core reports no estimate — never $0.00", () => {
    // The majority case upstream (21 of 26 templates). Rendering $0.00 would
    // assert a genuinely free run, which is a different and false claim.
    expect(formatEstCost(null)).toBe("—");
  });

  it("keeps sub-cent estimates legible instead of rounding them to zero", () => {
    expect(formatEstCost(0.006)).toBe("$0.0060");
  });

  it("renders ordinary amounts to cents, and a true zero as $0", () => {
    expect(formatEstCost(0.42)).toBe("$0.42");
    expect(formatEstCost(0)).toBe("$0");
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
        { name: "search", description: "Query the web.", capabilities: ["web.search"], terminal: false },
        { name: "summarize", description: "Condense the results.", capabilities: [], terminal: true },
      ],
      transitions: [{ from: "search", to: "summarize", label: null }],
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
        steps: [{ name: "greet", description: "Say hi.", capabilities: [], terminal: true }],
        transitions: [],
      }),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].kind).toBe("terminal-success");
    expect(graph.edges).toEqual([]);
  });

  it("marks a fan-out as branching and carries a guarded transition's label", () => {
    // The pinned copy could not express this: it inferred edges from array
    // order. Core serves real transitions, conditions included.
    const graph = templateGraph(
      detail({
        steps: [
          { name: "check", description: null, capabilities: [], terminal: false },
          { name: "approve", description: null, capabilities: [], terminal: true },
          { name: "reject", description: null, capabilities: [], terminal: true },
        ],
        transitions: [
          { from: "check", to: "approve", label: "score > 0.8" },
          { from: "check", to: "reject", label: null },
        ],
      }),
    );
    expect(graph.edges).toEqual([
      { from: "check", to: "approve", kind: "branching", label: "score > 0.8" },
      { from: "check", to: "reject", kind: "branching", label: "" },
    ]);
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
