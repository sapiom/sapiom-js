/**
 * Spine router — backs POST /api/spine/run (SAP-1804 spike).
 *
 * Triggers a hardcoded Sapiom workflow ON OUR ACCOUNT (authenticated with the
 * held server-side key) and streams its progress to the SPA over the event bus
 * as `spine.*` frames. This is the proof-of-mechanism for the formalized
 * intelligence spine (SAP-1807): the harness's own intelligence runs as Sapiom
 * workflows we own — metered by us, NOT on the user's Claude Code tokens.
 *
 * The route returns immediately (202) with a `spineRunId` the SPA subscribes
 * on; the run then streams asynchronously onto the bus, exactly like the
 * `execution.started` → `/api/runs/:id/state` polling handshake the run canvas
 * already uses. The Sapiom key is held server-side and never reaches the
 * browser — the SPA only ever sees the derived frames.
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";

import type { EventBus } from "../core/event-bus.js";
import {
  createSpineClient,
  type SpineClient,
  type SpineClientOpts,
} from "../core/spine-client.js";

export interface SpineRouterOpts {
  /** Sapiom API key for the cloud surfaces; null when the harness is not authenticated. */
  apiKey: string | null;
  /** The bus every `spine.*` frame is published onto (forwarded to /ws/events). */
  bus: Pick<EventBus, "publish">;
  /**
   * The hardcoded spike workflow definition id. Resolved at the wiring site
   * (env-overridable) so the route itself carries no environment knowledge —
   * the spike runs ONE workflow, but the id isn't baked into this file.
   */
  definitionId: string;
  /** Override the CORE base URL (start call). Test seam. */
  coreBaseUrl?: string;
  /** Override the AGENTS base URL (poll call). Test seam. */
  agentsBaseUrl?: string;
  /** Injectable fetch forwarded to the client. Test seam. */
  fetchImpl?: typeof fetch;
  /**
   * Client factory override — lets tests drive the route with a fake client
   * (no real network / poll loop). Defaults to {@link createSpineClient}.
   */
  createClient?: (opts: SpineClientOpts) => SpineClient;
  /** Correlation-id generator; defaults to crypto.randomUUID. Test seam. */
  generateRunId?: () => string;
}

/**
 * Create the spine router. Mounts `POST /api/spine/run`.
 */
export function createSpineRouter(opts: SpineRouterOpts): Router {
  const router = Router();
  const makeClient = opts.createClient ?? createSpineClient;
  const generateRunId = opts.generateRunId ?? randomUUID;

  /**
   * POST /api/spine/run
   *
   * Body (all optional): `{ definitionId?: string; input?: object }`. Defaults
   * to the hardcoded spike workflow and an empty input. Kicks off the run on
   * our account and streams `spine.*` frames onto the event bus, keyed by the
   * returned `spineRunId`.
   *
   * 202  { spineRunId, definitionId } — run accepted; frames follow on the bus
   * 400  body present but malformed (non-object input / non-string definitionId)
   * 503  harness is not signed in to Sapiom (no key — never touches the network)
   */
  router.post("/api/spine/run", (req, res) => {
    // Mirror the runs router: no key → 503, and never touch the network. The
    // client enforces this too, but returning it here gives the caller a
    // synchronous HTTP signal rather than a bus-only error.
    if (!opts.apiKey) {
      res.status(503).json({ error: "harness is not signed in to Sapiom" });
      return;
    }

    const body = (req.body ?? {}) as {
      definitionId?: unknown;
      input?: unknown;
    };

    if (
      body.definitionId !== undefined &&
      (typeof body.definitionId !== "string" || body.definitionId.trim() === "")
    ) {
      res.status(400).json({ error: "definitionId must be a non-empty string" });
      return;
    }
    if (
      body.input !== undefined &&
      (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))
    ) {
      res.status(400).json({ error: "input must be an object" });
      return;
    }

    const definitionId =
      typeof body.definitionId === "string" ? body.definitionId : opts.definitionId;
    const input = (body.input as Record<string, unknown> | undefined) ?? {};
    const spineRunId = generateRunId();

    const client = makeClient({
      apiKey: opts.apiKey,
      coreBaseUrl: opts.coreBaseUrl,
      agentsBaseUrl: opts.agentsBaseUrl,
      fetchImpl: opts.fetchImpl,
    });

    // executionId is only known once the run is enqueued (onStarted); captured
    // here so per-frame publishes can carry it.
    let executionId = "";

    // Fire-and-forget: the response returns now, frames stream on the bus.
    // run() is non-throwing (typed result), but guard anyway so a bug can never
    // surface as an unhandled rejection.
    void client
      .run(definitionId, input, {
        onStarted: (id) => {
          executionId = id;
          opts.bus.publish({ type: "spine.started", spineRunId, executionId: id });
        },
        onFrame: (frame) => {
          opts.bus.publish({ type: "spine.frame", spineRunId, executionId, frame });
        },
        onFinished: (id, status) => {
          opts.bus.publish({
            type: "spine.finished",
            spineRunId,
            executionId: id,
            status,
          });
        },
        onError: (error) => {
          opts.bus.publish({ type: "spine.error", spineRunId, error });
        },
      })
      .catch((err: unknown) => {
        opts.bus.publish({
          type: "spine.error",
          spineRunId,
          error: err instanceof Error ? err.message : "spine run failed",
        });
      });

    res.status(202).json({ spineRunId, definitionId });
  });

  return router;
}
