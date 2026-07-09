/**
 * Tests for POST /api/track — the UI-interaction analytics endpoint.
 *
 * Verifies:
 *   - Valid events are stored locally (always) and enqueued for remote (gated).
 *   - store.append() is called for every valid event regardless of consent.
 *   - batcher.enqueue() is called (remote delivery, consent assumed by batcher).
 *   - Invalid event names are rejected with 400.
 *   - Missing uiTrack deps yield 501.
 *   - Response is 200 OK with no blocking on the async writes.
 */
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpHome };
});

import type { AnalyticsEvent } from "../shared/types.js";
import { createRestRouter, type RestRouterOptions } from "./rest.js";

const TOKEN_HEADER = { "Content-Type": "application/json", "X-Harness-Token": "unused-in-router-tests" };

function makeBaseOptions(overrides: Partial<RestRouterOptions> = {}): RestRouterOptions {
  return {
    sessionManager: {
      list: () => [],
      get: () => undefined,
      create: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      write: vi.fn(),
      submitInput: vi.fn(),
      setBoundWorkflowPath: vi.fn(),
    } as unknown as RestRouterOptions["sessionManager"],
    adapters: {},
    version: "0.0.1-test",
    identity: null,
    listWorkflows: async () => [],
    listMacros: () => [],
    findWorkflow: () => null,
    writeWorkspaceContext: vi.fn().mockResolvedValue(undefined),
    onTelemetryOptInChange: vi.fn(),
    launchDir: "/tmp/test-launch-dir",
    ...overrides,
  };
}

describe("POST /api/track", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let stored: AnalyticsEvent[];
  let enqueued: AnalyticsEvent[];

  function start(overrides: Partial<RestRouterOptions> = {}) {
    stored = [];
    enqueued = [];
    const uiTrack: RestRouterOptions["uiTrack"] = {
      store: {
        append: vi.fn(async (event: AnalyticsEvent) => {
          stored.push(event);
        }),
      },
      batcher: {
        enqueue: vi.fn((event: AnalyticsEvent) => {
          enqueued.push(event);
        }),
      },
      nextSeq: vi.fn(() => 1),
      machineId: "machine-test",
      userId: "user-test",
      tenantId: "tenant-test",
    };
    const app = express();
    app.use(createRestRouter(makeBaseOptions({ uiTrack, ...overrides })));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "harness-track-test-"));
    start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns 200 for a valid event", async () => {
    const res = await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "prompt.submitted", data: { length: 42 } }),
    });
    expect(res.status).toBe(200);
  });

  it("stores the event locally (store.append) for every valid event", async () => {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "session.created" }),
    });
    // Give the async fire-and-forget a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("session.created");
    expect((stored[0].payload as Record<string, unknown>).surface).toBe("ui");
  });

  it("enqueues for remote delivery (batcher.enqueue)", async () => {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "consent.changed", data: { optIn: true } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe("consent.changed");
  });

  it("includes data fields in payload", async () => {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "macro.invoked", data: { macroId: "visualize" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored[0].payload).toMatchObject({ macroId: "visualize", surface: "ui" });
  });

  it("uses harnessSessionId from body in the event", async () => {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "session.switched", harnessSessionId: "sess-abc" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored[0].harnessSessionId).toBe("sess-abc");
  });

  it("generates a synthetic session id when no harnessSessionId is provided", async () => {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "prompt.submitted", data: { length: 5 } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored[0].harnessSessionId).toMatch(/^ui-/);
  });

  it("returns 400 for an unknown event name", async () => {
    const res = await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ event: "unknown.event" }),
    });
    expect(res.status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("returns 400 for a missing event field", async () => {
    const res = await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: TOKEN_HEADER,
      body: JSON.stringify({ data: { foo: "bar" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 501 when uiTrack is not configured", async () => {
    // Start a fresh server without uiTrack.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const app2 = express();
    app2.use(createRestRouter(makeBaseOptions({ uiTrack: undefined })));
    const server2 = app2.listen(0);
    const address2 = server2.address() as AddressInfo;
    const url2 = `http://127.0.0.1:${address2.port}`;

    try {
      const res = await fetch(`${url2}/track`, {
        method: "POST",
        headers: TOKEN_HEADER,
        body: JSON.stringify({ event: "session.created" }),
      });
      expect(res.status).toBe(501);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it("all UiEventName values are accepted", async () => {
    const events = [
      "prompt.submitted",
      "session.switched",
      "macro.invoked",
      "visualize.triggered",
      "consent.changed",
      "session.created",
    ] as const;

    for (const event of events) {
      const res = await fetch(`${baseUrl}/track`, {
        method: "POST",
        headers: TOKEN_HEADER,
        body: JSON.stringify({ event }),
      });
      expect(res.status, `expected 200 for event "${event}"`).toBe(200);
    }
  });
});
