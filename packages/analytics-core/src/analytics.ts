import { randomUUID } from "crypto";

import { BatchQueue } from "./batch-queue.js";
import { resolveConsent } from "./consent.js";
import { buildEnvelope } from "./envelope.js";
import { HttpSender, resolveEndpoint } from "./http-sender.js";
import { IdentityStore } from "./identity.js";
import type {
  AnalyticsConfig,
  DebugHook,
  EnvelopeFields,
  SapiomAnalytics,
} from "./types.js";

/** Printed to stderr once per machine, on the first-ever tracked event. */
export const FIRST_RUN_NOTICE =
  "Sapiom collects anonymous usage analytics to improve the SDK. " +
  "Opt out: SAPIOM_TELEMETRY_DISABLED=1 (https://docs.sapiom.ai/telemetry)";

let processSessionId: string | null = null;

/** One session id per process, shared by every analytics instance. */
function getProcessSessionId(): string {
  if (processSessionId === null) processSessionId = randomUUID();
  return processSessionId;
}

/**
 * Create an analytics emitter.
 *
 * Guarantees, regardless of configuration or environment:
 * - `createAnalytics` and `track` never throw
 * - `flush`/`shutdown` never reject
 * - nothing is written or sent unless consent resolves to enabled AND a
 *   collector endpoint is explicitly configured (`endpoint` in the config or
 *   the `SAPIOM_ANALYTICS_ENDPOINT` environment variable) — the default
 *   build ships dark
 */
export function createAnalytics(config: AnalyticsConfig): SapiomAnalytics {
  try {
    return buildAnalytics(config);
  } catch (error) {
    try {
      config?.debug?.("analytics initialization failed; disabled", error);
    } catch {
      // Never throw.
    }
    return createDisabledInstance(safeSessionId());
  }
}

function buildAnalytics(config: AnalyticsConfig): SapiomAnalytics {
  const debug: DebugHook = (message, detail) => {
    try {
      config.debug?.(message, detail);
    } catch {
      // The debug hook itself must never take the host down.
    }
  };

  const sessionId = getProcessSessionId();
  if (!resolveConsent(config)) return createDisabledInstance(sessionId);

  // Ship-dark: with no explicitly configured endpoint there is nowhere to
  // send, so the instance is a full no-op — events are dropped at enqueue,
  // nothing is written to disk, and no first-run notice is printed.
  const endpoint = resolveEndpoint(config.endpoint);
  if (endpoint === null) {
    debug("no collector endpoint configured; analytics is a no-op");
    return createDisabledInstance(sessionId);
  }

  const identityStore = new IdentityStore(debug);
  const sender = new HttpSender({
    endpoint,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl,
    debug,
  });
  const queue = new BatchQueue(sender, debug);

  let noticeAttempted = false;
  let stopped = false;

  return {
    track(
      eventType: string,
      data?: Record<string, unknown>,
      overrides?: Partial<EnvelopeFields>,
    ): void {
      try {
        if (stopped) return;
        const identity = identityStore.load();

        // First-ever tracked event across all packages on this machine
        // prints a one-line notice (marker lives in the identity file).
        if (!noticeAttempted) {
          noticeAttempted = true;
          if (identityStore.markFirstRunNoticeShown()) {
            try {
              process.stderr.write(FIRST_RUN_NOTICE + "\n");
            } catch {
              // Best effort.
            }
          }
        }

        queue.enqueue(
          buildEnvelope({
            config,
            anonymousId: identity ? identity.anonymous_id : null,
            sessionId,
            eventType,
            data,
            overrides,
          }),
        );
      } catch (error) {
        debug("track failed", error);
      }
    },

    async flush(): Promise<void> {
      try {
        await queue.flush();
      } catch (error) {
        debug("flush failed", error);
      }
    },

    async shutdown(): Promise<void> {
      try {
        stopped = true;
        await queue.shutdown();
      } catch (error) {
        debug("shutdown failed", error);
      }
    },

    enabled: true,

    get anonymousId(): string | null {
      try {
        return identityStore.load()?.anonymous_id ?? null;
      } catch {
        return null;
      }
    },

    sessionId,
  };
}

function createDisabledInstance(sessionId: string): SapiomAnalytics {
  return {
    track(): void {
      // Consent denied: drop at the entry, before anything is touched.
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
    enabled: false,
    anonymousId: null,
    sessionId,
  };
}

function safeSessionId(): string {
  try {
    return getProcessSessionId();
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
}
