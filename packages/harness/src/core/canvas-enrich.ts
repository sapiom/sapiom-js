/**
 * The AI enrichment runner: spawns ONE bounded, headless agent task per
 * workflow (via TaskManager) that reads the workflow's step bodies and
 * returns the JSON `CanvasEnrichment` contract — never HTML, never a file
 * write. On success the validated enrichment is persisted to the workflow's
 * cache file and the render file is rebuilt with it merged in; on any
 * parse/validation failure the enrichment is discarded whole and the base
 * render stands (core/canvas-enrichment.ts's contract). Task-process
 * failures surface through the task record itself (the pane's error state +
 * Retry), never as HTML on disk.
 *
 * Triggering (see server/index.ts):
 * - bind / session create → `ensureFresh`: spawn only when no cache entry
 *   matches the current source fingerprint; every skip reason is silent.
 * - the visualize macro → `forceRefresh`: drop the extraction + enrichment
 *   caches, re-render the base immediately, re-enrich; refusals propagate
 *   (an already-running enrichment for this workflow → 409 via the macros
 *   router, exactly like any other double-fired background macro).
 *
 * Dedupe is per WORKFLOW, not per session: TaskManager refuses a second
 * running task with the same macroId + workflowPath regardless of which
 * session asked (see TaskAlreadyRunningError) — two panes bound to the same
 * workflow can never race its cache/render files.
 */
import type { BackgroundTask, HarnessKind } from "../shared/types.js";
import { extractWorkflowGraphCached, invalidateExtractionCache, type CachedExtraction } from "./canvas-cache.js";
import type { CanvasGraph } from "./canvas-graph.js";
import {
  ENRICHMENT_LIMITS,
  normalizeCanvasEnrichmentCandidate,
  parseCanvasEnrichment,
  readEnrichmentCacheFile,
  removeEnrichmentCacheFile,
  writeEnrichmentCacheFile,
} from "./canvas-enrichment.js";
import {
  enrichmentCacheFileFor,
  renderWorkflowRenderFile,
  type RenderableWorkflow,
} from "./canvas-render.js";
import type { RunTaskRequest } from "./task-manager.js";
import { TaskAlreadyRunningError, TaskNotSupportedError } from "./task-manager.js";

/** The macro identity enrichment tasks run under — the pane's Retry re-fires
 *  this macro, which routes back through forceRefresh. */
export const ENRICHMENT_MACRO_ID = "visualize";
const ENRICHMENT_TASK_LABEL = "Visualize";
/** Hard turn cap: read a few step files, answer. A run that needs more than
 *  this is off the rails, not thorough. */
const ENRICHMENT_MAX_TURNS = 8;
const DEFAULT_ENRICHMENT_MODEL = "sonnet";

/** Model the enrichment task runs on — overridable per install. */
export function enrichmentModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAPIOM_HARNESS_VISUALIZE_MODEL || DEFAULT_ENRICHMENT_MODEL;
}

/**
 * Builds the one-shot enrichment prompt: the extracted graph inline (the AI
 * annotates THIS structure — it never invents nodes), pointed at the step
 * sources for semantics, with the JSON contract and its hard limits stated
 * verbatim so a well-behaved run needs no retry.
 */
export function buildEnrichmentPrompt(graph: CanvasGraph, workflowDir: string): string {
  const L = ENRICHMENT_LIMITS;
  return `You are annotating an already-rendered workflow diagram. The diagram's structure below is fixed — you only supply short text annotations, as one JSON object.

Extracted workflow graph:
${JSON.stringify(graph, null, 2)}

Read the step run() bodies in ${workflowDir} to understand what each step actually does (what it calls, what it decides, why it branches), then RETURN ONLY a JSON object matching this schema — no prose before or after, no markdown required, and DO NOT write or modify any files:

{
  "summary": "what this workflow does, one line (max ${L.summary} chars)",
  "nodeDetails": { "<nodeId>": { "sublabel": "short annotation shown in the node (max ${L.sublabel} chars)", "description": "one sentence, shown on hover (max ${L.description} chars)" } },
  "edgeLabels": { "<fromNodeId>-><toNodeId>": "intent/condition name (max ${L.edgeLabel} chars)" },
  "notes": ["up to ${L.noteCount} facts worth knowing, each max ${L.note} chars"],
  "layoutHints": { "groups": [{ "label": "group name (max ${L.groupLabel} chars)", "nodeIds": ["..."] }], "laneOrder": { "<layerIndex>": ["nodeId", "..."] } },
  "crossWorkflow": "how this workflow ties into the project's other workflows, if it does (max ${L.crossWorkflow} chars)"
}

Rules:
- Every field is optional — omit what you have nothing useful for (omit, don't write null). Empty strings are worse than omissions.
- Use ONLY node ids that appear in the graph above.
- Length limits are hard caps and oversize strings get truncated mid-sentence — aim comfortably under each limit.
- Your final message must be exactly the JSON object.`;
}

/**
 * Pulls the JSON object out of a task's final result text — either fenced
 * (\`\`\`json ... \`\`\`) or raw, tolerating prose around it by falling back to
 * the outermost {...} span. Null when nothing parses.
 */
export function extractEnrichmentJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

/** The slice of TaskManager the runner uses — injectable for tests. */
export interface EnrichmentTaskRunner {
  run(req: RunTaskRequest): Promise<BackgroundTask>;
  onStatusChange(listener: (task: BackgroundTask) => void): () => void;
}

