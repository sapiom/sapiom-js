/**
 * enrich-canvas-client — a one-shot run of the Sapiom `enrich-canvas` workflow
 * ON OUR ACCOUNT that AWAITS the run's final output.
 *
 * This is the producer behind Tier-2 canvas enrichment (SAP-1800). Unlike
 * spine-client.ts — which streams step transitions and returns only the terminal
 * STATUS — the canvas coordinator needs the workflow's OUTPUT (the
 * `CanvasEnrichment` JSON the terminal step returns). So this client starts the
 * run, polls to terminal, and hands back the decoded `ExecutionProjection.output`
 * for the coordinator to validate.
 *
 * Two surfaces, mirroring run-state.ts / spine-client.ts:
 *   - START on the CORE surface: `POST /v1/workflows/executions` (header
 *     `x-api-key`). The backend defaults org/tenant from the key, so the run is
 *     owned + billed by OUR tenant — 0 user Claude tokens, the whole point.
 *   - POLL the AGENTS surface: `GET /agents/v1/executions/:id` (header
 *     `x-sapiom-api-key`), decoded with `decodeExecutionProjection` (the same
 *     decode the run canvas uses), reading `.output` off the terminal projection.
 *
 * WHY the key stays server-side: same rationale as run-state.ts / spine-client.ts
 * — the Sapiom API key is a harness credential that must never reach the browser.
 * The harness server runs on behalf of the SPA; no key ever leaves the process.
 *
 * Intentionally non-throwing: every failure path resolves to a typed
 * {@link EnrichCanvasRunResult} with `ok: false`, so the coordinator degrades to
 * the Tier-1 render without a try/catch at the call site.
 */

import { decodeExecutionProjection, isExecutionTerminal } from "@sapiom/agent-core";

import { resolveAgentsBaseUrl } from "./run-state.js";
import { resolveCoreBaseUrl } from "./run-spend.js";

/** Default cadence for polling the execution projection while awaiting. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Default ceiling on total wait before a still-running enrichment is abandoned.
 * Generous — a single LLM annotation step — but bounded so a stuck or
 * never-materializing execution can't poll forever (the Tier-1 render stands).
 */
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

/** Terminal outcome of a one-shot enrich-canvas run. */
export type EnrichCanvasRunResult =
  | { ok: true; executionId: string; output: unknown }
  | { ok: false; status: number; error: string };

export interface EnrichCanvasClientOpts {
  /** Sapiom API key (the held server-side credential); null when not signed in. */
  apiKey: string | null;
  /** Override the CORE base URL for the start call (resolved from env by default). Test seam. */
  coreBaseUrl?: string;
  /** Override the AGENTS base URL for the poll call (resolved from env by default). Test seam. */
  agentsBaseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Poll cadence while awaiting; defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
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

export interface EnrichCanvasClient {
  /**
   * Start `definitionId` on our account with `input`, poll until terminal (or
   * timeout), and resolve with the run's output on success. `output` is the
   * raw `terminate(...)` value — the coordinator validates it against the
   * `CanvasEnrichment` schema.
   */
  run(definitionId: string, input: Record<string, unknown>): Promise<EnrichCanvasRunResult>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create an enrich-canvas client. See the module header for the two-surface
 * flow. Non-throwing: all outcomes are typed results.
 */
export function createEnrichCanvasClient(opts: EnrichCanvasClientOpts): EnrichCanvasClient {
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

  /** GET + decode one projection poll; `output`/`status` off the decoded shape. */
  async function poll(
    executionId: string,
  ): Promise<
    | { ok: true; status: string; output: unknown }
    | { ok: false; status: number; error: string }
  > {
    let res: Response;
    try {
      res = await fetchImpl(
        `${agentsBaseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`,
        { headers: { "x-sapiom-api-key": apiKey as string } },
      );
    } catch {
      return { ok: false, status: 502, error: "gateway unreachable" };
    }

    if (res.status === 404) {
      // A freshly enqueued execution's projection can lag the start response.
      return { ok: false, status: 404, error: "execution not found" };
    }
    if (!res.ok) {
      return { ok: false, status: 502, error: `gateway responded ${res.status}` };
    }

    try {
      const raw = (await res.json()) as Record<string, unknown>;
      const decoded = decodeExecutionProjection(raw);
      return { ok: true, status: decoded.status, output: decoded.output };
    } catch {
      return { ok: false, status: 502, error: "could not decode execution" };
    }
  }

  return {
    async run(definitionId, input): Promise<EnrichCanvasRunResult> {
      // No API key — never touch the network; the harness is not signed in.
      if (!apiKey) {
        return { ok: false, status: 503, error: "harness is not signed in to Sapiom" };
      }

      const started = await start(definitionId, input);
      if (!started.ok) return started;
      const { executionId } = started;

      const deadline = now() + timeoutMs;
      for (;;) {
        const result = await poll(executionId);

        if (!result.ok) {
          // Keep polling through 404 until the projection materializes; any
          // other upstream error is fatal for this run.
          if (result.status !== 404) return result;
        } else if (isExecutionTerminal(result.status)) {
          if (result.status === "completed") {
            return { ok: true, executionId, output: result.output };
          }
          return {
            ok: false,
            status: 502,
            error: `enrich-canvas run ended ${result.status}`,
          };
        }

        if (now() >= deadline) {
          return { ok: false, status: 504, error: "timed out waiting for the run to finish" };
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}
