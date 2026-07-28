/**
 * The Studio's template index — two sources, deliberately different in kind.
 *
 * **Gallery** templates come from the LIVE catalog: `GET /api/templates`, which
 * the harness server relays from core's `GET /v1/workflows/templates` (the same
 * endpoint the dashboard's Template library renders). This module used to ship a
 * hardcoded pin of two entries because no listing API existed; it does now, and
 * the pin was the reason the Studio showed 2 templates while the app showed 26.
 * There is no local copy of the gallery any more — a stale copy IS the bug.
 *
 * **Starters** stay local, and should: they are the templates bundled with
 * `@sapiom/agent-core` (`templates/{default,coding-pause}`), scaffolded by
 * `sapiom agents init -t <name>` with no account and no network. They are the
 * offline floor — what the dialog can still offer when the catalog is
 * unreachable — so describing them from the package is correct, not a shortcut.
 *
 * Both "use" paths are real operations driven through the session's agent:
 * - Gallery: `sapiom_dev_agents_clone` (`{dir, templateId}`) forks the template
 *   into a repo the user owns, clones it, and writes `sapiom.json` provenance.
 *   Its `templateId` is a free-form string relayed to core's fork endpoint — no
 *   allowlist — so every catalog id works, not just the two once pinned here.
 * - Starters: `sapiom agents init <dir> -t <name>`, offline.
 */
import type { TemplateComplexity, TemplateDetailView, TemplateSummary } from "@shared/types";

import type { CanvasGraph } from "./canvas-graph";

/** A live catalog entry. `kind` discriminates it from a bundled starter. */
export type GalleryTemplate = TemplateSummary & { kind: "gallery" };

/** A template bundled with @sapiom/agent-core — scaffolds offline. */
export interface StarterTemplate {
  kind: "starter";
  /** The bundled template directory name — what `init -t` takes. */
  id: string;
  name: string;
  description: string;
}

export type StudioTemplate = GalleryTemplate | StarterTemplate;

/**
 * The bundled starters. Wording is the scaffold tool's own, so the dialog never
 * claims more about them than the CLI does.
 */
export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    kind: "starter",
    id: "default",
    name: "Default starter",
    description: "A minimal two-step starter.",
  },
  {
    kind: "starter",
    id: "coding-pause",
    name: "Coding pause",
    description: "The launch + pauseUntilSignal + resume pattern for a non-blocking coding-agent run.",
  },
];

/**
 * Display labels for the registry's outcome-axis category ids. The taxonomy is
 * owned by the sapiom-js registry, so an id we don't recognise falls back to a
 * humanized form of the id itself rather than being dropped — same contract the
 * dashboard follows. Labels match the dashboard's Template library sidebar.
 */
const CATEGORY_LABELS: Record<string, string> = {
  starter: "Starter",
  "product-engineering": "Product and engineering",
  "reliability-governance": "Reliability and governance",
  "revenue-marketing": "Revenue and marketing",
  "customer-experience": "Customer experience",
  "data-knowledge": "Data and knowledge",
  "finance-legal-people": "Finance, legal and people",
};