/** The session shape the coordinator needs — satisfied by HarnessSession. */
export interface EnrichmentSession {
  id: string;
  cwd: string;
  harness: HarnessKind;
  boundWorkflowPath: string | null;
}

export interface EnrichmentCoordinatorOptions {
  tasks: EnrichmentTaskRunner;
  /** Rebuilds the workflow's render file (with the just-persisted enrichment
   *  merged) after a successful run — the write alone hot-reloads any open
   *  pane via the canvas watcher. */
  rerender?: (cwd: string, workflow: RenderableWorkflow) => Promise<void>;
  /** Injectable for tests — defaults to the real cached extraction. */
  extractCached?: (dir: string) => Promise<CachedExtraction>;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  onError?: (message: string) => void;
}

export class CanvasEnrichmentCoordinator {
  private readonly tasks: EnrichmentTaskRunner;
  private readonly rerender: (cwd: string, workflow: RenderableWorkflow) => Promise<void>;
  private readonly extractCached: (dir: string) => Promise<CachedExtraction>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly onError: (message: string) => void;

  constructor(options: EnrichmentCoordinatorOptions) {
    this.tasks = options.tasks;
    this.rerender = options.rerender ?? (async (cwd, workflow) => void (await renderWorkflowRenderFile(cwd, workflow)));
    this.extractCached = options.extractCached ?? extractWorkflowGraphCached;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError ?? ((message) => console.error(`[harness] ${message}`));
  }

  /**
   * The bind/create trigger: spawn an enrichment task unless a cached
   * enrichment already matches the workflow's current sources. Silent on
   * every expected refusal — unbound session, failed extraction, fresh
   * cache, an enrichment already in flight for this workflow, a harness
   * with no headless mode, even a spawn failure (logged) — because nothing
   * here was user-initiated and a bind must never fail on enrichment's
   * account.
   */
  async ensureFresh(session: EnrichmentSession, workflows: readonly RenderableWorkflow[]): Promise<void> {
    const bound = this.resolveBound(session, workflows);
    if (!bound) return;
    try {
      const { result, fingerprint } = await this.extractCached(bound.path);
      if (!result.ok) return;
      const entry = await readEnrichmentCacheFile(enrichmentCacheFileFor(session.cwd, bound.path));
      if (entry && entry.sourceFingerprint === fingerprint) return;
      await this.spawn(session, bound, result.graph, fingerprint);
    } catch (err) {
      if (err instanceof TaskAlreadyRunningError || err instanceof TaskNotSupportedError) return;
      this.onError(`canvas enrichment (auto) failed to start: ${(err as Error).message}`);
    }
  }

  /**
   * The visualize macro: invalidate both caches, re-render the base diagram
   * immediately (instant feedback, honest content — no leftover enrichment
   * from sources that may have changed), then re-enrich. Refusals propagate
   * to the macros router (TaskAlreadyRunningError → 409,
   * TaskNotSupportedError → 400). Unbound session: just a no-op, matching
   * the deterministic render's own unbound contract.
   */
  async forceRefresh(session: EnrichmentSession, workflows: readonly RenderableWorkflow[]): Promise<void> {
    const bound = this.resolveBound(session, workflows);
    if (!bound) return;
    invalidateExtractionCache(bound.path);
    await removeEnrichmentCacheFile(enrichmentCacheFileFor(session.cwd, bound.path));
    await this.rerender(session.cwd, bound);
    const { result, fingerprint } = await this.extractCached(bound.path);
    if (!result.ok) return;
    await this.spawn(session, bound, result.graph, fingerprint);
  }

  private resolveBound(
    session: EnrichmentSession,
    workflows: readonly RenderableWorkflow[],
  ): RenderableWorkflow | undefined {
    return session.boundWorkflowPath ? workflows.find((w) => w.path === session.boundWorkflowPath) : undefined;
  }

  private async spawn(
    session: EnrichmentSession,
    workflow: RenderableWorkflow,
    graph: CanvasGraph,
    fingerprint: string,
  ): Promise<void> {
    const task = await this.tasks.run({
      macroId: ENRICHMENT_MACRO_ID,
      label: ENRICHMENT_TASK_LABEL,
      harnessSessionId: session.id,
      harness: session.harness,
      cwd: session.cwd,
      prompt: buildEnrichmentPrompt(graph, workflow.path),
      workflowPath: workflow.path,
      model: enrichmentModel(this.env),
      maxTurns: ENRICHMENT_MAX_TURNS,
    });

    // Subscribed synchronously right after run() resolves — the process's
    // exit can only arrive via a later event-loop turn, so the terminal
    // status can't be missed.
    const unsubscribe = this.tasks.onStatusChange((update) => {
      if (update.id !== task.id || update.status === "running") return;
      unsubscribe();
      if (update.status !== "completed") return; // pane shows the failure; nothing to persist
      void this.persist(session.cwd, workflow, graph, fingerprint, update.resultText).catch((err: unknown) => {
        this.onError(`canvas enrichment persist failed: ${(err as Error).message}`);
      });
    });
  }

  /** Completed task → parse → validate → cache file → re-render. Any parse
   *  or validation failure discards the enrichment whole; the base render
   *  already on disk stands untouched. */
  private async persist(
    cwd: string,
    workflow: RenderableWorkflow,
    graph: CanvasGraph,
    fingerprint: string,
    resultText: string | null,
  ): Promise<void> {
    const candidate = resultText ? extractEnrichmentJson(resultText) : null;
    const enrichment = candidate ? parseCanvasEnrichment(normalizeCanvasEnrichmentCandidate(candidate)) : null;
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
