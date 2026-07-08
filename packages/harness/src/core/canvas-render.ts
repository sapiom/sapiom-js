/**
 * The deterministic render pipeline: given a session (bound or not) and the
 * workflow registry, extracts the relevant workflow graph(s) (core/
 * canvas-graph.ts), builds the SVG + panel markup (core/canvas-svg.ts,
 * core/canvas-body.ts), wraps it through the shared document shell
 * (core/canvas-template.ts's `renderCanvasDocument`), and writes
 * `<cwd>/.sapiom/canvas/index.html`. Zero LLM involvement, typically well
 * under a second for a small workflow — extraction failure degrades to an
 * honest error panel per workflow, never a crash and never a silent fallback
 * to the LLM path (see core/macros.ts's separate "ai-visualize" macro for
 * that path).
 *
 * The write alone is enough to hot-reload an open canvas pane —
 * CanvasWatcherManager already watches the whole session cwd and treats any
 * change under `.sapiom/canvas/` as a reload signal, regardless of who wrote
 * it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CANVAS_INDEX } from "../shared/types.js";
import { renderCanvasDocument } from "./canvas-template.js";
import { extractWorkflowGraph, type CanvasGraph } from "./canvas-graph.js";
import {
  aggregateUsedKinds,
  assembleCanvasBody,
  buildEmptyWorkspaceHtml,
  buildErrorPanelHtml,
  buildInterconnectionsPanelHtml,
  buildLegendHtml,
  buildWorkflowPanelHtml,
  type InterconnectionRow,
} from "./canvas-body.js";
import { detectInterconnections } from "./canvas-interconnections.js";

export interface RenderableSession {
  cwd: string;
  boundWorkflowPath: string | null;
}

export interface RenderableWorkflow {
  path: string;
  name: string;
  definitionId: number | null;
}

export interface CanvasRenderOutcome {
  mode: "single" | "overview" | "empty";
  workflowPath?: string;
  workflowCount?: number;
  /** Display names of workflows whose graph couldn't be extracted (still rendered as a degraded panel). */
  extractionFailed: string[];
  /** Set only when writing the file itself failed (e.g. an unwritable cwd) — extraction success/failure above is unaffected. */
  writeError?: string;
}

function badgesFor(workflow: RenderableWorkflow): string[] {
  return [workflow.definitionId != null ? "deployed" : "local only"];
}

async function renderOne(
  workflow: RenderableWorkflow,
): Promise<{ panel: string; graph: CanvasGraph | null; failed: boolean }> {
  const result = await extractWorkflowGraph(workflow.path);
  if (!result.ok) {
    return { panel: buildErrorPanelHtml(workflow.name, result.reason), graph: null, failed: true };
  }
  return {
    panel: buildWorkflowPanelHtml(result.graph, { title: workflow.name, badges: badgesFor(workflow) }),
    graph: result.graph,
    failed: false,
  };
}

async function renderSingle(workflow: RenderableWorkflow): Promise<{ body: string; failed: boolean }> {
  const { panel, graph, failed } = await renderOne(workflow);
  const used = graph ? aggregateUsedKinds([graph]) : null;
  const legend = used ? buildLegendHtml(used.nodeKinds, used.edgeKinds) : "";
  const body = assembleCanvasBody({
    panels: [panel],
    legend,
    note: failed
      ? "Static preview — this workflow has a build error; regenerate once it's fixed."
      : "Static preview — regenerate after the workflow changes.",
  });
  return { body, failed };
}

async function renderOverview(workflows: readonly RenderableWorkflow[]): Promise<{ body: string; failed: string[] }> {
  const rendered = await Promise.all(workflows.map((w) => renderOne(w)));
  const panels = rendered.map((r) => r.panel);
  const graphs = rendered.map((r) => r.graph).filter((g): g is CanvasGraph => g !== null);
  const failed = workflows.filter((_, i) => rendered[i]!.failed).map((w) => w.name);

  const displayByManifestName = new Map<string, string>();
  workflows.forEach((w, i) => {
    const graph = rendered[i]!.graph;
    if (graph) displayByManifestName.set(graph.manifestName, w.name);
  });

  const grepInputs = workflows.map((w, i) => ({
    path: w.path,
    manifestName: rendered[i]!.graph?.manifestName ?? w.name,
  }));
  const interconnections = await detectInterconnections(grepInputs);
  const rows: InterconnectionRow[] = interconnections.map((edge) => ({
    fromLabel: displayByManifestName.get(edge.fromManifestName) ?? edge.fromManifestName,
    toLabel: edge.toManifestName ? (displayByManifestName.get(edge.toManifestName) ?? edge.toManifestName) : `external ("${edge.toSlug}")`,
    tag: "launch",
  }));

  const used = aggregateUsedKinds(graphs);
  if (rows.length > 0) used.edgeKinds.add("cross");
  const legend = buildLegendHtml(used.nodeKinds, used.edgeKinds);
  const interconnectionsHtml = buildInterconnectionsPanelHtml(rows);

  const body = assembleCanvasBody({
    panels,
    interconnections: interconnectionsHtml || undefined,
    legend,
    note:
      failed.length > 0
        ? `Static preview — regenerate after a workflow changes (${failed.length} workflow${failed.length === 1 ? "" : "s"} failed to build).`
        : "Static preview — regenerate after a workflow changes.",
  });
  return { body, failed };
}

/**
 * Renders the appropriate view for `session` (its bound workflow, or the
 * whole-workspace overview when unbound) and writes it to `<cwd>/.sapiom/
 * canvas/index.html`. Never throws — every failure mode (extraction,
 * filesystem) is captured in the returned outcome instead.
 */
export async function renderCanvasForSession(
  session: RenderableSession,
  workflows: readonly RenderableWorkflow[],
): Promise<CanvasRenderOutcome> {
  let body: string;
  let outcome: CanvasRenderOutcome;

  const bound = session.boundWorkflowPath ? workflows.find((w) => w.path === session.boundWorkflowPath) : undefined;

  if (bound) {
    const { body: renderedBody, failed } = await renderSingle(bound);
    body = renderedBody;
    outcome = { mode: "single", workflowPath: bound.path, extractionFailed: failed ? [bound.name] : [] };
  } else if (workflows.length === 0) {
    body = assembleCanvasBody({
      panels: [buildEmptyWorkspaceHtml()],
      legend: "",
      note: "Nothing to visualize yet — connect a workflow to get started.",
    });
    outcome = { mode: "empty", extractionFailed: [] };
  } else {
    const { body: renderedBody, failed } = await renderOverview(workflows);
    body = renderedBody;
    outcome = { mode: "overview", workflowCount: workflows.length, extractionFailed: failed };
  }

  const indexPath = path.join(session.cwd, CANVAS_INDEX);
  try {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, renderCanvasDocument(body), "utf8");
  } catch (err) {
    outcome.writeError = err instanceof Error ? err.message : String(err);
  }
  return outcome;
}
