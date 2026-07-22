/**
 * spine-client — the intelligence spine (SAP-1804 spike).
 *
 * Runs a Sapiom workflow ON OUR ACCOUNT and streams its progress back turn by
 * turn. This is the mechanism the Assistant (SAP-1806/1808) and Tier-2 canvas
 * enrichment ride: the harness's OWN intelligence runs as Sapiom workflows we
 * author/deploy/run on our account — metered by us, NOT on the user's Claude
 * Code tokens.
 *
 * Two surfaces, mirroring run-state.ts / run-spend.ts:
 *   - START on the CORE surface: `POST /v1/workflows/executions` (header
 *     `x-api-key`). The backend defaults org/tenant from the key, so the run is
 *     owned + billed by OUR tenant — the whole point of the spike.
 *   - STREAM by polling the AGENTS surface via {@link createRunStateFetcher}
 *     (`GET /agents/v1/executions/:id`, header `x-sapiom-api-key`), the same
 *     decode→renderRunState path the run canvas already uses. Each step
 *     transition becomes a {@link SpineFrame}.
 *
 * WHY the key stays server-side: same rationale as run-state.ts — the Sapiom
 * API key is a harness credential that must never reach the browser. The server
 * runs on behalf of the SPA and publishes frames over the event bus; no key
 * ever leaves the process.
 *
 * This client streams via callbacks (one per frame) rather than returning a
 * batch, because the caller (the spine route) forwards each frame onto the
 * event bus as it lands. It is intentionally non-throwing: every failure path
 * resolves to a typed {@link SpineRunResult} with `ok: false`.
 */

import type { RunView, SpineFrame, StepStatus } from "../shared/types.js";
import { createRunStateFetcher, resolveAgentsBaseUrl } from "./run-state.js";
import { resolveCoreBaseUrl } from "./run-spend.js";

/** Default cadence for polling the execution projection while streaming. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Default ceiling on total wait before a still-running spike run is abandoned.
 * Generous — this is a demo/proof path, not a hot loop — but bounded so a stuck
 * or never-materializing execution can't poll forever.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Terminal outcome of a spine run. */
export type SpineRunResult =
  | { ok: true; executionId: string; status: RunView["status"] }
  | { ok: false; status: number; error: string };

export interface SpineClientOpts {
  /** Sapiom API key (the held server-side credential); null when not signed in. */
  apiKey: string | null;
  /** Override the CORE base URL for the start call (resolved from env by default). Test seam. */
  coreBaseUrl?: string;
  /** Override the AGENTS base URL for the poll call (resolved from env by default). Test seam. */
  agentsBaseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Poll cadence while streaming; defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Total wait ceiling; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Sleep implementation between polls. Defaults to a real setTimeout; tests
   * inject a no-wait stub so the poll loop runs instantly.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Clock source (ms). Defaults to Date.now; injectable so tests control the deadline. */
  now?: () => number;
}

/** Callbacks the client invokes as the run unfolds. All are optional. */
export interface SpineRunHandlers {
  /** The run was enqueued on our account; `executionId` is now known. */
  onStarted?: (executionId: string) => void;
  /** A step transitioned since the previous poll. */
  onFrame?: (frame: SpineFrame) => void;
  /** The run reached a terminal state. */
  onFinished?: (executionId: string, status: RunView["status"]) => void;
  /** The run could not be started or streamed. */
  onError?: (error: string) => void;
}

export interface SpineClient {
  /**
   * Start `definitionId` on our account with `input`, then stream its steps
   * until terminal (or timeout). Resolves with the terminal
   * {@link SpineRunResult} once streaming ends.
   */
  run(
    definitionId: string,
    input: Record<string, unknown>,
    handlers?: SpineRunHandlers,
  ): Promise<SpineRunResult>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a spine client. See the module header for the two-surface flow. The
 * client owns no bus — the caller wires {@link SpineRunHandlers} to whatever
 * transport it wants (the spine route forwards them onto the event bus).
 */
export function createSpineClient(opts: SpineClientOpts): SpineClient {
  const {
    apiKey,
    coreBaseUrl = resolveCoreBaseUrl(),
    agentsBaseUrl = resolveAgentsBaseUrl(),
    fetchImpl = fetch,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = realSleep,
    now = Date.now,
  } = opts;

  // Reuse the exact decode→renderRunState pipeline the run canvas polls with,
  // so a spine frame's StepView is identical to a polled run's StepView.
  const stateFetcher = createRunStateFetcher({
    apiKey,
    baseUrl: agentsBaseUrl,
    fetchImpl,
  });

  /** POST the start request; returns the enqueued executionId or a typed error. */
  async function start(
    definitionId: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; executionId: string } | { ok: false; status: number; error: string }> {
    let res: Response;
    try {
      res = await fetchImpl(`${coreBaseUrl}/v1/workflows/executions`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey as string,
          "content-type": "application/json",
        },
        body: JSON.stringify({ definitionId, input }),
      });
    } catch {
      return { ok: false, status: 502, error: "gateway unreachable" };
    }

    if (!res.ok) {
      return { ok: false, status: 502, error: `gateway responded ${res.status}` };
    }

    try {
      const body = (await res.json()) as { executionId?: unknown };
      if (typeof body.executionId !== "string" || body.executionId === "") {
        return { ok: false, status: 502, error: "start response had no executionId" };
      }
      return { ok: true, executionId: body.executionId };
    } catch {
      return { ok: false, status: 502, error: "could not decode start response" };
    }
  }

  return {
    async run(definitionId, input, handlers = {}): Promise<SpineRunResult> {
      // No API key — never touch the network; the harness is not signed in.
      if (!apiKey) {
        const error = "harness is not signed in to Sapiom";
        handlers.onError?.(error);
        return { ok: false, status: 503, error };
      }

      const started = await start(definitionId, input);
      if (!started.ok) {
        handlers.onError?.(started.error);
        return started;
      }
      const { executionId } = started;
      handlers.onStarted?.(executionId);

      // Last-emitted status per step id — a frame fires only on a real
      // transition (first sighting, or a change), never re-emitting a step
      // that hasn't moved since the previous poll.
      const lastStatus = new Map<string, StepStatus>();
      const deadline = now() + timeoutMs;

      for (;;) {
        const result = await stateFetcher.fetch(executionId);

        if (!result.ok) {
          // A freshly enqueued execution's projection can lag behind the start
          // response — keep polling through 404 until it materializes or we
          // time out. Any other upstream error is fatal for this run.
          if (result.status !== 404) {
            handlers.onError?.(result.error);
            return { ok: false, status: result.status, error: result.error };
          }
        } else {
          for (const step of result.runView.steps) {
            if (lastStatus.get(step.id) !== step.status) {
              lastStatus.set(step.id, step.status);
              handlers.onFrame?.({ step });
            }
          }
          if (result.runView.status !== "running") {
            handlers.onFinished?.(executionId, result.runView.status);
            return { ok: true, executionId, status: result.runView.status };
          }
        }

        if (now() >= deadline) {
          const error = "timed out waiting for the run to finish";
          handlers.onError?.(error);
          return { ok: false, status: 504, error };
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}
