/**
 * UI-interaction analytics — fire-and-forget client capture.
 *
 * Posts to POST /api/track (the server's UI analytics endpoint) with the
 * current boot token.  Never blocks the UI, never retries, silently drops
 * failures — the server deduplicates via eventId and the local ndjson sink
 * is the ground truth.  Consent semantics are enforced server-side (same
 * store-always / remote-per-consent rule as hook events).
 *
 * Event names are dot-canonical (e.g. "prompt.submitted"), data is
 * UI-interaction metadata only — NEVER include prompt text or user content.
 *
 * See packages/harness/src/shared/types.ts UiEventName for the full
 * canonical list and packages/harness/src/core/collector/ for how the
 * surface:"ui" marker propagates through the pipeline.
 */
import type { UiEventName, UiTrackRequest } from "@shared/types";

import { getBootToken } from "./api";

/**
 * Fire-and-forget UI event capture.
 *
 * @param event  Canonical event name (see UiEventName).
 * @param data   Optional metadata — never include prompt text or PII.
 * @param harnessSessionId  Associate with this session for seq/session dims.
 */
export function track(
  event: UiEventName,
  data?: Record<string, unknown>,
  harnessSessionId?: string,
): void {
  const body: UiTrackRequest = {
    event,
    ...(data ? { data } : {}),
    ...(harnessSessionId ? { harnessSessionId } : {}),
  };

  // Fire-and-forget: never await, never surface errors to the caller.
  fetch("/api/track", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Harness-Token": getBootToken(),
    },
    body: JSON.stringify(body),
    // keepalive so the request survives a page unload (e.g. session.created
    // fires right before navigation in some flows).
    keepalive: true,
  }).catch(() => {
    // Intentionally silent — tracking failures must never affect the UI.
  });
}
