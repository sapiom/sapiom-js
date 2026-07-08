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
import { renderCanvasDocument } from "./canvas-template.js";
import { extractWorkflowGraphCached } from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import { usedKinds } from "./canvas-svg.js";
import {
  assembleCanvasBody,
  buildErrorPanelHtml,
  buildLegendHtml,
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
  /** Set only when writing the file itself failed (e.g. an unwritable cwd) — extraction success/failure above is unaffected. */
  writeError?: string;
  /** True when `preserveExistingOnFailure` kept the existing render instead of writing an error panel over it. */
  preservedExisting?: boolean;
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
}

function badgesFor(workflow: RenderableWorkflow): string[] {
  return [workflow.definitionId != null ? "deployed" : "local only"];
}

function buildSingleBody(workflow: RenderableWorkflow, graph: CanvasGraph | null, reason: string | null): string {
  if (!graph) {
    return assembleCanvasBody({
      panels: [buildErrorPanelHtml(workflow.name, reason ?? "unknown extraction failure")],
      legend: "",
      note: "Static preview — this workflow has a build error; regenerate once it's fixed.",
    });
  }
  const used = usedKinds(graph);
  return assembleCanvasBody({
    panels: [buildWorkflowPanelHtml(graph, { title: workflow.name, badges: badgesFor(workflow) })],
    legend: buildLegendHtml(used.nodeKinds, used.edgeKinds),
    note: "Static preview — re-renders automatically when the workflow changes.",
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

  const { result, cached } = await extractWorkflowGraphCached(bound.path);
  const failed = !result.ok;
  const body = buildSingleBody(bound, result.ok ? result.graph : null, result.ok ? null : result.reason);

  const renderPath = renderFileFor(session.cwd, bound.path);
  const outcome: CanvasRenderOutcome = {
    mode: "single",
    workflowPath: bound.path,
    renderPath,
    extractionFailed: failed ? [bound.name] : [],
    cachedExtraction: cached,
  };

  // An unprompted render that failed to extract must not destroy an existing
  // (possibly good) diagram for this workflow — e.g. a project that merely
  // hasn't run `npm install` yet after a fresh clone.
  if (options.preserveExistingOnFailure && failed) {
    const exists = await fs
      .access(renderPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      outcome.preservedExisting = true;
      return outcome;
    }
  }

  try {
    await fs.mkdir(path.dirname(renderPath), { recursive: true });
    await fs.writeFile(renderPath, renderCanvasDocument(body), "utf8");
  } catch (err) {
    outcome.writeError = err instanceof Error ? err.message : String(err);
  }
  return outcome;
}
