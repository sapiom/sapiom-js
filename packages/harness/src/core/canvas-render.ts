/**
 * The deterministic render pipeline: given a session bound to a workflow,
 * extracts that workflow's graph (core/canvas-cache.ts — cached, so an
 * unchanged workflow never pays for a second child process), builds the SVG +
 * panel markup (core/canvas-svg.ts, core/canvas-body.ts), wraps it through
 * the shared document shell (core/canvas-template.ts's
 * `renderCanvasDocument`), and writes it to the workflow's own render file,
 * `<cwd>/.sapiom/canvas/renders/<slug>.html`. Zero LLM involvement —
 * extraction failure degrades to an honest error panel, never a crash.
 *
 * Renders are per-WORKFLOW files (not a shared index.html) so switching the
 * binding never rewrites anything another binding depends on — the server
 * (src/server/canvas.ts) resolves the session's current binding at request
 * time and serves the matching render. `index.html` remains the
 * agent-authored/custom canvas and is never touched here. An unbound session
 * renders nothing at all (no extraction, no write): the server serves the
 * existing empty-state/custom canvas for it.
 *
 * The write alone is enough to hot-reload an open canvas pane —
 * CanvasWatcherManager already watches the whole session cwd and treats any
 * change under `.sapiom/canvas/` as a reload signal, regardless of who wrote
 * it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CANVAS_RENDERS_DIR } from "../shared/types.js";
import { agentDepsInstalled } from "./agent-deps.js";
import { renderCanvasDocument } from "./canvas-template.js";
import { extractWorkflowGraphCached } from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import type { CanvasEnrichment } from "./canvas-enrichment.js";
import { deriveEnrichment } from "./canvas-derive.js";
import {
  assembleCanvasBody,
  buildErrorPanelHtml,
  buildPreparingPanelHtml,
  buildWorkflowPanelHtml,
} from "./canvas-body.js";

export interface RenderableSession {
  cwd: string;
  boundWorkflowPath: string | null;
}

export interface RenderableWorkflow {
  path: string;
  name: string;
  definitionId: number | null;
  activeBuildRunStatus?: string | null;
}

/**
 * Stable, filesystem-safe render-file name for a workflow: its directory
 * basename (readable in `ls`) plus a short path hash (two same-named
 * workflows at different paths can never collide). Shared by the writer here
 * and the server's request-time resolution — must stay deterministic.
 */
export function slugForWorkflowPath(workflowPath: string): string {
  const base =
    path
      .basename(workflowPath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow";
  const hash = createHash("sha256").update(path.resolve(workflowPath)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/** Absolute path of `workflowPath`'s render file under `cwd`'s canvas dir. */
export function renderFileFor(cwd: string, workflowPath: string): string {
  return path.join(cwd, CANVAS_RENDERS_DIR, `${slugForWorkflowPath(workflowPath)}.html`);
}

export interface CanvasRenderOutcome {
  /** "single": a bound workflow was rendered to its render file. "empty":
   *  the session is unbound (or bound to an unknown path) — nothing was
   *  extracted or written; the server serves the empty state on its own. */
  mode: "single" | "empty";
  workflowPath?: string;
  /** Absolute path of the render file written (mode "single" only). */
  renderPath?: string;
  /** Display names of workflows whose graph couldn't be extracted (still rendered as a degraded panel). */
  extractionFailed: string[];
  /** True when the graph came from the extraction cache — no child process ran. */
  cachedExtraction?: boolean;
  /** True when the deterministic enrichment was merged into the render (mode
   *  "single", successful extraction only). */
  enrichmentApplied?: boolean;
  /** Set only when writing the file itself failed (e.g. an unwritable cwd) — extraction success/failure above is unaffected. */
  writeError?: string;
  /** True when `preserveExistingOnFailure` kept the existing render instead of writing an error panel over it. */
  preservedExisting?: boolean;
  /** True when the workflow's `node_modules` isn't present yet, so extraction
   *  was skipped and a calm "preparing" placeholder was written instead of an
   *  esbuild error panel. The server arms an install watcher on this to
   *  re-render once dependencies land — see server/index.ts. */
  depsMissing?: boolean;
}

export interface RenderCanvasOptions {
  /**
   * For unprompted (auto) renders only — session create, boot. When the
   * extraction failed AND a render file for this workflow already exists,
   * keep the existing file rather than replace a possibly-good diagram with
   * an error panel. An explicit user-invoked render (the Visualize macro,
   * POST /canvas/:id/render) should NOT set this: there the honest error
   * page IS the answer the user asked for.
   */
  preserveExistingOnFailure?: boolean;
  /**
   * Force extraction even when the project's dependencies aren't installed,
   * so the honest esbuild error panel is written instead of the calm
   * "preparing" placeholder. The install watcher's timeout path sets this to
   * restore the Retry / Ask-coding-agent actions when an install never
   * completes — otherwise the placeholder (and its `depsMissing` re-arm) would
   * wait forever. Normal renders leave it off.
   */
  surfaceErrorOnMissingDeps?: boolean;
}

function badgesFor(workflow: RenderableWorkflow): string[] {
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
      panels: [buildErrorPanelHtml(workflow.name, reason ?? "unknown extraction failure")],
    });
  }
  return assembleCanvasBody({
    panels: [buildWorkflowPanelHtml(graph, { title: workflow.name, badges: badgesFor(workflow) }, enrichment)],
  });
}

/**
 * Renders `session`'s bound workflow to its per-workflow render file. Never
 * throws — every failure mode (extraction, filesystem) is captured in the
 * returned outcome instead. Unbound sessions are a cheap no-op: no
 * extraction, no write (`mode: "empty"`).
 */
