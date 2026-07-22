/**
 * The Studio's curated template index (templates journey v0).
 *
 * Provenance: the gallery entries are pinned copies of the harness source's
 * in-repo registry at origin/main f0e3406 (harness 0.1.4) — every field below
 * comes verbatim from `examples/registry.json` plus each example's
 * `template.json` detail manifest, with punctuation normalized to house style
 * (em-dashes become colons or commas; one upstream typo fixed). The starters
 * are the two templates bundled with `@sapiom/agent-core` (`templates/
 * {default,coding-pause}`), described with the wording the scaffold MCP tool
 * itself ships.
 *
 * WHY a pin and not a fetch: no listing API, MCP tool, or CLI command exposes
 * the gallery to any client today — the registry is read server-side by the
 * Sapiom backend for the dashboard only. This
 * module is the swap point: when a listing endpoint ships, a fetch of the
 * same shape replaces these constants without touching the dialog.
 *
 * Both "use" paths are real operations, driven through the session's agent:
 * - Gallery: the `sapiom_dev_agents_clone` MCP tool (`{dir, templateId}`)
 *   forks the template into a repo the user owns, clones it, and writes
 *   `sapiom.json` provenance. Needs a signed-in Sapiom account.
 * - Starters: `sapiom agents init <dir> -t <name>` scaffolds offline from
 *   the bundled template. No account, no network.
 */
import type { CanvasGraph } from "./canvas-graph";

export interface TemplateStep {
  name: string;
  description: string;
  /** Dotted capability catalog id (e.g. "web.search"); absent = unmetered. */
  capability?: string;
  /** Successor step names; array order in `steps` is execution order. */
  next?: string[];
  terminal?: boolean;
}

export interface TemplateExample {
  title: string;
  input: unknown;
  output: unknown;
}

/** A registry entry + its template.json detail, pinned (see module header). */
export interface GalleryTemplate {
  kind: "gallery";
  /** Stable gallery id — the `templateId` the clone tool takes. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Path inside the harness repo; consumed by the fork handoff server-side. */
  sourcePath: string;
  /** Dotted capability ids. Drives the backend's per-run cost estimate,
   *  which no client surface exposes yet. */
  capabilities: string[];
  whatItDoes: string;
  steps: TemplateStep[];
  author: { name: string; url: string };
  useCases: string[];
  /** Markdown. */
  notes: string;
  examples: TemplateExample[];
}

/** A template bundled with @sapiom/agent-core — scaffolds offline. */
export interface StarterTemplate {
  kind: "starter";
  /** The bundled template directory name — what `init -t` takes. */
  id: string;
  name: string;
  description: string;
}

export type StudioTemplate = GalleryTemplate | StarterTemplate;

/** What the curated gallery is pinned to — named in the dialog's note. */
export const TEMPLATES_PIN = { harnessVersion: "0.1.4", ref: "f0e3406" };

