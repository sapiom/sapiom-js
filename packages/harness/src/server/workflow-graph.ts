/**
 * `GET /api/workflows/:path/graph` — the WORKFLOW-keyed canvas route (IA-01).
 *
 * The canvas has only ever been reachable through a session: boards live at
 * `/canvas/:harnessSessionId/` and resolve by the session's current binding
 * (server/canvas.ts), so an agent that has never hosted a session has no board
 * at all. Reading agent F's board while working in agent B's session is
 * therefore impossible, which is what the selection-driven rail needs.
 *
 * This route is the second, session-free entry point onto the SAME derivation.
 * It renders nothing new: it calls `deriveWorkflowCanvas` (core/canvas-render.ts),
 * the exact pipeline the write path uses, so `document` here is byte-identical
 * to the render file a bound session's canvas serves for the same workflow.
 * Nothing is written to disk.
 *
 * Keying: `:path` is the agent's absolute directory path, URI-encoded into one
 * segment — `encodeURIComponent(agentPath)`, the same convention
 * `/api/workflows/:id/input-contract` and `/api/workflows/:id/deploy` already
 * use (web/src/lib/api.ts). Express matches on the raw path and decodes the
 * param, so an encoded `/` never splits the route.
 *
 * Containment: registry resolution happens BEFORE any disk read, so a caller
 * cannot turn this into an arbitrary-path manifest reader — the same barrier
 * server/actions.ts relies on. The lexical guards below (`..` segment,
 * absolute-only) reject the escape shapes outright rather than let
 * normalization quietly land them on some other registered path, and the
 * marker's realpath is confined to the agent directory so a symlinked
 * `sapiom.json` cannot read a file outside the project.
 *
 * Failure modes are deliberately distinct, and every one of them is
 * distinguishable from "no such route":
 *
 *   400  the path is missing, relative, or carries a `..` segment; or
 *        `sapiom.json` resolves outside the agent directory
 *   404  the path is not a registered workflow
 *   200  `status: "empty"`    — registered, but no readable/parseable
 *                               `sapiom.json` (absent ⇒ empty, not an error)
 *   200  `status: "preparing"`— dependencies not installed yet
 *   200  `status: "error"`    — extraction ran and failed; `reason` says why
 *   200  `status: "ok"`       — graph + document
 *
 * Mounted under the same `/api` boot-token middleware as the rest of the REST
 * surface (server/index.ts).
 */
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { Router, type Router as ExpressRouter } from "express";

import {
  inspectAgentProjectMarker,
  type AgentProjectMarkerInspection,
} from "../core/agent-project-discovery.js";
import { renderCanvasMessageDocument } from "../core/canvas-template.js";
import { deriveWorkflowCanvas, type RenderableWorkflow } from "../core/canvas-render.js";
import type { CanvasGraph } from "../core/canvas-graph.js";
import type { CanvasEnrichment } from "../core/canvas-enrichment.js";
import { hasTraversalSegment, resolveWithinRoot } from "../core/path-safety.js";

/** Why a board is not a graph. `ok` is the only status carrying one. */
export type WorkflowGraphStatus = "ok" | "empty" | "preparing" | "error";

export interface WorkflowGraphResponse {
  /** The resolved absolute agent directory the board was derived from. */
  path: string;
  /** The registry's display name — the board's panel title. */
  name: string;
  status: WorkflowGraphStatus;
  /** The extracted graph; null for every status but "ok". */
  graph: CanvasGraph | null;
  /** Deterministic enrichment derived from `graph`; null when there is none. */
  enrichment: CanvasEnrichment | null;
  /** Human-readable explanation for "empty"/"error"; null otherwise. */
  reason: string | null;
  /** True when the graph came from the extraction cache — no child process ran. */
  cached: boolean;
  /**
   * The finished canvas document, byte-identical to what `/canvas/:sessionId/`
   * serves for a session bound to this workflow. Present for EVERY status —
   * an empty board is still a renderable page, not a hole.
   */
  document: string;
}

