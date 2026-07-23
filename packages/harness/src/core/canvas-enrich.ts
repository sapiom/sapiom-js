/**
 * Tier-2 canvas enrichment (SAP-1800): the OPT-IN annotation layer over the
 * deterministic Tier-1 render.
 *
 * The producer is the Sapiom `enrich-canvas` workflow, run ON OUR ACCOUNT via
 * {@link EnrichCanvasClient} — NOT a headless `claude -p` task on the user's
 * Claude Code tokens. Given the extracted graph plus the workflow's source
 * bodies, the workflow returns the JSON `CanvasEnrichment` contract
 * (core/canvas-enrichment.ts); on success the validated enrichment is persisted
 * to the workflow's cache file and the render file is rebuilt with it merged in
 * (the write alone hot-reloads any open pane via the canvas watcher).
 *
 * Tier-1 is unkillable, so enrichment failure has no total-failure state:
 * - It NEVER auto-fires. The only trigger is the explicit `visualize` macro
 *   (`forceRefresh`) — there is no bind/session-create `ensureFresh` anymore.
 * - On ANY failure — not signed in, workflow not deployed/configured, upstream
 *   error, timeout, or invalid output — the enrichment is discarded whole and
 *   the base render already on disk stands. Nothing surfaces as an error to the
 *   pane; the user sees the honest Tier-1 structure.
 *
 * Dedupe is per WORKFLOW: a second force refresh while one is still in flight
 * for the same workflow rejects with {@link TaskAlreadyRunningError} (→ 409 via
 * the macros router) before any cache/render mutation, so a double-click
 * Visualize is a true no-op.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { extractWorkflowGraphCached, invalidateExtractionCache, type CachedExtraction } from "./canvas-cache.js";
import { listSourceFiles } from "./canvas-interconnections.js";
import type { CanvasGraph } from "./canvas-graph.js";
import {
  normalizeCanvasEnrichmentCandidate,
  parseCanvasEnrichment,
  removeEnrichmentCacheFile,
  writeEnrichmentCacheFile,
} from "./canvas-enrichment.js";
import {
  enrichmentCacheFileFor,
  renderWorkflowRenderFile,
  type RenderableWorkflow,
} from "./canvas-render.js";
import type { EnrichCanvasClient } from "./enrich-canvas-client.js";
import { TaskAlreadyRunningError } from "./task-manager.js";

/** Label the in-flight guard rejects under — surfaced as the 409 message. */
const ENRICHMENT_TASK_LABEL = "Visualize";

/** Per-file cap when reading step bodies to hand the workflow — a source file
 *  larger than this is skipped rather than blown up into the prompt. */
const MAX_STEP_BODY_FILE_BYTES = 128 * 1024;
/** Total cap across all step bodies — bounds the workflow input regardless of
 *  how many source files the project has. */
const MAX_STEP_BODY_TOTAL_BYTES = 200 * 1024;

/**
 * Reads the workflow's own `.ts`/`.tsx` source bodies (the step `run()` bodies
 * live here), keyed by workflow-relative path — the material the Sapiom
 * workflow annotates against. Bounded per-file and in total so a large project
 * can't produce an unbounded workflow input. Uses the same source walk the
 * extraction fingerprint uses ({@link listSourceFiles}).
 */
export async function readWorkflowStepBodies(dir: string): Promise<Record<string, string>> {
  const files = await listSourceFiles(dir);
  const bodies: Record<string, string> = {};
  let total = 0;
  for (const file of files) {
    if (total >= MAX_STEP_BODY_TOTAL_BYTES) break;
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_STEP_BODY_FILE_BYTES) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue; // a file that vanished/won't read is just omitted
    }
    const rel = path.relative(dir, file) || path.basename(file);
    bodies[rel] = content;
    total += content.length;
  }
  return bodies;
}

/** The session shape the coordinator needs — satisfied by HarnessSession. */
export interface EnrichmentSession {
  cwd: string;
  boundWorkflowPath: string | null;
}

export interface EnrichmentCoordinatorOptions {
  /** Runs the `enrich-canvas` workflow on our account and awaits its output. */
  client: EnrichCanvasClient;
  /**
   * The deployed `enrich-canvas` definition id (env-resolved at the wiring
   * site). Null/empty disables enrichment entirely — Tier-1 renders and the
   * force refresh is a base re-render with no annotation pass.
   */
  definitionId: string | null;
  /** Rebuilds the workflow's render file (with the just-persisted enrichment
   *  merged) after a successful run — the write alone hot-reloads any open
   *  pane via the canvas watcher. */
  rerender?: (cwd: string, workflow: RenderableWorkflow) => Promise<void>;
  /** Reads the workflow's step bodies for the workflow input. Injectable for
   *  tests — defaults to {@link readWorkflowStepBodies}. */
  readStepBodies?: (dir: string) => Promise<Record<string, string>>;
  /** Injectable for tests — defaults to the real cached extraction. */
  extractCached?: (dir: string) => Promise<CachedExtraction>;
  now?: () => string;
  onError?: (message: string) => void;
}