export const GALLERY_TEMPLATES: GalleryTemplate[] = [
  {
    kind: "gallery",
    id: "web-research-digest",
    name: "Web Research Digest",
    description: "Search the web for a topic and return a concise, sourced digest.",
    tags: ["research", "search"],
    sourcePath: "examples/web-research-digest",
    capabilities: ["web.search"],
    whatItDoes:
      "Takes a topic, runs a web search through the Sapiom search capability, then condenses the top results into a short digest with source links. A legible \"it did a thing\" flagship: one metered capability, an obvious output.",
    steps: [
      {
        name: "search",
        description: "Query the web for the topic.",
        capability: "web.search",
        next: ["summarize"],
      },
      {
        name: "summarize",
        description: "Condense the results into a sourced digest.",
        terminal: true,
      },
    ],
    author: { name: "Sapiom", url: "https://sapiom.ai/" },
    useCases: [
      "Get a quick, sourced briefing on an unfamiliar topic before a meeting.",
      "Turn a research question into a shareable markdown digest with citations.",
      "Learn how to wire a single capability into an agent you can extend.",
    ],
    notes:
      "`run_local` stubs the `web.search` capability, so you can trace the full graph offline before deploying. A real `deploy` + `run` performs a live web search.\n\nTo extend it, add a step after `summarize`, e.g. store the digest with `ctx.sapiom.memory.*`, or fan out one search per subtopic. `AGENTS.md` in this directory has the authoring loop.",
    examples: [
      {
        title: "Research an unfamiliar term",
        input: { topic: "what is an LLM agent?" },
        output: {
          topic: "what is an LLM agent?",
          digest:
            "# Research digest: what is an LLM agent?\n\nAn LLM agent is a system that uses a large language model to decide and take actions...\n\n## Sources\n1. [What are LLM agents?](https://example.com/llm-agents)\n2. [Agents overview](https://example.com/agents-overview)",
          sources: [
            { title: "What are LLM agents?", url: "https://example.com/llm-agents" },
            { title: "Agents overview", url: "https://example.com/agents-overview" },
          ],
        },
      },
    ],
  },
  {
    kind: "gallery",
    id: "hello-agent",
    name: "Hello Agent",
    description: "The minimal single-step agent: a smoke test for the build, deploy, run path.",
    tags: ["starter", "minimal"],
    sourcePath: "examples/hello-agent",
    capabilities: [],
    whatItDoes:
      "Validates an input name and returns a greeting. The smallest valid definition: use it to confirm your MCP install and deploy path work end to end before reaching for a capability.",
    steps: [
      {
        name: "greet",
        description: "Validate the input and return a greeting.",
        terminal: true,
      },
    ],
    author: { name: "Sapiom", url: "https://sapiom.ai/" },
    useCases: [
      "Confirm your MCP install and deploy path work before building something real.",
      "Start from the smallest valid definition and grow it one step at a time.",
    ],
    notes:
      "No capabilities, so `run_local` and a real `run` behave identically and cost nothing. Once this deploys and runs cleanly, fork a capability-backed template (e.g. Web Research Digest) for the real thing. See `AGENTS.md` for the authoring loop.",
    examples: [
      { title: "Greet a name", input: { name: "Ada" }, output: { greeting: "Hello, Ada!" } },
      { title: "Default greeting", input: {}, output: { greeting: "Hello, world!" } },
    ],
  },
];

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

export const STUDIO_TEMPLATES: StudioTemplate[] = [...GALLERY_TEMPLATES, ...STARTER_TEMPLATES];

/**
 * The prompt handed to the session's agent after "Use template" starts a
 * session in the destination folder. Both branches name the REAL operation:
 * the clone MCP tool for gallery templates (with its auth failure path), the
 * bundled-template init command for starters — mirroring the scaffold prompt
 * App.tsx already ships for the blank-project path. Both end with the same
 * single next move (a free local test run), so use → edit → run is one
 * continuous path instead of a journey that stops at the clone.
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
 * A gallery template's steps as a CanvasGraph, so the dialog can preview the
 * step structure with the same vocabulary the canvas projections use (kind
 * dots, elbow transitions). Pure projection of the pinned manifest: array
 * order is execution order, the first step is the entry, `next` names the
 * successors (falling back to the next listed step), `terminal` marks exits.
 * Nothing is invented — steps without a capability stay unmetered, and
 * conditions do not exist in the manifest so no edge carries a label.
 */
export function templateGraph(template: GalleryTemplate): CanvasGraph {
  const nodes: CanvasGraph["nodes"] = template.steps.map((step, index) => ({
    id: step.name,
    kind: step.terminal ? "terminal-success" : index === 0 ? "entry" : "step",
    label: step.name,
    role: step.terminal ? "terminal" : index === 0 ? "entry" : "step",
    description: step.description,
    timeoutMs: null,
    inputSchema: null,
    capabilities: step.capability ? [step.capability] : [],
  }));
  const edges: CanvasGraph["edges"] = [];
  template.steps.forEach((step, index) => {
    const successors = step.next ?? (template.steps[index + 1] && !step.terminal ? [template.steps[index + 1].name] : []);
    for (const next of successors) {
      edges.push({ from: step.name, to: next, kind: successors.length > 1 ? "branching" : "sequential", label: "" });
    }
  });
  return {
    name: template.name,
    entry: template.steps[0]?.name ?? "",
    nodes,
    edges,
    groups: [],
    warnings: [],
  };
}

/** Default destination: a new folder named after the template, under the
 *  launch dir. "default" would make a meaningless folder name, so it gets a
 *  descriptive one instead. */
export function templateDirSuggestion(template: StudioTemplate, launchDir: string | null): string {
  const folder = template.kind === "starter" && template.id === "default" ? "sapiom-agent" : template.id;
  return launchDir ? `${launchDir}/${folder}` : "";
}
