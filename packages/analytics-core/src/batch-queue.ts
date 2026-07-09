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

// ---------------------------------------------------------------------------
// Module-level shared beforeExit listener registry
//
// One process-level listener replaces the per-instance listener that existed
// previously. This prevents MaxListenersExceededWarning when many short-lived
// emitters are created (e.g. the harness consent-toggle pattern).
//
// Invariants:
// - The shared listener is registered lazily on the first queue registration.
// - It is removed when the registry empties (so listenerCount returns to
//   baseline after the last live instance shuts down — the existing consumer
//   tests that assert listener release keep passing this way).
// - The shared listener never throws; each queue's flushNow is best-effort.
// - The shared listener itself is NOT unref()'d — process.on listeners cannot
//   be unref()'d. The original per-instance approach also did not unref the
//   listener itself; the "unref" semantics in the original code referred to the
//   flush *timer* inside flushNow (setTimeout.unref()), which is unchanged.
//   A lone live emitter therefore does not hold the process open any more or
//   less than before: the beforeExit event only fires when the event loop would
//   otherwise drain, so the unref'd timers still allow natural exit.
// ---------------------------------------------------------------------------

const liveQueues = new Set<BatchQueue>();
let sharedListener: (() => void) | null = null;

/**
 * Register a queue in the module-level registry. Lazily attaches the shared
 * beforeExit listener on the first registration. If process.on throws (e.g.
 * in environments where process events are restricted), calls debug and leaves
 * the listener unregistered — the queue still works, it just won't flush on
 * beforeExit.
 */
function registerQueue(queue: BatchQueue, debug: DebugHook): void {
  liveQueues.add(queue);

  if (sharedListener !== null) {
    // Shared listener already installed — nothing more to do.
    return;
  }

  // First queue: create and register the shared listener.
  sharedListener = () => {
    for (const q of liveQueues) {
      try {
        void q._flushNowShared();
      } catch {
        // Best effort: never let one queue's failure prevent others from flushing.
      }
    }
  };

  try {
    process.on("beforeExit", sharedListener);
  } catch (error) {
    debug("failed to register exit flush", error);
    // Registration failed — clear so the next queue registration can retry.
    sharedListener = null;
    // The queue is still in liveQueues; it will be flushed if registration
    // ever succeeds later (when a subsequent queue is constructed), or not at
    // all if the environment permanently blocks process.on.
  }
}

/**
 * Remove a queue from the module-level registry. When the registry empties,
 * the shared listener is removed from process so that listenerCount returns
 * to baseline — this is required by the existing tests that assert listener
 * release on shutdown.
 */
function unregisterQueue(queue: BatchQueue): void {
  liveQueues.delete(queue);
  if (liveQueues.size === 0 && sharedListener !== null) {
    try {
      process.removeListener("beforeExit", sharedListener);
    } catch {
      // Best effort.
    }
    sharedListener = null;
  }
}

/**
 * In-memory batching with three flush triggers: every {@link FLUSH_INTERVAL_MS},
 * at {@link MAX_BATCH_SIZE} events, or best-effort on process exit
 * (`beforeExit`). Each batch gets at most one retry (small jittered delay),
 * then is silently dropped. All timers are `unref()`ed so the queue never
 * holds the process open.
 *
 * All live instances share a single module-level `beforeExit` listener so that
 * constructing many short-lived emitters never triggers a
 * MaxListenersExceededWarning.
 */
export class BatchQueue {
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryJitterMs: number;

  private buffer: Envelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  /** Whether this instance is currently registered in the module-level registry. */
  private registered = false;

  constructor(
    private readonly sender: BatchSender,
    private readonly debug: DebugHook,
    options: BatchQueueOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? MAX_BATCH_SIZE;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.retryJitterMs = options.retryJitterMs ?? RETRY_JITTER_MS;

    // Register immediately on construction — matches the original timing
    // (per-instance listener was registered in the constructor).
    this.registered = true;
    registerQueue(this, this.debug);
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

  /**
   * Silently drop all buffered events. In-flight sends (already on the wire)
   * complete normally — they cannot be recalled. Does not stop the queue and
   * does NOT unregister from the shared beforeExit listener.
   * Use before {@link shutdown} when the caller wants to discard, not drain.
   */
  discard(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
  }

  /** Flush, then stop accepting events and detach timers/exit hooks. Never rejects. */
  async shutdown(): Promise<void> {
    try {
      this.stopped = true;
      if (this.registered) {
        this.registered = false;
        unregisterQueue(this);
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

  /**
   * Called by the module-level shared beforeExit listener. Exposed as a
   * package-internal method (name-mangled via underscore convention) to keep
   * the public API clean while still being reachable from module scope.
   * Never throws.
   *
   * @internal
   */
  _flushNowShared(): Promise<void> {
    return this.flushNow();
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