export function categoryLabel(category: string | null): string {
  if (!category) return "Uncategorised";
  return (
    CATEGORY_LABELS[category] ??
    category.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * Group the catalog by category for the dialog's list, ordered to match the
 * dashboard's sidebar (`starter` first — it is the on-ramp), with unknown
 * categories after the known ones and `Uncategorised` last.
 */
const CATEGORY_ORDER = [
  "starter",
  "product-engineering",
  "reliability-governance",
  "revenue-marketing",
  "customer-experience",
  "data-knowledge",
  "finance-legal-people",
];

export function groupByCategory(
  templates: GalleryTemplate[],
): Array<{ category: string | null; label: string; templates: GalleryTemplate[] }> {
  const buckets = new Map<string, GalleryTemplate[]>();
  for (const template of templates) {
    const key = template.category ?? "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(template);
    else buckets.set(key, [template]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      // "" (uncategorised) sorts last; known ids keep the dashboard's order;
      // unknown-but-present ids sort alphabetically between the two.
      if (a === "") return 1;
      if (b === "") return -1;
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([key, group]) => ({
      category: key === "" ? null : key,
      label: categoryLabel(key === "" ? null : key),
      templates: group,
    }));
}

/**
 * A template's complexity band for the card: `Moderate 3/5`.
 *
 * Text only, no meter or dots — matching the dashboard's gallery, whose icon
 * policy is that nothing keyed off a template's own data gets a glyph. The label
 * carries the meaning and the `n/5` carries the ordering.
 *
 * The em dash is the absent-payload guard, not a band: core serves a band for
 * every template, so this only fires against a backend that predates the field
 * (see `TemplateSummary.complexity`). A score core did not send is omitted rather
 * than printed as `0/5`, which would read as a real band at the bottom of the
 * scale — the same mistake `$0.00` would have been for the cost this replaced.
 */
export function formatComplexity(complexity: TemplateComplexity | null): string {
  if (!complexity?.label) return "—";
  return complexity.score > 0 ? `${complexity.label} ${complexity.score}/5` : complexity.label;
}

/**
 * What drove this template's band, in the user's terms — the band is a rough
 * estimate, and saying what produced it is what keeps it honest rather than an
 * opaque verdict.
 *
 * Ordered by how much each signal moves the score, and silent about signals that
 * contributed nothing. Bare phrase, no label: the detail pane already renders the
 * band beside it, and repeating "Moderate" twice in one sentence reads as a bug.
 */
export function complexityBasisParts(complexity: TemplateComplexity): string {
  const { basis } = complexity;
  const parts: string[] = [];
  if (basis.llmSteps > 0) {
    parts.push(`${basis.llmSteps} model ${basis.llmSteps === 1 ? "step" : "steps"}`);
  }
  if (basis.chainedLlmSteps > 0) {
    parts.push(`${basis.chainedLlmSteps} chained`);
  }
  if (basis.mediaCapabilities > 0) {
    parts.push(`${basis.mediaCapabilities} media ${basis.mediaCapabilities === 1 ? "generator" : "generators"}`);
  }
  parts.push(`${basis.stepCount} ${basis.stepCount === 1 ? "step" : "steps"}`);
  if (basis.capabilityCount > 0) {
    parts.push(`${basis.capabilityCount} ${basis.capabilityCount === 1 ? "capability" : "capabilities"}`);
  }
  // No model call and no media means the run is fully deterministic — worth
  // saying outright, because it is why an elaborate saga can score below a
  // two-step pipeline.
  const suffix = basis.llmSteps === 0 && basis.mediaCapabilities === 0 ? " · deterministic" : "";
  return `${parts.join(", ")}${suffix}`;
}

/**
 * The label-prefixed form, for a standalone tooltip with no band rendered beside
 * it. Mirrors the dashboard's `complexityBasisSummary` so the Studio and the
 * Template library explain a band with the same sentence.
 */
export function complexityBasisSummary(complexity: TemplateComplexity): string {
  return `${complexity.label}: ${complexityBasisParts(complexity)}`;
}

/** Case-insensitive match over the fields a user would search by. */
export function matchesQuery(template: StudioTemplate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    template.name,
    template.description,
    template.id,
    ...(template.kind === "gallery" ? template.tags : []),
    ...(template.kind === "gallery" ? template.capabilities : []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * The prompt handed to the session's agent after "Use template" starts a session
 * in the destination folder. Both branches name the REAL operation: the clone
 * MCP tool for gallery templates (with its auth failure path), the bundled
 * template init command for starters. Both end with the same next move (a free
 * local test run), so use → edit → run is one continuous path rather than a
 * journey that stops at the clone.
 */
export function useTemplatePrompt(template: StudioTemplate, dir: string): string {
  const runContinuation =
    "When the project is ready, offer a free local test run (sapiom_dev_agents_run_local) as the next step.";
  if (template.kind === "gallery") {
    return (
      `Clone the Sapiom gallery template "${template.id}" into this directory: ` +
      `call the sapiom_dev_agents_clone tool with dir "${dir}" and templateId "${template.id}". ` +
      "If it reports you are not authenticated, run sapiom_authenticate first and retry. " +
      "After the clone, read the project's AGENTS.md and run npm install. " +
      runContinuation
    );
  }
  return (
    `Scaffold the "${template.id}" starter in this directory: ` +
    `run \`sapiom agents init . -t ${template.id}\`, then run npm install and read AGENTS.md. ` +
    "Use the sapiom-agent-authoring skill to adapt the workflow. " +
    runContinuation
  );
}

/**
 * A template's declared graph as a CanvasGraph, so the dialog previews step
 * structure in the same vocabulary the canvas projections use (kind dots, elbow
 * transitions). Pure projection of what core served — core expands the registry's
 * step list into definition graph shapes server-side, so `transitions` are
 * authoritative here rather than inferred from array order as the old pinned
 * copy had to do. Steps with no capability stay unmetered; a guarded transition
 * carries its condition label.
 */
export function templateGraph(detail: TemplateDetailView): CanvasGraph {
  const nodes: CanvasGraph["nodes"] = detail.steps.map((step) => ({
    id: step.name,
    // The kind is CLASSIFIED SERVER-SIDE by the same `classifyStepKind` the
    // canvas uses (see core/template-catalog.ts). Re-deriving it here — or
    // reducing it to terminal-vs-not — is what made a fail-only sink render as
    // a green success exit.
    kind: step.kind as CanvasGraph["nodes"][number]["kind"],
    label: step.name,
    role: step.kind.startsWith("terminal") ? "terminal" : step.kind === "entry" ? "entry" : "step",
    description: step.description ?? "",
    timeoutMs: null,
    inputSchema: null,
    capabilities: step.capabilities,
  }));
  // Branch styling counts only CONTINUE fan-out, matching the canvas: a pause
  // edge is a `cross`, and it never turns its siblings into a branch.
  const continueOutDegree = new Map<string, number>();
  for (const edge of detail.transitions) {
    if (edge.kind !== "continue") continue;
    continueOutDegree.set(edge.from, (continueOutDegree.get(edge.from) ?? 0) + 1);
  }
  const edges: CanvasGraph["edges"] = detail.transitions.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind:
      edge.kind === "pause"
        ? "cross"
        : (continueOutDegree.get(edge.from) ?? 0) > 1
          ? "branching"
          : "sequential",
    label: edge.label ?? "",
  }));
  return {
    name: detail.name,
    entry: detail.steps.find((s) => s.kind === "entry")?.name ?? detail.steps[0]?.name ?? "",
    nodes,
    edges,
    groups: [],
    warnings: [],
  };
}

/** Default destination: a new folder named after the template, under the launch
 *  dir. "default" would make a meaningless folder name, so it gets a
 *  descriptive one instead. */
export function templateDirSuggestion(template: StudioTemplate, launchDir: string | null): string {
  const folder = template.kind === "starter" && template.id === "default" ? "sapiom-agent" : template.id;
  return launchDir ? `${launchDir}/${folder}` : "";
}
