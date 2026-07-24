import { describe, expect, it } from "vitest";

import {
  GALLERY_TEMPLATES,
  STARTER_TEMPLATES,
  STUDIO_TEMPLATES,
  templateDirSuggestion,
  templateGraph,
  useTemplatePrompt,
} from "./templates";

describe("curated template index", () => {
  it("carries exactly the clonable gallery ids and bundled starter names", () => {
    // These ids are contracts, not fixtures: templateId must match the
    // registry (registry.json), starter ids must match the bundled template
    // directory names `sapiom agents init -t` resolves.
    expect(GALLERY_TEMPLATES.map((t) => t.id)).toEqual(["web-research-digest", "hello-agent"]);
    expect(STARTER_TEMPLATES.map((t) => t.id)).toEqual(["default", "coding-pause"]);
  });

  it("has unique ids across the whole index", () => {
    const ids = STUDIO_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps registry invariants: ordered steps, entry first, terminal exits marked", () => {
    for (const template of GALLERY_TEMPLATES) {
      expect(template.steps.length).toBeGreaterThan(0);
      // Every capability a step names must appear in the template's own list.
      for (const step of template.steps) {
        if (step.capability) expect(template.capabilities).toContain(step.capability);
      }
      // At least one exit — the schema requires a terminal step.
      expect(template.steps.some((step) => step.terminal === true)).toBe(true);
    }
  });

  it("never carries an em-dash into product copy", () => {
    expect(JSON.stringify(STUDIO_TEMPLATES)).not.toContain("—");
  });
});

describe("useTemplatePrompt", () => {
  it("gallery: names the real clone tool with dir and templateId, plus the auth fallback", () => {
    const prompt = useTemplatePrompt(GALLERY_TEMPLATES[0], "/tmp/web-research-digest");
    expect(prompt).toContain("sapiom_dev_agents_clone");
    expect(prompt).toContain('dir "/tmp/web-research-digest"');
    expect(prompt).toContain('templateId "web-research-digest"');
    expect(prompt).toContain("sapiom_authenticate");
  });

  it("starter: names the real init command with the bundled template flag", () => {
    const prompt = useTemplatePrompt(STARTER_TEMPLATES[1], "/tmp/coding-pause");
    expect(prompt).toContain("sapiom agents init . -t coding-pause");
  });

  it("both paths end with the free local test continuation (use to run is one path)", () => {
    for (const template of [GALLERY_TEMPLATES[0], STARTER_TEMPLATES[1]]) {
      expect(useTemplatePrompt(template, "/tmp/x")).toContain(
        "free local test run (sapiom_dev_agents_run_local)",
      );
    }
  });
});

describe("templateGraph", () => {
  it("projects the manifest faithfully: entry first, next pointers as edges, terminals marked", () => {
    const graph = templateGraph(GALLERY_TEMPLATES[0]); // web-research-digest
    expect(graph.entry).toBe("search");
    expect(graph.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual([
      "search:entry",
      "summarize:terminal-success",
    ]);
    expect(graph.nodes[0].capabilities).toEqual(["web.search"]);
    expect(graph.edges).toEqual([{ from: "search", to: "summarize", kind: "sequential", label: "" }]);
  });

  it("a single terminal step yields one node and no edges", () => {
    const graph = templateGraph(GALLERY_TEMPLATES[1]); // hello-agent
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].kind).toBe("terminal-success");
    expect(graph.edges).toEqual([]);
  });
});

describe("templateDirSuggestion", () => {
  it("joins the launch dir with the template id", () => {
    expect(templateDirSuggestion(GALLERY_TEMPLATES[1], "/Users/demo/acme-app")).toBe(
      "/Users/demo/acme-app/hello-agent",
    );
  });

  it("gives the 'default' starter a descriptive folder name", () => {
    expect(templateDirSuggestion(STARTER_TEMPLATES[0], "/Users/demo/acme-app")).toBe(
      "/Users/demo/acme-app/sapiom-agent",
    );
  });

  it("is empty without a launch dir (the field asks instead of guessing)", () => {
    expect(templateDirSuggestion(GALLERY_TEMPLATES[0], null)).toBe("");
  });
});
