/**
 * Direct unit tests for the internal modules: envelope builder, data
 * sanitation, consent resolver, endpoint resolution, HTTP sender, and batch
 * queue.
 *
 * The sibling suites exercise these through `createAnalytics`, which cannot
 * distinguish some fine-grained behaviors (exact `SendOutcome` values, retry
 * delays, exit-hook flushes, defensive catch blocks). These tests pin those
 * down; most exist to kill mutants surviving `pnpm test:mutation` — see
 * `stryker.conf.json`.
 */
import { BatchQueue, type BatchSender } from "../batch-queue.js";
import { resolveConsent } from "../consent.js";
import { MAX_FIELD_LENGTH, sanitizeData } from "../data.js";
import { buildEnvelope } from "../envelope.js";
import {
  HttpSender,
  resolveEndpoint,
  type SendOutcome,
} from "../http-sender.js";
import type { AnalyticsConfig, Envelope, EnvelopeFields } from "../types.js";
import { createCapturingFetch, TEST_ENDPOINT } from "./helpers.js";

const baseConfig = (
  overrides: Partial<AnalyticsConfig> = {},
): AnalyticsConfig => ({
  source: "tools",
  sdkName: "@sapiom/tools",
  sdkVersion: "1.2.3",
  ...overrides,
});

/** Save the listed env vars, delete them, and return a restore fn. */
function stashEnv(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

/** Poll until `predicate` is true (real timers only). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("buildEnvelope (unit)", () => {
  const build = (
    config: AnalyticsConfig,
    overrides?: Partial<EnvelopeFields>,
  ) =>
    buildEnvelope({
      config,
      anonymousId: "anon-1",
      sessionId: "22222222-2222-4222-8222-222222222222",
      eventType: "unit_event",
      overrides,
    });

  it("omits user_id when userId is missing or empty", () => {
    expect("user_id" in build(baseConfig())).toBe(false);
    expect("user_id" in build(baseConfig({ userId: "" }))).toBe(false);
    expect(build(baseConfig({ userId: "usr_1" })).user_id).toBe("usr_1");
  });

  it("applies every documented overridable envelope key", () => {
    const overrides: Partial<EnvelopeFields> = {
      event_id: "33333333-3333-4333-8333-333333333333",
      anonymous_id: "anon-override",
      session_id: "44444444-4444-4444-8444-444444444444",
      event_timestamp: "2020-01-01T00:00:00.000Z",
      source: "cli",
      event_type: "overridden_event",
      user_id: "usr_override",
      sdk_name: "@sapiom/other",
      sdk_version: "9.9.9",
      schema_version: "0",
      environment: "test",
    };
    const envelope = build(baseConfig(), overrides);
    for (const [key, value] of Object.entries(overrides)) {
      expect(envelope[key as keyof Envelope]).toBe(value);
    }
  });

  it("skips explicitly-undefined override values", () => {
    const envelope = build(baseConfig({ userId: "usr_1" }), {
      session_id: undefined,
      user_id: undefined,
    });
    expect(envelope.session_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(envelope.user_id).toBe("usr_1");
  });

  it("tolerates a null overrides argument", () => {
    const envelope = build(
      baseConfig(),
      null as unknown as Partial<EnvelopeFields>,
    );
    expect(envelope.session_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(envelope.event_type).toBe("unit_event");
  });

  it("stringifies a non-string event type", () => {
    const envelope = buildEnvelope({
      config: baseConfig(),
      anonymousId: null,
      sessionId: "22222222-2222-4222-8222-222222222222",
      eventType: 42 as unknown as string,
    });
    expect(envelope.event_type).toBe("42");
  });
});

describe("sanitizeData (unit)", () => {
  it("returns an empty object for null and undefined input", () => {
    // toStrictEqual: `{}` must have NO keys, not a `value: undefined` key.
    expect(sanitizeData(undefined)).toStrictEqual({});
    expect(sanitizeData(null)).toStrictEqual({});
  });

  it("keeps a string exactly at the cap untouched", () => {
    const atCap = "a".repeat(MAX_FIELD_LENGTH);
    const data = sanitizeData({ s: atCap });
    expect(data.s).toBe(atCap);
    expect("_truncated" in data).toBe(false);
  });

  it("truncates an oversized string to raw characters (not its JSON form)", () => {
    const overCap = "a".repeat(MAX_FIELD_LENGTH + 1);
    const data = sanitizeData({ s: overCap });
    // The string path must slice the string itself; the JSON path would
    // leave a leading quote from the serialized form.
    expect(data.s).toBe("a".repeat(MAX_FIELD_LENGTH));
    expect(data._truncated).toBe(true);
  });

  it("keeps a non-string whose serialized form is exactly at the cap", () => {
    // JSON.stringify({ k: "x".repeat(n) }) === `{"k":"x…x"}` → n + 8 chars.
    const inner = "x".repeat(MAX_FIELD_LENGTH - 8);
    const value = { k: inner };
    expect(JSON.stringify(value)).toHaveLength(MAX_FIELD_LENGTH);

    const data = sanitizeData({ obj: value });
    expect(data.obj).toEqual(value); // still the object, not a sliced string
    expect("_truncated" in data).toBe(false);
  });

  it("preserves explicitly-undefined fields without flagging truncation", () => {
    const data = sanitizeData({ keep: "yes", gone: undefined });
    expect(data.keep).toBe("yes");
    expect("gone" in data).toBe(true);
    expect(data.gone).toBeUndefined();
    expect("_truncated" in data).toBe(false);
  });

  it("returns an empty object when enumerating the input throws", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile input");
        },
      },
    );
    expect(sanitizeData(hostile)).toStrictEqual({});
  });
});

describe("resolveConsent (unit)", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = stashEnv(["SAPIOM_TELEMETRY_DISABLED", "DO_NOT_TRACK"]);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("treats whitespace-padded opt-out flags as set", () => {
    process.env.SAPIOM_TELEMETRY_DISABLED = " TRUE ";
    expect(resolveConsent(baseConfig())).toBe(false);
    delete process.env.SAPIOM_TELEMETRY_DISABLED;

    process.env.DO_NOT_TRACK = " 1 ";
    expect(resolveConsent(baseConfig())).toBe(false);
  });

  it("resolves to strict false when reading the config itself throws", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile config");
        },
      },
    ) as AnalyticsConfig;
    expect(resolveConsent(hostile)).toBe(false);
  });
});

describe("resolveEndpoint (unit)", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = stashEnv(["SAPIOM_ANALYTICS_ENDPOINT"]);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("stays dark (null, no throw) when nothing is configured", () => {
    expect(resolveEndpoint()).toBeNull();
    expect(resolveEndpoint(undefined)).toBeNull();
  });

  it("does not treat empty strings as endpoints", () => {
    expect(resolveEndpoint("")).toBeNull();

    process.env.SAPIOM_ANALYTICS_ENDPOINT = "";
    expect(resolveEndpoint()).toBeNull();
    expect(resolveEndpoint("")).toBeNull();
  });

  it("prefers the config endpoint over the environment override", () => {
    process.env.SAPIOM_ANALYTICS_ENDPOINT = "http://127.0.0.1:9/env";
    expect(resolveEndpoint("http://127.0.0.1:9/config")).toBe(
      "http://127.0.0.1:9/config",
    );
    expect(resolveEndpoint()).toBe("http://127.0.0.1:9/env");
  });
});

describe("HttpSender (unit)", () => {
  const sampleEvent: Envelope = {
    event_id: "55555555-5555-4555-8555-555555555555",
    anonymous_id: null,
    session_id: "66666666-6666-4666-8666-666666666666",
    event_timestamp: "2020-01-01T00:00:00.000Z",
    source: "tools",
    event_type: "unit_event",
    sdk_name: "@sapiom/tools",
    sdk_version: "1.2.3",
    schema_version: "1",
    data: {},
  };

  const makeSender = (
    options: Partial<ConstructorParameters<typeof HttpSender>[0]> = {},
  ) => {
    const messages: string[] = [];
    const sender = new HttpSender({
      endpoint: TEST_ENDPOINT,
      debug: (message) => messages.push(message),
      ...options,
    });
    return { sender, messages };
  };

  it("maps HTTP responses to exact SendOutcome values", async () => {
    const cases: Array<[number, SendOutcome]> = [
      [202, "ok"],
      [400, "drop"],
      [413, "drop"],
      [429, "retry"],
      [500, "retry"],
      [503, "retry"],
    ];
    for (const [status, expected] of cases) {
      const capture = createCapturingFetch({ status });
      const { sender } = makeSender({ fetchImpl: capture.fetchImpl });
      await expect(sender.send([sampleEvent])).resolves.toBe(expected);
    }
  });

  it("attaches a timeout AbortSignal by default", async () => {
    const capture = createCapturingFetch();
    const { sender } = makeSender({ fetchImpl: capture.fetchImpl });
    await sender.send([sampleEvent]);
    expect(capture.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns drop when no fetch implementation exists anywhere", async () => {
    const globalWithFetch = globalThis as { fetch?: unknown };
    const realFetch = globalWithFetch.fetch;
    globalWithFetch.fetch = undefined;
    try {
      const { sender } = makeSender();
      await expect(sender.send([sampleEvent])).resolves.toBe("drop");
    } finally {
      globalWithFetch.fetch = realFetch;
    }
  });

  it("returns drop when the global fetch is not callable", async () => {
    const globalWithFetch = globalThis as { fetch?: unknown };
    const realFetch = globalWithFetch.fetch;
    globalWithFetch.fetch = "not a function";
    try {
      const { sender } = makeSender();
      await expect(sender.send([sampleEvent])).resolves.toBe("drop");
    } finally {
      globalWithFetch.fetch = realFetch;
    }
  });

  it("drops an unserializable batch and reports it via debug", async () => {
    const capture = createCapturingFetch();
    const { sender, messages } = makeSender({ fetchImpl: capture.fetchImpl });
    const poisoned = {
      ...sampleEvent,
      data: { big: BigInt(7) } as unknown as Record<string, unknown>,
    };
    await expect(sender.send([poisoned])).resolves.toBe("drop");
    expect(capture.calls).toHaveLength(0);
    expect(messages).toContain("batch not serializable; dropped");
  });

  it("reports network failures via debug and asks for a retry", async () => {
    const capture = createCapturingFetch({ reject: true });
    const { sender, messages } = makeSender({ fetchImpl: capture.fetchImpl });
    await expect(sender.send([sampleEvent])).resolves.toBe("retry");
    expect(messages).toContain("collector request failed");
  });
});

describe("BatchQueue (unit)", () => {
  const makeEnvelope = (n: number): Envelope => ({
    event_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    anonymous_id: null,
    session_id: "77777777-7777-4777-8777-777777777777",
    event_timestamp: "2020-01-01T00:00:00.000Z",
    source: "tools",
    event_type: "unit_event",
    sdk_name: "@sapiom/tools",
    sdk_version: "1.2.3",
    schema_version: "1",
    data: { n },
  });

  const queues: BatchQueue[] = [];
  let debugMessages: string[];

  const track = (queue: BatchQueue): BatchQueue => {
    queues.push(queue);
    return queue;
  };

  const makeQueue = (
    sender: BatchSender,
    options: ConstructorParameters<typeof BatchQueue>[2] = {},
  ) =>
    track(
      new BatchQueue(sender, (message) => debugMessages.push(message), options),
    );

  const senderOf = (
    impl: (events: Envelope[]) => Promise<SendOutcome>,
  ): { send: jest.Mock<Promise<SendOutcome>, [Envelope[]]> } => ({
    send: jest.fn(impl),
  });

  beforeEach(() => {
    debugMessages = [];
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await Promise.all(queues.splice(0).map((queue) => queue.shutdown()));
  });

  it("delivers buffered events on beforeExit without an explicit flush", async () => {
    const sender = senderOf(async () => "ok");
    const queue = makeQueue(sender, {
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
    });

    queue.enqueue(makeEnvelope(1));
    expect(sender.send).not.toHaveBeenCalled();

    process.emit("beforeExit", 0);
    await waitFor(() => sender.send.mock.calls.length === 1);
    expect(sender.send.mock.calls[0][0]).toEqual([makeEnvelope(1)]);
  });

  it("drops events enqueued after shutdown", async () => {
    const sender = senderOf(async () => "ok");
    const queue = makeQueue(sender, {
      flushIntervalMs: 60_000,
      maxBatchSize: 1,
    });

    await queue.shutdown();
    queue.enqueue(makeEnvelope(1));
    await queue.flush();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("recovers the interval timer after a timer flush: no stale timer, no early flush", async () => {
    jest.useFakeTimers();
    const sender = senderOf(async () => "ok");
    const queue = makeQueue(sender, {
      flushIntervalMs: 100,
      maxBatchSize: 10,
    });

    // Three staggered enqueues share ONE timer from the first event.
    queue.enqueue(makeEnvelope(1)); // t=0, timer due at t=100
    await jest.advanceTimersByTimeAsync(10);
    queue.enqueue(makeEnvelope(2)); // t=10
    await jest.advanceTimersByTimeAsync(10);
    queue.enqueue(makeEnvelope(3)); // t=20

    await jest.advanceTimersByTimeAsync(85); // t=105 — interval flush fired
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0][0]).toHaveLength(3);

    // A post-flush event must wait a FULL interval: no leftover timer may
    // flush it early, and the cleared timer must not block re-scheduling
    // (a stale handle here would strand the event in the buffer forever).
    queue.enqueue(makeEnvelope(4)); // t=105, due at t=205
    await jest.advanceTimersByTimeAsync(50); // t=155
    expect(sender.send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60); // t=215
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send.mock.calls[1][0]).toEqual([makeEnvelope(4)]);
  });

  it("waits the configured jittered delay before the retry attempt", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    const outcomes: SendOutcome[] = ["retry", "ok"];
    const sender = senderOf(async () => outcomes.shift() ?? "ok");
    const queue = makeQueue(sender, {
      maxBatchSize: 1,
      retryBaseDelayMs: 50,
      retryJitterMs: 100, // delay = 50 + 0.5 * 100 = 100ms exactly
    });

    queue.enqueue(makeEnvelope(1));
    await jest.advanceTimersByTimeAsync(0);
    expect(sender.send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60); // t=60 < 100: retry not due yet
    expect(sender.send).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60); // t=120 ≥ 100: retry happened
    expect(sender.send).toHaveBeenCalledTimes(2);
    // The retried batch is the SAME batch — same event_ids (CONTRACT.md).
    expect(sender.send.mock.calls[1][0]).toEqual(sender.send.mock.calls[0][0]);
  });

  it("retries once with the same batch when the sender rejects, then drops", async () => {
    const sender = senderOf(async () => {
      throw new Error("sender exploded");
    });
    const queue = makeQueue(sender, {
      maxBatchSize: 1,
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
    });

    expect(() => queue.enqueue(makeEnvelope(1))).not.toThrow();
    await waitFor(() => sender.send.mock.calls.length === 2);
    await expect(queue.flush()).resolves.toBeUndefined();

    expect(sender.send).toHaveBeenCalledTimes(2); // one attempt + one retry
    expect(
      debugMessages.filter((message) => message === "send attempt failed"),
    ).toHaveLength(2);
  });

  it("never throws when the timer implementation returns a handle without unref", async () => {
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      realSetTimeout(fn, ms);
      return {} as unknown as NodeJS.Timeout; // no .unref on the handle
    }) as unknown as typeof setTimeout);

    const outcomes: SendOutcome[] = ["retry", "ok"];
    const sender = senderOf(async () => outcomes.shift() ?? "ok");
    const queue = makeQueue(sender, {
      flushIntervalMs: 20,
      maxBatchSize: 100,
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
    });

    // Covers both unref sites: the flush timer (enqueue) and the retry sleep.
    expect(() => queue.enqueue(makeEnvelope(1))).not.toThrow();
    await waitFor(() => sender.send.mock.calls.length === 2);
  });

  it("reports delivery failure via debug when the retry cannot be scheduled", async () => {
    const sender = senderOf(async () => "retry");
    const queue = makeQueue(sender, {
      maxBatchSize: 1, // size-triggered flush: no flush timer involved
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
    });

    const spy = jest.spyOn(global, "setTimeout").mockImplementation((() => {
      throw new Error("timers unavailable");
    }) as unknown as typeof setTimeout);
    try {
      expect(() => queue.enqueue(makeEnvelope(1))).not.toThrow();
      await expect(queue.flush()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(debugMessages).toContain("batch delivery failed");
  });

  it("flush never rejects, even when clearing the timer throws", async () => {
    const sender = senderOf(async () => "ok");
    const queue = makeQueue(sender, {
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
    });
    queue.enqueue(makeEnvelope(1)); // schedules the flush timer

    const spy = jest.spyOn(global, "clearTimeout").mockImplementation(() => {
      throw new Error("timers unavailable");
    });
    try {
      await expect(queue.flush()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(debugMessages).toContain("flush failed");
  });

  it("reports a failed exit-hook registration and keeps working", async () => {
    const spy = jest.spyOn(process, "on").mockImplementation((() => {
      throw new Error("beforeExit unavailable");
    }) as unknown as typeof process.on);

    let queue!: BatchQueue;
    try {
      expect(() => {
        queue = makeQueue(
          senderOf(async () => "ok"),
          { maxBatchSize: 100 },
        );
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(debugMessages).toContain("failed to register exit flush");

    // The queue itself must still deliver.
    const sender = senderOf(async () => "ok");
    const working = makeQueue(sender, { maxBatchSize: 1 });
    working.enqueue(makeEnvelope(1));
    await waitFor(() => sender.send.mock.calls.length === 1);
    await queue.shutdown();
  });

  it("shutdown never rejects, even when an inner step throws", async () => {
    const sender = senderOf(async () => "ok");
    const queue = makeQueue(sender, { maxBatchSize: 100 });

    // Force shutdown into its defensive catch via a PUBLIC surface (flush),
    // so the test survives any rename of internal fields.
    jest.spyOn(queue, "flush").mockImplementation(() => {
      throw new Error("flush exploded");
    });

    await expect(queue.shutdown()).resolves.toBeUndefined();
    expect(debugMessages).toContain("shutdown failed");
  });
});
