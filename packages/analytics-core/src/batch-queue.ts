import type { SendOutcome } from "./http-sender.js";
import type { DebugHook, Envelope } from "./types.js";

/** Flush cadence when the batch-size trigger is not hit first. */
export const FLUSH_INTERVAL_MS = 3_000;
/** Batch-size trigger: an immediate flush once this many events are buffered. */
export const MAX_BATCH_SIZE = 20;

const RETRY_BASE_DELAY_MS = 200;
const RETRY_JITTER_MS = 250;

export interface BatchSender {
  send(events: Envelope[]): Promise<SendOutcome>;
}

export interface BatchQueueOptions {
  flushIntervalMs?: number;
  maxBatchSize?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
}

/**
 * In-memory batching with three flush triggers: every {@link FLUSH_INTERVAL_MS},
 * at {@link MAX_BATCH_SIZE} events, or best-effort on process exit
 * (`beforeExit`). Each batch gets at most one retry (small jittered delay),
 * then is silently dropped. All timers are `unref()`ed so the queue never
 * holds the process open.
 */
export class BatchQueue {
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryJitterMs: number;

  private buffer: Envelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private exitListener: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly sender: BatchSender,
    private readonly debug: DebugHook,
    options: BatchQueueOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.retryJitterMs = options.retryJitterMs ?? RETRY_JITTER_MS;

    this.exitListener = () => {
      void this.flushNow();
    };
    try {
      process.on("beforeExit", this.exitListener);
    } catch (error) {
      this.debug("failed to register exit flush", error);
      this.exitListener = null;
    }
  }

  /** Synchronous, never throws (given a sender whose `send` never throws synchronously). */
  enqueue(event: Envelope): void {
    if (this.stopped) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flushNow();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flushNow();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /** Flush the buffer and wait for every in-flight batch. Never rejects. */
  async flush(): Promise<void> {
    try {
      await Promise.all([this.flushNow(), ...this.inFlight]);
    } catch (error) {
      this.debug("flush failed", error);
    }
  }

  /** Flush, then stop accepting events and detach timers/exit hooks. Never rejects. */
  async shutdown(): Promise<void> {
    try {
      this.stopped = true;
      if (this.exitListener) {
        try {
          process.removeListener("beforeExit", this.exitListener);
        } catch {
          // Best effort.
        }
        this.exitListener = null;
      }
      await this.flush();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    } catch (error) {
      this.debug("shutdown failed", error);
    }
  }

  private flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return Promise.resolve();

    const batch = this.buffer;
    this.buffer = [];
    const pending: Promise<void> = this.sendWithRetry(batch)
      .catch((error) => {
        this.debug("batch delivery failed", error);
      })
      .finally(() => {
        this.inFlight.delete(pending);
      });
    this.inFlight.add(pending);
    return pending;
  }

  /** One attempt + at most one retry; anything after that is a silent drop. */
  private async sendWithRetry(batch: Envelope[]): Promise<void> {
    if ((await this.trySend(batch)) !== "retry") return;
    await sleep(this.retryBaseDelayMs + Math.random() * this.retryJitterMs);
    await this.trySend(batch);
  }

  private async trySend(batch: Envelope[]): Promise<SendOutcome> {
    try {
      return await this.sender.send(batch);
    } catch (error) {
      this.debug("send attempt failed", error);
      return "retry";
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