export class CanvasEnrichmentCoordinator {
  private readonly client: EnrichCanvasClient;
  private readonly definitionId: string | null;
  private readonly rerender: (cwd: string, workflow: RenderableWorkflow) => Promise<void>;
  private readonly readStepBodies: (dir: string) => Promise<Record<string, string>>;
  private readonly extractCached: (dir: string) => Promise<CachedExtraction>;
  private readonly now: () => string;
  private readonly onError: (message: string) => void;
  /** Workflow paths with an enrichment run currently in flight — the per-workflow
   *  dedupe guard, replacing the TaskManager's cross-session dedupe. */
  private readonly inFlight = new Set<string>();

  constructor(options: EnrichmentCoordinatorOptions) {
    this.client = options.client;
    this.definitionId = options.definitionId && options.definitionId.trim() !== "" ? options.definitionId : null;
    this.rerender = options.rerender ?? (async (cwd, workflow) => void (await renderWorkflowRenderFile(cwd, workflow)));
    this.readStepBodies = options.readStepBodies ?? readWorkflowStepBodies;
    this.extractCached = options.extractCached ?? extractWorkflowGraphCached;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError ?? ((message) => console.error(`[harness] ${message}`));
  }

  /**
   * The visualize macro (the ONLY trigger — enrichment never auto-fires):
   * invalidate both caches, re-render the base diagram immediately (instant
   * feedback, honest content), then kick off the Sapiom enrichment in the
   * background and return. The pane hot-reloads if/when annotations land; a
   * failure leaves the freshly-rendered Tier-1 base untouched.
   *
   * The in-flight check happens BEFORE any cache destruction so a double-click
   * Visualize is a true no-op: the second call rejects with
   * {@link TaskAlreadyRunningError} (→ 409) and the caches/render are left
   * exactly as the still-running enrichment will need them. Unbound session:
   * a no-op, matching the deterministic render's own unbound contract.
   */
  async forceRefresh(session: EnrichmentSession, workflows: readonly RenderableWorkflow[]): Promise<void> {
    const bound = this.resolveBound(session, workflows);
    if (!bound) return;
    if (this.inFlight.has(bound.path)) {
      throw new TaskAlreadyRunningError(ENRICHMENT_TASK_LABEL);
    }
    invalidateExtractionCache(bound.path);
    await removeEnrichmentCacheFile(enrichmentCacheFileFor(session.cwd, bound.path));
    await this.rerender(session.cwd, bound);
    const { result, fingerprint } = await this.extractCached(bound.path);
    if (!result.ok) return;
    // Enrichment not configured (no deployed definition id): Tier-1 stands, no
    // annotation pass. Silent — an unconfigured install is not an error state.
    if (!this.definitionId) return;

    this.inFlight.add(bound.path);
    void this.enrich(session, bound, result.graph, fingerprint).finally(() => {
      this.inFlight.delete(bound.path);
    });
  }

  private resolveBound(
    session: EnrichmentSession,
    workflows: readonly RenderableWorkflow[],
  ): RenderableWorkflow | undefined {
    return session.boundWorkflowPath ? workflows.find((w) => w.path === session.boundWorkflowPath) : undefined;
  }

  /**
   * Read the step bodies, run `enrich-canvas` on our account, and persist a
   * valid result. Non-throwing: every failure routes to `onError` (logged) and
   * leaves the base render standing — there is no pane-visible failure state.
   */
  private async enrich(
    session: EnrichmentSession,
    workflow: RenderableWorkflow,
    graph: CanvasGraph,
    fingerprint: string,
  ): Promise<void> {
    try {
      const stepBodies = await this.readStepBodies(workflow.path);
      const result = await this.client.run(this.definitionId as string, { graph, stepBodies });
      if (!result.ok) {
        this.onError(
          `canvas enrichment for ${workflow.path} did not complete (${result.status}: ${result.error}) — base render stands`,
        );
        return;
      }
      await this.persist(session.cwd, workflow, graph, fingerprint, result.output);
    } catch (err) {
      this.onError(`canvas enrichment failed: ${(err as Error).message}`);
    }
  }

  /** Completed run → normalize → validate → cache file → re-render. Any
   *  validation failure discards the enrichment whole; the base render already
   *  on disk stands untouched. */
  private async persist(
    cwd: string,
    workflow: RenderableWorkflow,
    graph: CanvasGraph,
    fingerprint: string,
    output: unknown,
  ): Promise<void> {
    const enrichment = parseCanvasEnrichment(normalizeCanvasEnrichmentCandidate(output));
    if (!enrichment) {
      this.onError(`canvas enrichment for ${workflow.path} returned invalid output — discarded, base render stands`);
      return;
    }
    await writeEnrichmentCacheFile(enrichmentCacheFileFor(cwd, workflow.path), {
      graph,
      enrichment,
      sourceFingerprint: fingerprint,
      enrichedAt: this.now(),
    });
    await this.rerender(cwd, workflow);
  }
}
