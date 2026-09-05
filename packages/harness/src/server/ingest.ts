/**
 * POST /ingest — receives hook payloads from the emit.cjs scripts generated
 * by core/inject/claude-settings.ts.
 *
 * Self-contained: the integrator mounts this router on the main app
 * (`app.use(createIngestRouter(deps))`) and owns everything else (session
 * manager, WS bridges, canvas). This file has no knowledge of express app
 * setup beyond its own router.
 */

import express, { type Router } from "express";
import rateLimit from "express-rate-limit";

import type { AnalyticsEvent, HarnessKind } from "../shared/types.js";
import type { NormalizeContext } from "../core/collector/normalizer.js";
import { createSeqCounter, type SeqCounter } from "../core/collector/seq.js";

export interface IngestSessionContext {
  harness: HarnessKind;
  userId: string | null;
  tenantId: string | null;
  machineId: string;
  /** Already-known agent session id, if resolved from an earlier session.start. */
  agentSessionId: string | null;
}

export interface IngestDeps {
  /** Authenticate and return the server-owned epoch bound to this capability. */
  authenticate: (harnessSessionId: string, token: string) => string | null;
  /**
   * True while this exact PTY generation may finish ingest work. A terminal
   * event already admitted before exit may complete until a replacement PTY
   * takes ownership; the epoch still comes only from trusted server state.
   */
  isCurrentRuntime: (harnessSessionId: string, runtimeEpoch: string) => boolean;
  /** Raw hook payload -> AnalyticsEvent, or null to skip (e.g. PreToolUse). */
  normalize: (
    hookEvent: string,
    hookPayload: Record<string, unknown>,
    context: NormalizeContext,
  ) => AnalyticsEvent | null;
  /** Look up session context for a harnessSessionId. Undefined = unknown session, drop. */
  resolveSession: (harnessSessionId: string) => IngestSessionContext | undefined;
  /** Called once a session.start event reveals the agent's own session id. */
  /** False rejects a SessionStart whose vendor identity conflicts with its pin. */
  onAgentSessionResolved: (
    harnessSessionId: string,
    agentSessionId: string,
    source: unknown,
    runtimeEpoch: string,
  ) => boolean | Promise<boolean>;
  /**
   * Called once a SessionStart(-equivalent) event is actually processed for
   * a session — the signal that its TUI is genuinely interactive, not just
   * that its pty exists. See `SessionManager.setReady`/`HarnessSession.ready`
   * for what this gates. Fires alongside `onAgentSessionResolved` (same
   * event), kept separate since "ready" and "agent session id known" are
   * conceptually distinct even though they happen to co-occur today.
   */
  onSessionReady?: (harnessSessionId: string, runtimeEpoch: string) => void;
  store: { append(event: AnalyticsEvent): Promise<void> };
  batcher: { enqueue(event: AnalyticsEvent): void };
  /** Optional transcript backfill for turn.completed / session.end. */
  enrichFromTranscript?: (
    event: AnalyticsEvent,
    transcriptPath: string | undefined,
  ) => Promise<AnalyticsEvent>;
  /** Called for every successfully normalized event (after any transcript
   *  enrichment), before it's persisted — e.g. to feed a tool.call event's
   *  command/output text to dev-server port detection. */
  onNormalizedEvent?: (event: AnalyticsEvent, runtimeEpoch: string) => void;
  /** Local-only annotation (for example planner control-turn correlation). */
  decorateEvent?: (
    event: AnalyticsEvent,
    runtimeEpoch: string,
  ) => AnalyticsEvent;
  /** Content-free projection used only for remote product telemetry. */
  projectTelemetryEvent?: (
    event: AnalyticsEvent,
    runtimeEpoch: string,
  ) => AnalyticsEvent;
  /**
   * Called for every event AFTER it has been persisted to the local store —
   * the seam for consumers that need to read the store back and see this event
   * in it. Archiving a session's record on `session.end` is exactly that: fired
   * from `onNormalizedEvent` it would race the append and store a record whose
   * `endedAt` is null.
   *
   * Synchronous and best-effort, like the other hooks here: whatever it starts
   * is the consumer's to detach, and it must not throw.
   */
  onEventPersisted?: (event: AnalyticsEvent, runtimeEpoch: string) => void;
  /**
   * Called for every raw hook event BEFORE normalization — fired even for
   * hook events that don't produce an analytics event. A UI-transport-only
   * passthrough seam (bypasses the analytics normalize/store pipeline) for
   * consumers that need to observe raw hook activity. Currently unused;
   * retained as an extension point.
   */
  onRawHookEvent?: (
    hookEvent: string,
    harnessSessionId: string,
    payload: Record<string, unknown>,
    runtimeEpoch: string,
  ) => void;
  onError?: (err: unknown) => void;
  /** Injectable for tests; defaults to a fresh per-router counter. */
  seqCounter?: SeqCounter;
}

/**
 * Exported so an in-process, non-HTTP event source (currently: the Codex
 * transcript tailer, which has no hook script to POST here) can feed the
 * exact same normalize -> transcript-enrich -> store -> batcher pipeline
 * that a real hook POST goes through, without a needless HTTP round-trip
 * back into this same server. Field names deliberately match the HTTP body
 * shape (hookEvent/harnessSessionId/payload) so callers can construct one
 * directly from whatever `{hookEvent, payload}` pair their event source
 * already produces.
 */
export interface IngestRequestBody {
  hookEvent?: string;
  receivedAt?: string;
  harnessSessionId?: string;
  payload?: Record<string, unknown>;
}

