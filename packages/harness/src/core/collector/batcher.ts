/**
 * In-memory queue -> batched POST to the remote collector, at
 * `${SAPIOM_COLLECTOR_URL}/v1/harness/events`.
 *
 * Gated by telemetry opt-in: when off (or when no collector URL is
 * configured at all), `enqueue` is a no-op — events still land in the local
 * ndjson store via a separate path, this is only the remote fan-out.
 *
 * Response contract: any 2xx = accepted, drop the batch from the queue.
 * 4xx = permanent failure, drop without retry (a malformed batch will never
 * succeed by resending it). 5xx or a network error = transient, retry with
 * exponential backoff, then drop.
 */

import * as crypto from "node:crypto";

import {
  ANALYTICS_SCHEMA_VERSION,
  ENV,
  type AnalyticsEvent,
  type CollectorBatch,
  type CollectorContext,
} from "../../shared/types.js";

const EVENTS_PATH = "/v1/harness/events";
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const RETRY_BACKOFF_MS = [500, 1000, 2000];
/** Hard ceiling so a long collector outage can't grow memory unbounded. */
const MAX_QUEUE_SIZE = 1000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CollectorBatcherOptions {
  machineId: string;
  telemetryOptIn: boolean;
  /** Static per-install/boot context sent at the batch level. */
  context: CollectorContext;
  /** Base URL; `/v1/harness/events` is appended. Defaults to `process.env[ENV.collectorUrl]`. */
  collectorUrl?: string;
  /** Sapiom API key; sent as `Authorization: Bearer <key>`. Omitted (anonymous) when null/unset. */
  apiKey?: string | null;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  onDebug?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CollectorBatcher {
  private readonly machineId: string;
  private readonly context: CollectorContext;
  private readonly eventsUrl: string | undefined;
  private readonly maxBatchSize: number;
  private readonly fetchImpl: FetchLike;
  private readonly onDebug: (message: string) => void;
  private readonly timer: ReturnType<typeof setInterval> | null;
  private queue: AnalyticsEvent[] = [];
  private telemetryOptIn: boolean;
  private apiKey: string | null;
  private flushing = false;
  private warnedNoCollectorUrl = false;

  constructor(options: CollectorBatcherOptions) {
    this.machineId = options.machineId;
    this.context = options.context;
    this.telemetryOptIn = options.telemetryOptIn;
    this.apiKey = options.apiKey ?? null;
    const collectorUrl = options.collectorUrl ?? process.env[ENV.collectorUrl];
    this.eventsUrl = collectorUrl ? `${collectorUrl.replace(/\/$/, "")}${EVENTS_PATH}` : undefined;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
    this.onDebug = options.onDebug ?? (() => {});

    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (this.eventsUrl) {
      this.timer = setInterval(() => {
        void this.flush();
      }, flushIntervalMs);
      this.timer.unref?.();
    } else {
      this.timer = null;
    }
  }

  setTelemetryOptIn(optIn: boolean): void {
    this.telemetryOptIn = optIn;
    if (!optIn) this.queue = [];
  }

  /** Update the auth key used on subsequent flushes (e.g. after login/logout). */
  setApiKey(apiKey: string | null): void {
    this.apiKey = apiKey;
  }

  /** Queue an event for the next batch. No-op unless opted in and configured. */
  enqueue(event: AnalyticsEvent): void {
    if (!this.telemetryOptIn) return;
    if (!this.eventsUrl) {
      if (!this.warnedNoCollectorUrl) {
        this.warnedNoCollectorUrl = true;
        this.onDebug(`${ENV.collectorUrl} not set — remote analytics batching disabled`);
      }
      return;
    }

    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      const dropped = this.queue.length - MAX_QUEUE_SIZE;
      this.queue = this.queue.slice(dropped);
      this.onDebug(`dropped ${dropped} queued analytics events (queue over capacity)`);
    }

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Send whatever is queued now, with retry/backoff, dropping on final failure. */
  async flush(): Promise<void> {
    if (this.flushing || !this.eventsUrl || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const events = this.queue.splice(0, this.maxBatchSize);
      const batch: CollectorBatch = {
        batchId: crypto.randomUUID(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        machineId: this.machineId,
        sentAt: new Date().toISOString(),
        context: this.context,
        events,
      };
      await this.sendWithRetry(this.eventsUrl, batch);
    } finally {
      this.flushing = false;
    }
  }

  private async sendWithRetry(url: string, batch: CollectorBatch): Promise<void> {
    const body = JSON.stringify(batch);
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Anonymous traffic is valid (identity then rests on machineId); the
    // header is only sent once a Sapiom user is actually logged in.
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
        });

        if (res.ok) return; // any 2xx = accepted

        if (res.status >= 400 && res.status < 500) {
          // Permanent failure — resending an unprocessable batch never helps.
          this.onDebug(
            `dropping batch of ${batch.events.length} events: collector rejected with ${res.status}`,
          );
          return;
        }

        throw new Error(`collector responded ${res.status}`);
      } catch (err) {
        const isLastAttempt = attempt === RETRY_BACKOFF_MS.length;
        if (isLastAttempt) {
          this.onDebug(
            `dropping batch of ${batch.events.length} events after ${attempt + 1} attempts: ${String(err)}`,
          );
          return;
        }
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }

  /** Flush everything queued, then stop the periodic timer. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}
