/**
 * Acceptance tests for the harness analytics emitter (analytics-core adapter).
 *
 * The SAPIOM_TELEMETRY_DISABLED=1 guard in vitest.config.ts ensures these
 * tests never dial the real collector. Tests that assert delivery explicitly
 * delete that var and point SAPIOM_ANALYTICS_ENDPOINT at a real mock collector
 * (startMockCollector from @sapiom/analytics-core/testing).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN_NOTICE } from "@sapiom/analytics-core";
import { startMockCollector, type MockCollector } from "@sapiom/analytics-core/testing";

import {
  createHarnessEmitter,
  type HarnessEmitter,
} from "./analytics-emitter.js";
import type { AnalyticsEvent, CollectorContext, HarnessKind } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONTEXT: CollectorContext = {
  harnessVersion: "0.1.0",
  os: "darwin",
  arch: "arm64",
  nodeVersion: "v20.0.0",
};

function makeEvent(
  overrides: Partial<AnalyticsEvent> = {},
): AnalyticsEvent {
  return {
    eventId: crypto.randomUUID(),
    seq: 1,
    ts: new Date().toISOString(),
    userId: null,
    tenantId: null,
    machineId: "machine-test",
    harnessSessionId: "harness-session-1",
    agentSessionId: null,
    harness: "claude-code" as HarnessKind,
    type: "session.start",
    payload: {},
    ...overrides,
  };
}

interface TempHome {
  dir: string;
  restore(): void;
}

function useTempHome(): TempHome {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-emitter-test-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    dir,
    restore() {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHarnessEmitter", () => {
  let home: TempHome;
  let collector: MockCollector;
  let emitter: HarnessEmitter;
  const prevDisabled = process.env.SAPIOM_TELEMETRY_DISABLED;
  const prevEndpoint = process.env.SAPIOM_ANALYTICS_ENDPOINT;

  beforeEach(async () => {
    home = useTempHome();
    collector = await startMockCollector();
    // Opt delivery tests back in by clearing the vitest guard and pointing at mock.
    delete process.env.SAPIOM_TELEMETRY_DISABLED;
    process.env.SAPIOM_ANALYTICS_ENDPOINT = collector.url;
  });

  afterEach(async () => {
    await emitter?.close();
    await collector?.close();
    home.restore();
    // Restore env
    if (prevDisabled === undefined) delete process.env.SAPIOM_TELEMETRY_DISABLED;
    else process.env.SAPIOM_TELEMETRY_DISABLED = prevDisabled;
    if (prevEndpoint === undefined) delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    else process.env.SAPIOM_ANALYTICS_ENDPOINT = prevEndpoint;
  });

  // -------------------------------------------------------------------------
  // E2E: envelopes arrive at mock collector with correct shape
  // -------------------------------------------------------------------------

  it("e2e: sends contract-valid envelopes with source=harness and harness fields", async () => {
    const harnessSessionId = "sess-e2e-" + crypto.randomUUID();
    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(
      makeEvent({
        type: "session.start",
        harnessSessionId,
        seq: 1,
        agentSessionId: "agent-uuid-1",
        harness: "claude-code",
        payload: { model: "claude-sonnet" },
      }),
    );
    emitter.enqueue(
      makeEvent({
        type: "prompt.submitted",
        harnessSessionId,
        seq: 2,
        agentSessionId: "agent-uuid-1",
        payload: { prompt: "hello" },
      }),
    );

    await emitter.flush();
    await collector.waitForRequests(1);

    const events = collector.events();
    expect(events.length).toBeGreaterThanOrEqual(2);

    for (const ev of events) {
      expect(ev.source).toBe("harness");
      expect(ev.session_id).toBe(harnessSessionId);
      expect(ev.sdk_name).toBe("@sapiom/harness");
      expect(ev.schema_version).toBe("1");
      expect(typeof ev.event_id).toBe("string");
      expect(typeof ev.anonymous_id).toBe("string"); // set from analytics.json
      expect(ev.data).toMatchObject({
        harness_session_id: harnessSessionId,
        harness_kind: "claude-code",
        context: {
          app_version: "0.1.0",
          os: "darwin",
          arch: "arm64",
          node: "v20.0.0",
        },
      });
    }

    // Event types verbatim
    const types = events.map((e) => e.event_type);
    expect(types).toContain("session.start");
    expect(types).toContain("prompt.submitted");

    // seq monotonic per session
    const seqs = events.map((e) => (e.data as Record<string, unknown>).seq as number);
    expect(seqs).toEqual([1, 2]);
  });

  it("e2e: different harness sessions produce separate session_id values", async () => {
    const sessionA = "sess-A-" + crypto.randomUUID();
    const sessionB = "sess-B-" + crypto.randomUUID();

    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(makeEvent({ harnessSessionId: sessionA, type: "session.start", seq: 1 }));
    emitter.enqueue(makeEvent({ harnessSessionId: sessionB, type: "session.start", seq: 1 }));

    await emitter.flush();
    await collector.waitForRequests(1);

    const events = collector.events();
    const sessionIds = new Set(events.map((e) => e.session_id));
    expect(sessionIds.has(sessionA)).toBe(true);
    expect(sessionIds.has(sessionB)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Retry dedup: stable event_ids on retry
  // -------------------------------------------------------------------------

  it("retry dedup: retried batch carries the same event_ids", async () => {
    // analytics-core's BatchQueue does ONE retry per batch with jitter.
    // We verify the retry carries the same event_ids by:
    //  1. Starting the flush while the collector is down (500)
    //  2. Letting the first attempt land
    //  3. Switching to ok so the retry succeeds
    //  4. Checking both captured batches share event_ids
    collector.setMode({ kind: "status", status: 500 });

    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    const eventId = crypto.randomUUID();
    emitter.enqueue(makeEvent({ eventId, type: "session.start", seq: 1 }));

    // Start the flush asynchronously — do NOT await yet so we can interleave
    // the mode switch between the initial attempt and the retry.
    const flushPromise = emitter.flush();

    // Wait for the first (500) attempt to be captured by the mock.
    await collector.waitForRequests(1, 5000);
    // Now switch to ok so the retry sees a 202.
    collector.setMode({ kind: "ok" });

    // Await the flush; it waits for the retry to complete.
    await flushPromise;

    // Both attempts should be captured: initial (500) + retry (202).
    expect(collector.requests.length).toBeGreaterThanOrEqual(2);

    // The retried batch must carry the same event_id as the initial attempt.
    const batches = collector.batches();
    if (batches.length >= 2) {
      const firstIds = batches[0].map((e) => e.event_id);
      const secondIds = batches[1].map((e) => e.event_id);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(true);
    } else {
      // Only 1 batch captured — both attempts used the same event body.
      expect(batches[0].some((e) => e.event_id === eventId)).toBe(true);
    }
  }, 10_000);

  // -------------------------------------------------------------------------
  // Consent: declined → zero collector requests
  // -------------------------------------------------------------------------

  it("consent: telemetryOptIn=false → zero collector requests, emitter is no-op", async () => {
    emitter = createHarnessEmitter({
      telemetryOptIn: false,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    await emitter.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(collector.requests).toHaveLength(0);
  });

  it("consent: SAPIOM_TELEMETRY_DISABLED=1 → zero collector requests", async () => {
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";

    emitter = createHarnessEmitter({
      telemetryOptIn: true, // would be opted in, but env flag wins
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    await emitter.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(collector.requests).toHaveLength(0);
  });

  it("consent: setTelemetryOptIn(false) stops further enqueuing", async () => {
    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    // Events before opt-out
    emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    await emitter.flush();
    await collector.waitForRequests(1);

    const countBefore = collector.events().length;

    // Opt out
    emitter.setTelemetryOptIn(false);

    // Events after opt-out should not reach the collector
    emitter.enqueue(makeEvent({ type: "prompt.submitted", seq: 2 }));
    await emitter.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(collector.events().length).toBe(countBefore);
  });

  it("consent: opt-out mid-flight drops the in-memory queue (zero deliveries after opt-out)", async () => {
    // Reproduce the old batcher's "drops the queue immediately when opting
    // out mid-flight" invariant. Events enqueued AFTER setTelemetryOptIn(false)
    // must never reach the collector — the buffer is discarded, not drained.
    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    // Enqueue but do NOT flush — events sit in the buffer
    emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    emitter.enqueue(makeEvent({ type: "prompt.submitted", seq: 2 }));

    // Opt out before any flush: the buffer must be discarded
    emitter.setTelemetryOptIn(false);

    // Flush the new (disabled) instance + wait for any lingering shutdown drain
    await emitter.flush();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No requests must have arrived at the collector
    expect(collector.requests).toHaveLength(0);
  }, 5_000);

  // -------------------------------------------------------------------------
  // Identity migration: analytics.json lifecycle
  // -------------------------------------------------------------------------

  it("identity: fresh HOME → analytics.json created with mode 0600, events carry its id", async () => {
    const analyticsPath = path.join(home.dir, ".sapiom", "analytics.json");
    expect(fs.existsSync(analyticsPath)).toBe(false);

    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    await emitter.flush();
    await collector.waitForRequests(1);

    // File was created with correct permissions
    expect(fs.existsSync(analyticsPath)).toBe(true);
    expect(fs.statSync(analyticsPath).mode & 0o777).toBe(0o600);

    const record = JSON.parse(fs.readFileSync(analyticsPath, "utf8")) as { anonymous_id: string };
    const events = collector.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].anonymous_id).toBe(record.anonymous_id);
  });

  it("identity: unwritable HOME → id null, nothing crashes", async () => {
    // Point HOME below a regular file to block mkdir
    const blocker = path.join(home.dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    process.env.HOME = path.join(blocker, "nested");
    process.env.USERPROFILE = process.env.HOME;

    expect(() => {
      emitter = createHarnessEmitter({
        telemetryOptIn: true,
        context: TEST_CONTEXT,
        sdkName: "@sapiom/harness",
        sdkVersion: "0.1.0",
        endpoint: collector.url,
      });
    }).not.toThrow();

    expect(() => {
      emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
    }).not.toThrow();

    await expect(emitter.flush()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Eager first-run notice (CLI passthrough: print pre-spawn, never mid-TUI)
  // -------------------------------------------------------------------------

  it("eagerFirstRunNotice: prints at creation and never again on tracked events; disabled emitter stays silent", async () => {
    const writes: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const noticeCount = (): number => writes.filter((w) => w.includes(FIRST_RUN_NOTICE)).length;
    try {
      emitter = createHarnessEmitter({
        telemetryOptIn: true,
        context: TEST_CONTEXT,
        sdkName: "@sapiom/harness",
        sdkVersion: "0.1.0",
        endpoint: collector.url,
        eagerFirstRunNotice: true,
      });
      // Printed at creation — before any event is tracked.
      expect(noticeCount()).toBe(1);

      // And the shown-marker is persisted, so nothing reprints later.
      const record = JSON.parse(
        fs.readFileSync(path.join(home.dir, ".sapiom", "analytics.json"), "utf8"),
      ) as { first_run_notice_at: string | null };
      expect(typeof record.first_run_notice_at).toBe("string");

      emitter.enqueue(makeEvent({ type: "session.start", seq: 1 }));
      await emitter.flush();
      expect(noticeCount()).toBe(1);
      await emitter.close();

      // Consent gates the eager path too: a disabled emitter must not print.
      emitter = createHarnessEmitter({
        telemetryOptIn: false,
        context: TEST_CONTEXT,
        sdkName: "@sapiom/harness",
        sdkVersion: "0.1.0",
        endpoint: collector.url,
        eagerFirstRunNotice: true,
      });
      expect(noticeCount()).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Envelope mapping: agent_session_id, tenant_id
  // -------------------------------------------------------------------------

  it("envelope: agent_session_id and tenant_id flow into data", async () => {
    emitter = createHarnessEmitter({
      telemetryOptIn: true,
      context: TEST_CONTEXT,
      sdkName: "@sapiom/harness",
      sdkVersion: "0.1.0",
      endpoint: collector.url,
    });

    emitter.enqueue(
      makeEvent({
        type: "tool.call",
        agentSessionId: "agent-abc",
        tenantId: "tenant-xyz",
        seq: 5,
        payload: { toolName: "Bash" },
      }),
    );

    await emitter.flush();
    await collector.waitForRequests(1);

    const events = collector.events();
    expect(events.length).toBeGreaterThan(0);
    const data = events[0].data as Record<string, unknown>;
    expect(data.agent_session_id).toBe("agent-abc");
    expect(data.tenant_id).toBe("tenant-xyz");
    expect(data.seq).toBe(5);
    expect(data.toolName).toBe("Bash"); // payload merged in
  });
});
