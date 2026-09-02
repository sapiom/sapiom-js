/**
 * Shared polling for the async media capabilities (SAP-3097).
 *
 * Image and video generation both submit a job to the same queue and then poll a
 * result URL through the Sapiom gateway. Before SAP-3097 every non-OK poll response
 * was treated as "still generating", so a job that terminally failed in three seconds
 * burned the caller's full `timeoutMs` and then threw `… did not complete within
 * 300000ms` — the opposite of what happened.
 *
 * This module owns the one poll loop both media types use, so their terminal-failure
 * semantics cannot drift apart.
 *
 * Two channels report a terminal failure, and both are read:
 *
 * 1. **The polled body itself.** A queue response carries `status` plus (on a
 *    completed-with-error job) `error` / `error_type`. {@link terminalFailureFrom}
 *    classifies it, mirroring the gateway's own terminal-status classification of the
 *    same wire contract.
 * 2. **The status endpoint**, consulted when the result endpoint answers non-OK. That
 *    answer is ambiguous on its own — a failed job never publishes a result body, but
 *    neither does a job that is merely still running, and neither does a gateway that
 *    just blipped. The status endpoint reports terminal state unambiguously, so it is
 *    what breaks the tie between "terminally failed" and "keep polling". It is a tie
 *    break, not a second poll: see {@link STATUS_PROBE_EVERY}.
 */
import type { Transport } from "../_client/index.js";
import { ContentGenerationFailedError } from "./errors.js";

/** Wait between polls. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How often to spend a status request while the result endpoint keeps answering non-OK:
 * on the first such poll, then every Nth after it.
 *
 * Some queues report "not ready yet" as a non-OK result response, so an unthrottled probe
 * would double the request count for a job's entire lifetime — a 5-minute video at the 5s
 * default goes from ~60 gateway requests to ~120, per waiting caller. The probe exists to
 * break a tie, not to be a second poll: probing on the first non-OK still catches a job
 * that failed immediately, and every 4th after that bounds detection to four poll
 * intervals while holding the extra load to ~25%.
 */
const STATUS_PROBE_EVERY = 4;

/**
 * Read a response body as JSON without ever throwing, and without leaving an unread
 * stream behind (an undrained body keeps the connection from being reused).
 * Returns `undefined` when the body is absent or isn't JSON.
 */
async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    try {
      await res.body?.cancel();
    } catch {
      // best-effort drain
    }
    return undefined;
  }
}

/**
 * The provider's own words for why a job failed, from whichever field carries them.
 * `undefined` when the response carries no error content — which covers both "said nothing
 * useful" and the empty `error: ""` / `error_type: ""` a queue can emit on the happy path.
 */
function providerErrorMessage(
  body: Record<string, unknown>,
): string | undefined {
  for (const raw of [body.error, body.error_type, body.detail]) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "object" && raw !== null) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
      try {
        const serialized = JSON.stringify(raw);
        if (serialized && serialized !== "{}" && serialized !== "[]")
          return serialized;
      } catch {
        // Fall through to the next candidate field.
      }
    }
  }
  return undefined;
}

/**
 * Classify a queue response body: the provider's failure message when the job reached a
 * terminal FAILED state, `null` when it did not (still queued, still running, finished
 * cleanly, or a shape we don't recognize — all of which mean "keep polling").
 *
 * Deliberately conservative. Only an explicit terminal marker ends the poll, so an
 * unfamiliar body or a transport blip never gets reported to the caller as a generation
 * failure. Mirrors the gateway's own classification of the same wire contract — the two
 * must agree.
 *
 * @internal Exported for tests.
 */
export function terminalFailureFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const status =
    typeof record.status === "string" ? record.status.trim().toUpperCase() : "";
  switch (status) {
    case "FAILED":
    case "ERROR":
    case "CANCELLED":
    case "CANCELED":
      return (
        providerErrorMessage(record) ?? `job reported ${status.toLowerCase()}`
      );
    case "COMPLETED": {
      // Unlike the statuses above, COMPLETED is terminal-SUCCESS by default: the error
      // content is the only thing that makes it a failure. So it has to be real content,
      // not merely a present key — a queue that emits `error: ""` on a clean completion
      // would otherwise fail a job while it is handing back the asset.
      return providerErrorMessage(record) ?? null;
    }
    default:
      // IN_QUEUE / IN_PROGRESS / no status at all — not terminal, keep polling.
      return null;
  }
}

