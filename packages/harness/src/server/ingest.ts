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
  /** Per-boot secret; requests without a matching bearer token are rejected. */
  ingestToken: string;
  /** Raw hook payload -> AnalyticsEvent, or null to skip (e.g. PreToolUse). */
  normalize: (
    hookEvent: string,
    hookPayload: Record<string, unknown>,
    context: NormalizeContext,
  ) => AnalyticsEvent | null;
  /** Look up session context for a harnessSessionId. Undefined = unknown session, drop. */
  resolveSession: (harnessSessionId: string) => IngestSessionContext | undefined;
  /** Called once a session.start event reveals the agent's own session id. */
  onAgentSessionResolved: (harnessSessionId: string, agentSessionId: string) => void;
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
  onNormalizedEvent?: (event: AnalyticsEvent) => void;
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

function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export async function processIngest(
  body: IngestRequestBody,
  deps: IngestDeps,
  seqCounter: SeqCounter,
): Promise<void> {
  const hookEvent = body.hookEvent;
  const harnessSessionId = body.harnessSessionId;
  if (!hookEvent || !harnessSessionId) return;

  const session = deps.resolveSession(harnessSessionId);
  if (!session) return;

  const hookPayload = body.payload ?? {};
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

  if (hookEvent === "SessionStart" && finalEvent.agentSessionId) {
    deps.onAgentSessionResolved(harnessSessionId, finalEvent.agentSessionId);
  }

  deps.onNormalizedEvent?.(finalEvent);
  await deps.store.append(finalEvent);
  deps.batcher.enqueue(finalEvent);

  if (hookEvent === "SessionEnd") {
    seqCounter.reset(harnessSessionId);
  }
}

export function createIngestRouter(deps: IngestDeps): Router {
  const seqCounter = deps.seqCounter ?? createSeqCounter();
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.post("/ingest", (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (token !== deps.ingestToken) {
      res.status(401).json({ ok: false });
      return;
    }

    // Always respond fast — a slow/dead harness server must never slow the
    // agent's hook pipeline. Processing happens after the response is sent.
    res.status(200).json({ ok: true });

    void processIngest(req.body as IngestRequestBody, deps, seqCounter).catch((err) => {
      deps.onError?.(err);
    });
  });

  return router;
}
