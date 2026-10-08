/**
 * One agent's Canvas document, derived on request and never written to disk:
 * `agents check`'s graph for the working copy (cached by source fingerprint),
 * joined with the agent's steps and its edges to other agents from the
 * project map when the browser sends them (core/canvas-map-steps.ts), laid
 * out as SVG (core/canvas-svg.ts) inside the shared document shell. Zero LLM
 * involvement; an extraction failure is an honest error panel, never a crash.
 */
import { agentDepsInstalled } from "./agent-deps.js";
import { renderCanvasDocument } from "./canvas-template.js";
import {
  ExtractionLaunchCancelledError,
  extractWorkflowGraphCached,
} from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import type { CanvasEnrichment } from "./canvas-enrichment.js";
import { deriveEnrichment } from "./canvas-derive.js";
import {
  assembleCanvasBody,
  buildErrorPanelHtml,
  buildPreparingPanelHtml,
  buildWorkflowPanelHtml,
} from "./canvas-body.js";
import { graphFromMap, type CanvasMapInput } from "./canvas-map-steps.js";

export interface RenderableWorkflow {
  path: string;
  name: string;
  definitionId: number | null;
  activeBuildRunStatus?: string | null;
  /** "unavailable" = the signed-in account can't see the linked definition.
   *  Absent = unknown. */
  definitionAccess?: "visible" | "unavailable";
}

export interface DeriveCanvasOptions {
  /**
   * Force extraction even when the project's dependencies aren't installed,
   * so the honest esbuild error panel is built instead of the calm
   * "preparing" placeholder.
   */
  surfaceErrorOnMissingDeps?: boolean;
  /** Provenance check evaluated on a cache miss immediately before the
   *  extractor child starts. */
  authorizeBeforeExtraction?: () => boolean | Promise<boolean>;
  /** Lifecycle/test hook immediately before the launch-boundary recheck. */
  beforeExtractionLaunchAuthorization?: () => void | Promise<void>;
  /** This agent's entry in the project map, at the ref the map is drawn at. */
  map?: CanvasMapInput | null;
  /** The agent has no `sapiom.json` to extract from: draw the map alone. */
  mapOnly?: boolean;
}

function badgesFor(workflow: RenderableWorkflow): string[] {
  // First: a remembered build status is no evidence for an invisible definition.
  if (
    workflow.definitionId != null &&
    workflow.definitionAccess === "unavailable"
  ) {
    return ["unavailable"];
  }
  if (workflow.activeBuildRunStatus === "ready") return ["deployed"];
  if (
    ["pending", "queued", "building"].includes(
      workflow.activeBuildRunStatus ?? "",
    )
  ) {
    return ["building"];
  }
  if (
    ["failed", "cancelled", "superseded", "stale"].includes(
      workflow.activeBuildRunStatus ?? "",
    )
  ) {
    return ["deploy failed"];
  }
  return [workflow.definitionId != null ? "linked" : "local only"];
}

function buildSingleBody(
  workflow: RenderableWorkflow,
  graph: CanvasGraph | null,
  reason: string | null,
  enrichment: CanvasEnrichment | null,
): string {
  if (!graph) {
    return assembleCanvasBody({
      panels: [
        buildErrorPanelHtml(
          workflow.name,
          reason ?? "unknown extraction failure",
        ),
      ],
    });
  }
  return assembleCanvasBody({
    panels: [
      buildWorkflowPanelHtml(
        graph,
        { title: workflow.name, badges: badgesFor(workflow) },
        enrichment,
      ),
    ],
  });
}

/** Everything derived for ONE agent's Canvas: the graph on the board, its
 *  deterministic enrichment, and the finished document. */
export interface WorkflowCanvasDerivation {
  /** "ok": extracted and rendered. "preparing": dependencies aren't installed
   *  yet, so extraction was skipped and the calm placeholder was built
   *  instead. "error": extraction ran and failed — the honest error panel. */
  status: "ok" | "preparing" | "error" | "cancelled";
  graph: CanvasGraph | null;
  enrichment: CanvasEnrichment | null;
  /** The extraction failure reason ("error" only); null otherwise. */
  reason: string | null;
  /** True when the graph came from the extraction cache — no child process ran. */
  cached: boolean;
  /** The canvas document — byte-identical to what the render file would hold. */
  document: string;
}