export interface WorkflowGraphRouterDeps {
  /**
   * Resolves an absolute agent path against the live registry; null when the
   * path is not registered. Called before anything touches disk.
   */
  resolveWorkflow(agentPath: string): RenderableWorkflow | null;
  /** Seam for tests — defaults to the real `sapiom.json` inspection. */
  inspectMarker?(dir: string): Promise<AgentProjectMarkerInspection>;
  /** Seam for tests — defaults to the real derivation (which runs esbuild). */
  deriveCanvas?: typeof deriveWorkflowCanvas;
  /** Seam for tests — defaults to `fs.realpath`. */
  realpath?(p: string): Promise<string>;
}

/** Why a registered agent has no graph, phrased for a person reading the pane. */
const EMPTY_REASONS = {
  gone: "This agent's directory is no longer on disk.",
  absent: "This agent has no sapiom.json, so there is no graph to render yet.",
  invalid: "This agent's sapiom.json is not valid JSON, so its graph can't be read.",
  unreadable: "This agent's sapiom.json could not be read.",
} as const;

/** The empty board — the same message document server/canvas.ts serves, with
 *  the specific reason as its subtitle so the pane is never mutely blank. */
function emptyResponse(agentPath: string, name: string, reason: string): WorkflowGraphResponse {
  return {
    path: agentPath,
    name,
    status: "empty",
    graph: null,
    enrichment: null,
    reason,
    cached: false,
    document: renderCanvasMessageDocument("Nothing rendered yet", reason),
  };
}

export function createWorkflowGraphRouter(deps: WorkflowGraphRouterDeps): ExpressRouter {
  const inspectMarker = deps.inspectMarker ?? inspectAgentProjectMarker;
  const deriveCanvas = deps.deriveCanvas ?? deriveWorkflowCanvas;
  const realpath = deps.realpath ?? ((p: string) => fsp.realpath(p));

  const router = Router();

  router.get("/api/workflows/:path/graph", async (req, res) => {
    const raw = req.params.path;
    if (typeof raw !== "string" || raw.trim() === "") {
      res.status(400).json({ error: "agent path is required" });
      return;
    }
    // Rejected on the RAW value, before resolution: a `..` climb must be an
    // error, not something normalization silently lands on another registered
    // path. (path-safety.ts's segment-aware test — "a..b" is a normal name.)
    if (hasTraversalSegment(raw)) {
      res.status(400).json({ error: "agent path must not contain a '..' segment" });
      return;
    }
    if (!path.isAbsolute(raw)) {
      res.status(400).json({ error: "agent path must be absolute" });
      return;
    }

    const agentPath = path.resolve(raw);
    // The containment barrier: only a path the registry already knows is ever
    // read. Everything below this line operates on a registered directory.
    const workflow = deps.resolveWorkflow(agentPath);
    if (!workflow) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    const name = workflow.name || path.basename(agentPath);

    let realDir: string;
    try {
      realDir = await realpath(agentPath);
    } catch {
      // Registered but gone (the registry prunes lazily). That is an EMPTY
      // board, not a 404 — 404 means "not registered", and conflating the two
      // would make a consumer show "no such agent" for one it can see listed.
      res.json(emptyResponse(agentPath, name, EMPTY_REASONS.gone));
      return;
    }

    // Symlink guard on the one file this route reads by name. A symlinked
    // agent DIRECTORY is legitimate (the user registered it, and realDir is
    // its target), but a `sapiom.json` symlinked out of the project would make
    // a path-keyed read endpoint into a file reader — refuse that outright.
    const marker = await realpath(path.join(realDir, "sapiom.json")).catch(() => null);
    if (marker !== null && resolveWithinRoot(realDir, marker) === null) {
      res.status(400).json({ error: "sapiom.json resolves outside the agent directory" });
      return;
    }

    const inspection = await inspectMarker(realDir);
    if (inspection.status !== "valid") {
      res.json(emptyResponse(agentPath, name, EMPTY_REASONS[inspection.status]));
      return;
    }

    const derived = await deriveCanvas({
      path: workflow.path,
      name,
      definitionId: workflow.definitionId ?? null,
      activeBuildRunStatus: workflow.activeBuildRunStatus ?? null,
    });

    res.json({
      path: agentPath,
      name,
      status: derived.status,
      graph: derived.graph,
      enrichment: derived.enrichment,
      reason: derived.reason,
      cached: derived.cached,
      document: derived.document,
    } satisfies WorkflowGraphResponse);
  });

  return router;
}