/**
 * Ask the status endpoint whether the job has terminally failed. Best-effort: a status
 * endpoint that is itself unreachable or unparseable answers "don't know", which the
 * caller treats as "keep polling" — the same conservative default as an unrecognized body.
 */
async function probeStatusForFailure(
  transport: Transport,
  statusUrl: string,
): Promise<string | null> {
  try {
    const res = await transport.fetch(statusUrl, { method: "GET" });
    return terminalFailureFrom(await readJsonBody(res));
  } catch {
    return null;
  }
}

/**
 * The status endpoint for a job, given its result endpoint. The platform hands out both,
 * but only `responseUrl` is threaded through the poll; this recovers the sibling URL from
 * the queue's `.../requests/:id[/status]` convention when a handle carried no `statusUrl`.
 */
export function statusUrlFromResultUrl(resultUrl: string): string | undefined {
  try {
    const url = new URL(resultUrl);
    if (url.pathname.endsWith("/status")) return url.toString();
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/status`;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface PollForResultOptions<T> {
  transport: Transport;
  /** The result endpoint. Polling it is also what persists the output when `storage` was requested. */
  resultUrl: string;
  /** The canonical terminal channel, consulted only when `resultUrl` answers non-OK. */
  statusUrl?: string;
  /** Queue request id — carried on both the timeout and the failure error. */
  requestId: string;
  timeoutMs: number;
  pollMs: number;
  /** How this medium is named in error messages, e.g. `"Image"`. */
  label: string;
  /** The mapped result when this body carries a finished asset; `undefined` while it doesn't. */
  finished: (body: unknown) => T | undefined;
}

/**
 * Poll a launched media job to a terminal state.
 *
 * Resolves with the mapped result on success. Throws
 * {@link ContentGenerationFailedError} — promptly, not at the deadline — when the job
 * terminally failed, carrying the provider's own error message. Throws a plain `Error`
 * when `timeoutMs` elapses with the job still in flight.
 */
export async function pollForResult<T>({
  transport,
  resultUrl,
  statusUrl,
  requestId,
  timeoutMs,
  pollMs,
  label,
  finished,
}: PollForResultOptions<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nonOkPolls = 0;
  while (Date.now() < deadline) {
    const res = await transport.fetch(resultUrl, { method: "GET" });
    const body = await readJsonBody(res);

    // The failure marker is read BEFORE the result predicate. A terminal body can still
    // carry an empty container for the asset it never produced — `{ status: "COMPLETED",
    // error: "…", images: [] }` — and reporting that as a successful empty result is the
    // exact ambiguity this module exists to remove.
    const failure = terminalFailureFrom(body);
    if (failure !== null)
      throw new ContentGenerationFailedError(label, requestId, failure, body);

    if (res.ok) {
      const result = finished(body);
      if (result !== undefined) return result;
      // A 2xx that isn't the finished asset is an in-progress status body. Keep polling.
      nonOkPolls = 0;
    } else {
      // Non-OK is ambiguous — a terminally failed job publishes no result, but neither
      // does one that is simply not done yet, nor a gateway that briefly blipped. The
      // status endpoint breaks the tie; it is consulted on a slower cadence than the
      // poll so a queue that reports in-progress this way doesn't cost double.
      nonOkPolls += 1;
      if (statusUrl && nonOkPolls % STATUS_PROBE_EVERY === 1) {
        const statusFailure = await probeStatusForFailure(transport, statusUrl);
        if (statusFailure !== null)
          throw new ContentGenerationFailedError(
            label,
            requestId,
            statusFailure,
            body,
          );
      }
    }

    await sleep(pollMs);
  }
  throw new Error(
    `${label} generation did not complete within ${timeoutMs}ms (request id: ${requestId})`,
  );
}