/**
 * Extracts `workflow`'s graph, joins the map's steps and edges when given,
 * and builds its canvas document. Nothing is written. Never throws for an
 * extraction failure: that comes back as `status: "error"` with the reason.
 */
export async function deriveWorkflowCanvas(
  workflow: RenderableWorkflow,
  options: DeriveCanvasOptions = {},
): Promise<WorkflowCanvasDerivation> {
  const fallback = { manifestName: workflow.name, description: "" };
  const fromMap = (details: CanvasGraph | null) =>
    options.map ? graphFromMap(options.map, details, fallback) : details;
  // No sapiom.json, or a map drawn at a ref: the map's steps are the board.
  if (options.mapOnly) {
    const graph = fromMap(null);
    return graph
      ? okDerivation(workflow, graph, false)
      : {
          status: "error",
          graph: null,
          enrichment: null,
          reason: "The map has no steps for this agent.",
          cached: false,
          document: renderCanvasDocument(buildSingleBody(workflow, null, "The map has no steps for this agent.", null)),
        };
  }
  // A freshly scaffolded project — between `scaffold` and the coding agent's
  // `npm install` — has no installed SDK, so extraction (an esbuild bundle of
  // the project's own index.ts) is guaranteed to fail with "Could not resolve
  // @sapiom/agent / zod/v4". That's not an error the user caused or can act on;
  // it self-resolves when install finishes. So skip extraction entirely and
  // build a calm "preparing" placeholder. A bundle failure WITH deps installed
  // stays a genuine error (below).
  if (
    !options.surfaceErrorOnMissingDeps &&
    !(await agentDepsInstalled(workflow.path))
  ) {
    // The map already knows the steps; draw them rather than wait for install.
    const graph = options.map?.steps ? fromMap(null) : null;
    if (graph) return okDerivation(workflow, graph, false);
    return {
      status: "preparing",
      graph: null,
      enrichment: null,
      reason: null,
      cached: false,
      document: renderCanvasDocument(buildPreparingPanelHtml(workflow.name)),
    };
  }

  let extracted: Awaited<ReturnType<typeof extractWorkflowGraphCached>>;
  try {
    extracted = await extractWorkflowGraphCached(workflow.path, undefined, {
      authorizeBeforeLaunch: options.authorizeBeforeExtraction,
      beforeLaunchAuthorization: options.beforeExtractionLaunchAuthorization,
    });
  } catch (error) {
    if (!(error instanceof ExtractionLaunchCancelledError)) throw error;
    return {
      status: "cancelled",
      graph: null,
      enrichment: null,
      reason: null,
      cached: false,
      // This document is intentionally never written by the render path. It
      // keeps the session-free return shape total for defensive callers.
      document: renderCanvasDocument(buildPreparingPanelHtml(workflow.name)),
    };
  }
  const { result, cached } = extracted;
  const graph = fromMap(result.ok ? result.graph : null);
  if (graph) return okDerivation(workflow, graph, cached);
  return {
    status: "error",
    graph: null,
    enrichment: null,
    reason: result.ok ? null : result.reason,
    cached,
    document: renderCanvasDocument(
      buildSingleBody(workflow, null, result.ok ? null : result.reason, null),
    ),
  };
}

/** A drawable graph's derivation. Enrichment is derived from the graph on the
 *  board, so it is always in sync with the diagram and can never go stale. */
function okDerivation(
  workflow: RenderableWorkflow,
  graph: CanvasGraph,
  cached: boolean,
): WorkflowCanvasDerivation {
  const enrichment = deriveEnrichment(graph);
  return {
    status: "ok",
    graph,
    enrichment,
    reason: null,
    cached,
    document: renderCanvasDocument(buildSingleBody(workflow, graph, null, enrichment)),
  };
}

