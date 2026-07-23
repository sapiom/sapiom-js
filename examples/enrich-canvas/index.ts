import {
  defineAgent,
  defineStep,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * enrich-canvas — the harness's Tier-2 canvas enrichment, run on OUR account.
 *
 * This is the Sapiom-owned replacement for the token-burning headless-`claude`
 * enrichment the studio used to spawn on the user's own Claude Code tokens. The
 * harness renders a deterministic Tier-1 structure diagram offline (zero LLM,
 * unkillable); this workflow is the opt-in Tier-2 overlay: given the already
 * extracted graph plus the workflow's source bodies, one LLM step returns short
 * text annotations (labels / summary / notes) as a single JSON object. It runs
 * on Sapiom's account, so it is metered by us — the user spends 0 Claude tokens.
 *
 * Contract — the returned object is validated by the harness against
 * `CanvasEnrichment` (packages/harness/src/core/canvas-enrichment.ts). The
 * harness discards the whole thing on any schema violation and the Tier-1 base
 * render stands, so this step never needs to be strict: it returns its best
 * effort and lets the harness be the hard line. Invalid / unparseable model
 * output degrades to an empty enrichment (`{}`), never a failure the pane shows.
 *
 * WHY graph + bodies come in as INPUT (not read from disk): the harness has the
 * filesystem, this workflow does not. The harness extracts the graph and reads
 * the step source bodies, then passes both as the run input — this workflow
 * needs no filesystem access at all.
 */

/**
 * Enrichment length caps. These MUST stay in sync with `ENRICHMENT_LIMITS` in
 * packages/harness/src/core/canvas-enrichment.ts — the harness re-validates
 * against those exact caps and clamps a few-words-over string rather than
 * rejecting, but stating them here keeps a well-behaved run comfortably inside
 * the schema so nothing gets truncated mid-sentence.
 */
const LIMITS = {
  summary: 160,
  sublabel: 48,
  description: 120,
  edgeLabel: 32,
  noteCount: 3,
  note: 140,
  groupLabel: 48,
  crossWorkflow: 160,
} as const;

/** Ceiling on the model's output — the contract is a handful of short strings,
 *  so a small budget is plenty and keeps a runaway answer bounded. */
const MAX_OUTPUT_TOKENS = 1500;

/** The run input: the extracted graph and the workflow's own source bodies,
 *  keyed by workflow-relative file path (the step `run()` bodies live here). */
interface EnrichCanvasInput extends Record<string, unknown> {
  graph: unknown;
  stepBodies?: Record<string, string>;
}

/**
 * Build the one-shot enrichment prompt: the extracted graph inline (the model
 * annotates THIS structure — it never invents nodes) plus the workflow's source
 * bodies for semantics, with the JSON contract and its hard limits stated
 * verbatim so a well-behaved run needs no retry. Mirrors the prompt the
 * headless enrichment used, minus the "read files / don't write files"
 * filesystem language — this workflow has neither the files nor the ability to
 * write them.
 */
function buildEnrichmentPrompt(
  graph: unknown,
  stepBodies: Record<string, string>,
): string {
  const bodies = Object.entries(stepBodies);
  const sources =
    bodies.length > 0
      ? bodies
          .map(([file, body]) => `--- ${file} ---\n${body}`)
          .join("\n\n")
      : "(no source bodies were provided — annotate from the graph alone)";

  return `You are annotating an already-rendered workflow diagram. The diagram's structure below is fixed — you only supply short text annotations, as one JSON object.

Extracted workflow graph:
${JSON.stringify(graph, null, 2)}

The workflow's source (read the step run() bodies to understand what each step actually does — what it calls, what it decides, why it branches):
${sources}

RETURN ONLY a JSON object matching this schema — no prose before or after, no markdown required:

{
  "summary": "what this workflow does, one line (max ${LIMITS.summary} chars)",
  "nodeDetails": { "<nodeId>": { "sublabel": "short annotation shown in the node (max ${LIMITS.sublabel} chars)", "description": "one sentence, shown on hover (max ${LIMITS.description} chars)" } },
  "edgeLabels": { "<fromNodeId>-><toNodeId>": "intent/condition name (max ${LIMITS.edgeLabel} chars)" },
  "notes": ["up to ${LIMITS.noteCount} facts worth knowing, each max ${LIMITS.note} chars"],
  "layoutHints": { "groups": [{ "label": "group name (max ${LIMITS.groupLabel} chars)", "nodeIds": ["..."] }], "laneOrder": { "<layerIndex>": ["nodeId", "..."] } },
  "crossWorkflow": "how this workflow ties into the project's other workflows, if it does (max ${LIMITS.crossWorkflow} chars)"
}

Rules:
- Every field is optional — omit what you have nothing useful for (omit, don't write null). Empty strings are worse than omissions.
- Use ONLY node ids that appear in the graph above.
- Length limits are hard caps and oversize strings get truncated mid-sentence — aim comfortably under each limit.
- Your final message must be exactly the JSON object.`;
}

/**
 * Pull the JSON object out of the model's final text — fenced (\`\`\`json … \`\`\`)
 * or raw, tolerating prose around it by falling back to the outermost {…} span.
 * Null when nothing parses. Mirrors `extractEnrichmentJson` on the harness side;
 * the harness re-validates, so this only has to get the object out.
 */
function extractEnrichmentJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates: (string | undefined)[] = [fenced?.[1], text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

const enrich = defineStep({
  name: "enrich",
  next: [],
  terminal: true,
  async run(
    input: EnrichCanvasInput,
    ctx: AgentExecutionContext<EnrichCanvasInput>,
  ) {
    const graph = input.graph ?? {};
    const stepBodies = input.stepBodies ?? {};
    ctx.logger.info("enriching canvas", {
      sourceFiles: Object.keys(stepBodies).length,
    });

    // One metered LLM call on OUR account (models.run → llm.generate). The
    // result's `output` is the model's final text; we parse the JSON object out
    // and hand it back as the run output for the harness to validate.
    const result = await ctx.sapiom.models.run({
      prompt: buildEnrichmentPrompt(graph, stepBodies),
      system:
        "You annotate workflow diagrams. You reply with exactly one JSON object and nothing else.",
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    const enrichment = result.output ? extractEnrichmentJson(result.output) : null;
    if (!enrichment) {
      // Honest empty overlay — the harness keeps the Tier-1 render; the user
      // sees the structure, just no annotations. Never a failure state.
      ctx.logger.info("no parseable enrichment — returning empty overlay");
      return terminate({});
    }
    return terminate(enrichment);
  },
});

export const agent = defineAgent<EnrichCanvasInput, EnrichCanvasInput>({
  name: "enrich-canvas",
  entry: "enrich",
  steps: { enrich },
});
