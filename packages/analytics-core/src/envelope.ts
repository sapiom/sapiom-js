import { randomUUID } from "crypto";

import { sanitizeData } from "./data.js";
import type { AnalyticsConfig, Envelope, EnvelopeFields } from "./types.js";

/** Wire schema version. Envelope changes are additive-only within a version. */
export const SCHEMA_VERSION = "1";

/** Envelope keys that per-event overrides may replace. Unknown keys are ignored. */
const OVERRIDABLE_KEYS: ReadonlySet<string> = new Set([
  "event_id",
  "anonymous_id",
  "session_id",
  "event_timestamp",
  "source",
  "event_type",
  "user_id",
  "sdk_name",
  "sdk_version",
  "schema_version",
  "environment",
]);

export interface BuildEnvelopeArgs {
  config: AnalyticsConfig;
  anonymousId: string | null;
  sessionId: string;
  eventType: string;
  data?: Record<string, unknown>;
  overrides?: Partial<EnvelopeFields>;
}

export function buildEnvelope(args: BuildEnvelopeArgs): Envelope {
  const { config, anonymousId, sessionId, eventType, data, overrides } = args;

  const envelope: Envelope = {
    event_id: randomUUID(),
    anonymous_id: anonymousId,
    session_id: sessionId,
    event_timestamp: new Date().toISOString(),
    source: config.source,
    event_type: typeof eventType === "string" ? eventType : String(eventType),
    sdk_name: config.sdkName,
    sdk_version: config.sdkVersion,
    schema_version: SCHEMA_VERSION,
    data: sanitizeData(data),
  };

  // user_id is only ever present when a real identity was provided.
  if (typeof config.userId === "string" && config.userId.length > 0) {
    envelope.user_id = config.userId;
  }

  if (overrides && typeof overrides === "object") {
    const target = envelope as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || !OVERRIDABLE_KEYS.has(key)) continue;
      target[key] = value;
    }
  }

  return envelope;
}