export async function renderCanvasForSession(
  session: RenderableSession,
  workflows: readonly RenderableWorkflow[],
  options: RenderCanvasOptions = {},
): Promise<CanvasRenderOutcome> {
  const bound = session.boundWorkflowPath ? workflows.find((w) => w.path === session.boundWorkflowPath) : undefined;
  if (!bound) {
    return { mode: "empty", extractionFailed: [] };
  }
  return renderWorkflowRenderFile(session.cwd, bound, options);
}

/**
 * Everything the deterministic render pipeline computes for ONE workflow,
 * WITHOUT touching the filesystem's render file: the extracted graph, its
 * derived enrichment, and the finished canvas document. Shared by the write
 * path ({@link renderWorkflowRenderFile}) and the session-free workflow-keyed
 * graph route (server/workflow-graph.ts), so a board read by agent path can
 * never disagree with the one a bound session sees.
 */
export interface WorkflowCanvasDerivation {
  /** "ok": extracted and rendered. "preparing": dependencies aren't installed
   *  yet, so extraction was skipped and the calm placeholder was built
   *  instead. "error": extraction ran and failed — the honest error panel. */
  status: "ok" | "preparing" | "error";
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
 * Extracts `workflow`'s graph and builds its canvas document. Pure with
 * respect to the render file: nothing is written and no render path is
 * consulted, so this is safe to call for a workflow no session is bound to.
 * Never throws — extraction failure comes back as `status: "error"` with the
 * reason, exactly as the write path renders it.
 */
export async function deriveWorkflowCanvas(
  workflow: RenderableWorkflow,
  options: RenderCanvasOptions = {},
): Promise<WorkflowCanvasDerivation> {
  // A freshly scaffolded project — between `scaffold` and the coding agent's
  // `npm install` — has no installed SDK, so extraction (an esbuild bundle of
  // the project's own index.ts) is guaranteed to fail with "Could not resolve
  // @sapiom/agent / zod/v4". That's not an error the user caused or can act on;
  // it self-resolves when install finishes. So skip extraction entirely and
  // build a calm "preparing" placeholder. A bundle failure WITH deps installed
  // stays a genuine error (below).
  if (!options.surfaceErrorOnMissingDeps && !(await agentDepsInstalled(workflow.path))) {
    return {
      status: "preparing",
      graph: null,
      enrichment: null,
      reason: null,
      cached: false,
      document: renderCanvasDocument(buildPreparingPanelHtml(workflow.name)),
    };
  }

  const { result, cached } = await extractWorkflowGraphCached(workflow.path);

  // Enrichment only decorates a successful extraction — deriving annotations
  // for an error panel whose steps we can't even show would be noise. Derived
  // deterministically from the freshly extracted graph, so it's always in sync
  // with the diagram and can never go stale.
  const enrichment = result.ok ? deriveEnrichment(result.graph) : null;
  const body = buildSingleBody(workflow, result.ok ? result.graph : null, result.ok ? null : result.reason, enrichment);

  return {
    status: result.ok ? "ok" : "error",
    graph: result.ok ? result.graph : null,
    enrichment,
    reason: result.ok ? null : result.reason,
    cached,
    document: renderCanvasDocument(body),
  };
}

/**
 * Renders ONE workflow to its render file under `cwd`, merging in the
 * deterministic enrichment derived from the freshly extracted graph
 * (core/canvas-derive.ts). This is the write path shared by every render
 * trigger — bind, session-create/boot, and the visualize/refresh macro — all
 * via `renderCanvasForSession`; it targets a workflow directly and the render
 * file is per-workflow.
 */
export async function renderWorkflowRenderFile(
  cwd: string,
  bound: RenderableWorkflow,
  options: RenderCanvasOptions = {},
): Promise<CanvasRenderOutcome> {
  const renderPath = renderFileFor(cwd, bound.path);
  const derived = await deriveWorkflowCanvas(bound, options);

  const outcome: CanvasRenderOutcome = {
    mode: "single",
    workflowPath: bound.path,
    renderPath,
    extractionFailed: derived.status === "error" ? [bound.name] : [],
    ...(derived.status === "preparing"
      ? { depsMissing: true }
      : { cachedExtraction: derived.cached }),
    ...(derived.enrichment ? { enrichmentApplied: true } : {}),
  };

  // An unprompted render that failed must not destroy an existing (possibly
  // good) diagram for this workflow — an agent mid-edit whose sources are
  // transiently un-buildable, or deps that went missing. `depsMissing` is still
  // flagged above so the server's install watcher re-renders when they return.
  if (options.preserveExistingOnFailure && derived.status !== "ok" && (await pathExists(renderPath))) {
    outcome.preservedExisting = true;
    return outcome;
  }

  await writeRenderFile(renderPath, derived.document, outcome);
  return outcome;
}

/** True if `p` exists (any type). */
async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Writes the render file, skipping an identical rewrite (which would bump the
 *  mtime and make the canvas watcher fire a needless iframe reload — a true
 *  no-op now that any workflow source edit triggers a re-render). A write
 *  failure (e.g. an unwritable cwd) is captured on `outcome.writeError`;
 *  extraction success/failure is unaffected. */
async function writeRenderFile(
  renderPath: string,
  document: string,
  outcome: CanvasRenderOutcome,
): Promise<void> {
  try {
    const existing = await fs.readFile(renderPath, "utf8").catch(() => null);
    if (existing !== document) {
      await fs.mkdir(path.dirname(renderPath), { recursive: true });
      await fs.writeFile(renderPath, document, "utf8");
    }
  } catch (err) {
    outcome.writeError = err instanceof Error ? err.message : String(err);
  }
}