export interface IngestRouterOptions {
  /** Test seam; production permits sustained hook traffic while bounding floods. */
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Shared by HTTP hooks and in-process Codex tailing because both reuse the
 * same sequence counter. SessionStart's awaited durable identity commit must
 * remain ahead of immediately-following prompt/stop events even though the
 * HTTP hook endpoint acknowledges before processing finishes. */
const ingestQueues = new WeakMap<
  SeqCounter,
  Map<string, Promise<unknown>>
>();

export async function processIngest(
  body: IngestRequestBody,
  deps: IngestDeps,
  seqCounter: SeqCounter,
  runtimeEpoch: string,
): Promise<void> {
  const hookEvent = body.hookEvent;
  const harnessSessionId = body.harnessSessionId;
  if (!hookEvent || !harnessSessionId) return;

  let queues = ingestQueues.get(seqCounter);
  if (!queues) {
    queues = new Map();
    ingestQueues.set(seqCounter, queues);
  }
  const prior = queues.get(harnessSessionId) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(() => processIngestNow(body, deps, seqCounter, runtimeEpoch));
  queues.set(harnessSessionId, next);
  try {
    await next;
  } finally {
    if (queues.get(harnessSessionId) === next) queues.delete(harnessSessionId);
  }
}

async function processIngestNow(
  body: IngestRequestBody,
  deps: IngestDeps,
  seqCounter: SeqCounter,
  runtimeEpoch: string,
): Promise<void> {
  const hookEvent = body.hookEvent!;
  const harnessSessionId = body.harnessSessionId!;

  if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;
  const session = deps.resolveSession(harnessSessionId);
  if (!session) return;

  const hookPayload = body.payload ?? {};

  // Fire before normalization so a consumer can observe raw hook events,
  // including ones that produce no analytics event. UI-transport-only seam;
  // no consumer today.
  deps.onRawHookEvent?.(
    hookEvent,
    harnessSessionId,
    hookPayload,
    runtimeEpoch,
  );

  const event = deps.normalize(hookEvent, hookPayload, {
    userId: session.userId,
    tenantId: session.tenantId,
    machineId: session.machineId,
    harnessSessionId,
    harness: session.harness,
    agentSessionId: session.agentSessionId,
    // Assigned here, server-side — never trust ordering from the hook script.
    seq: seqCounter.next(harnessSessionId),
  });
  if (!event) return;

  let finalEvent = event;
  if ((hookEvent === "Stop" || hookEvent === "SessionEnd") && deps.enrichFromTranscript) {
    const transcriptPath =
      typeof hookPayload.transcript_path === "string" ? hookPayload.transcript_path : undefined;
    finalEvent = await deps.enrichFromTranscript(event, transcriptPath);
  }
  if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;

  if (hookEvent === "SessionStart") {
    if (
      finalEvent.agentSessionId &&
      !(await deps.onAgentSessionResolved(
        harnessSessionId,
        finalEvent.agentSessionId,
        finalEvent.payload.source,
        runtimeEpoch,
      ))
    ) {
      // The bearer capability authenticates the harness session, not an
      // arbitrary vendor resume pointer inside its payload. Ignore the entire
      // conflicting start event: it cannot mark the session ready or enter
      // local/remote event history under the pinned identity.
      return;
    }
    if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;
    deps.onSessionReady?.(harnessSessionId, runtimeEpoch);
  } else {
    // Only SessionStart may propose or rotate a vendor identity through the
    // authority check above. Every other hook's `payload.session_id` is
    // model/provider-authored input: pin its local event envelope back to the
    // server-owned session record before indexing, correlation, persistence,
    // or telemetry. Otherwise session A can name B here and make record reads,
    // turn counts, and rehydration coalesce the two conversations locally.
    finalEvent = {
      ...finalEvent,
      agentSessionId: session.agentSessionId,
    };
  }

  if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;
  finalEvent = deps.decorateEvent?.(finalEvent, runtimeEpoch) ?? finalEvent;
  if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;
  deps.onNormalizedEvent?.(finalEvent, runtimeEpoch);
  await deps.store.append(finalEvent);
  if (!deps.isCurrentRuntime(harnessSessionId, runtimeEpoch)) return;
  deps.onEventPersisted?.(finalEvent, runtimeEpoch);
  deps.batcher.enqueue(
    deps.projectTelemetryEvent?.(finalEvent, runtimeEpoch) ?? finalEvent,
  );

  if (hookEvent === "SessionEnd") {
    seqCounter.reset(harnessSessionId);
  }
}

export function createIngestRouter(
  deps: IngestDeps,
  options: IngestRouterOptions = {},
): Router {
  const seqCounter = deps.seqCounter ?? createSeqCounter();
  const router = express.Router();
  const ingestRateLimiter = rateLimit({
    windowMs: options.rateLimitWindowMs ?? 60 * 1000,
    // One local Studio can run many hook-producing sessions concurrently.
    // 100 requests/second leaves ample headroom without allowing an agent or
    // invalid-token caller to spin an unbounded authorization/processing loop.
    max: options.rateLimitMax ?? 6_000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use(express.json({ limit: "1mb" }));

  router.post("/ingest", ingestRateLimiter, (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const body: IngestRequestBody =
      typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
        ? (req.body as IngestRequestBody)
        : {};
    const harnessSessionId =
      typeof body.harnessSessionId === "string" ? body.harnessSessionId : "";
    const runtimeEpoch =
      token !== null && harnessSessionId !== ""
        ? deps.authenticate(harnessSessionId, token)
        : null;
    if (
      token === null ||
      harnessSessionId === "" ||
      runtimeEpoch === null
    ) {
      res.status(401).json({ ok: false });
      return;
    }

    // Always respond fast — a slow/dead harness server must never slow the
    // agent's hook pipeline. Processing happens after the response is sent.
    res.status(200).json({ ok: true });

    void processIngest(body, deps, seqCounter, runtimeEpoch).catch((err) => {
      deps.onError?.(err);
    });
  });

  return router;
}
