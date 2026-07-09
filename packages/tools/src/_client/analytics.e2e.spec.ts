/**
 * End-to-end tests for `capability.call` usage analytics: capability calls made
 * through the Transport must emit real events to a real (in-process) collector —
 * and must be BYTE-IDENTICAL in behavior whether telemetry is on, off, dark, or
 * the collector is down/slow/broken.
 *
 * The collector is `startMockCollector()` from `@sapiom/analytics-core/testing`
 * (a real HTTP server on loopback), wired via the `SAPIOM_ANALYTICS_ENDPOINT`
 * env override. The capability endpoints themselves are an injected transport
 * fetch — analytics delivery uses the real global fetch, so the full path
 * (envelope → batch → HTTP → contract response) is exercised.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SapiomAnalytics } from "@sapiom/analytics-core";
import {
  startMockCollector,
  type MockCollector,
} from "@sapiom/analytics-core/testing";

import { Transport, type TransportConfig } from "./index.js";
import type { AnalyticsHolder } from "./analytics.js";
import { scrape, SearchHttpError, type ScrapeResult } from "../search/index.js";
import { Sandbox } from "../sandboxes/index.js";
import { Repository } from "../repositories/index.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Env every test starts from a clean slate on (saved/restored around each). */
const ENV_KEYS = [
  "SAPIOM_ANALYTICS_ENDPOINT",
  "SAPIOM_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "HOME",
  "USERPROFILE",
] as const;

/** Pre-seeded machine id so envelopes are assertable and no first-run notice prints. */
const SEEDED_ANONYMOUS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** The transport's lazily-created emitter, if any (test-only internal access). */
function analyticsOf(transport: Transport): SapiomAnalytics | undefined {
  return (transport as unknown as { analyticsHolder: AnalyticsHolder })
    .analyticsHolder.instance;
}

describe("capability.call analytics (e2e, mock collector)", () => {
  let collector: MockCollector;
  let tempHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  const createdTransports: Transport[] = [];

  beforeAll(async () => {
    collector = await startMockCollector();
  });

  afterAll(async () => {
    await collector.close();
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Sandbox the identity file into a temp HOME, pre-seeded so the identity is
    // deterministic and the one-time first-run notice never prints from tests.
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-tools-analytics-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fs.mkdirSync(path.join(tempHome, ".sapiom"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, ".sapiom", "analytics.json"),
      JSON.stringify({
        anonymous_id: SEEDED_ANONYMOUS_ID,
        first_run_notice_at: new Date().toISOString(),
      }),
    );
    collector.reset();
  });

  afterEach(async () => {
    // Shut every emitter down (flushes in-flight batches, detaches exit hooks)
    // BEFORE restoring env so nothing bleeds into the next test.
    await Promise.all(
      createdTransports
        .splice(0)
        .map((t) => analyticsOf(t)?.shutdown() ?? Promise.resolve()),
    );
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function enableTelemetry(): void {
    process.env.SAPIOM_ANALYTICS_ENDPOINT = collector.url;
  }

  function makeTransport(
    response: (call: FetchCall) => Response | Promise<Response>,
    config: Omit<TransportConfig, "fetch"> = {},
  ): { transport: Transport; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      return response({ url, init });
    }) as typeof globalThis.fetch;
    const transport = new Transport({
      apiKey: "test-key",
      ...config,
      fetch: fetchMock,
    });
    createdTransports.push(transport);
    return { transport, calls };
  }

  /** Flush the transport's emitter and return every event the collector holds. */
  async function flushedEvents(transport: Transport) {
    await analyticsOf(transport)?.flush();
    return collector.events();
  }

  // Canonical capability responses used across the identical-results matrix.
  const SCRAPE_RAW = {
    url: "https://example.com",
    markdown: "# Example",
    metadata: { title: "Example", statusCode: 200 },
  };

  async function scrapeOnce(): Promise<{
    result: ScrapeResult;
    transport: Transport;
  }> {
    const { transport } = makeTransport(() => jsonResponse(SCRAPE_RAW));
    const result = await scrape(
      { url: "https://example.com" },
      transport,
      "https://api.test",
    );
    return { result, transport };
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  it("a routed capability call emits one full capability.call envelope", async () => {
    enableTelemetry();
    const { result, transport } = await scrapeOnce();
    expect(result.markdown).toBe("# Example"); // the call itself worked

    const events = await flushedEvents(transport);
    expect(events).toHaveLength(1);
    const event = events[0]!;

    expect(event.event_type).toBe("capability.call");
    expect(event.source).toBe("tools");
    expect(event.sdk_name).toBe("@sapiom/tools");
    expect(event.schema_version).toBe("1");
    expect(event.anonymous_id).toBe(SEEDED_ANONYMOUS_ID);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(event.sdk_version).toBe(manifest.version);

    expect(event.data.capability).toBe("web.scrape");
    expect(event.data.method).toBe("POST");
    expect(event.data.url).toBe("https://api.test/v1/capabilities/web.scrape");
    expect(event.data.status).toBe(200);
    expect(event.data.ok).toBe(true);
    expect(typeof event.data.duration_ms).toBe("number");
    expect(event.data.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(event.data.request_bytes).toBe(
      Buffer.byteLength(JSON.stringify({ url: "https://example.com" })),
    );
  });

  it("sends the transport's api key on collector batches for server enrichment", async () => {
    enableTelemetry();
    const { transport } = await scrapeOnce();
    await analyticsOf(transport)?.flush();

    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0]!.headers["x-sapiom-api-key"]).toBe("test-key");
  });

  it("handle methods emit events too — one per HTTP call (sandbox read/write)", async () => {
    enableTelemetry();
    const { transport } = makeTransport(({ init }) =>
      init.method === "PUT" ? jsonResponse({}) : jsonResponse({ content: "hi" }),
    );

    const sandbox = Sandbox.attach(
      "demo",
      { baseUrl: "https://blaxel.test" },
      transport,
    );
    await sandbox.writeFile("notes.txt", "hello");
    await expect(sandbox.readFile("notes.txt")).resolves.toBe("hi");

    const events = await flushedEvents(transport);
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.data.method, e.data.capability])).toEqual([
      ["PUT", "/v1/sandboxes/demo/filesystem/notes.txt"],
      ["GET", "/v1/sandboxes/demo/filesystem/notes.txt"],
    ]);
    expect(events.every((e) => e.event_type === "capability.call")).toBe(true);
  });

  it("transport.request() capability calls are counted exactly once", async () => {
    enableTelemetry();
    const { transport } = makeTransport(() =>
      jsonResponse({ slug: "my-repo", cloneUrl: "https://git.test/my-repo.git" }),
    );

    // Repository.create goes through transport.request → transport.fetch.
    const repo = await Repository.create("my-repo", transport, "https://git.test");
    expect(repo.slug).toBe("my-repo");

    const events = await flushedEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.capability).toBe("/v1/git/repositories");
    expect(events[0]!.data.method).toBe("POST");
  });

  it("captures the HTTP status on a failed call — and the typed error is unchanged", async () => {
    enableTelemetry();
    const { transport } = makeTransport(
      () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(
      scrape({ url: "https://example.com" }, transport, "https://api.test"),
    ).rejects.toMatchObject({
      name: "SearchHttpError",
      status: 500,
      body: { error: "boom" },
    });

    const events = await flushedEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBe(500);
    expect(events[0]!.data.ok).toBe(false);
  });

  it("captures a network-level failure (no status) — and rethrows the original error", async () => {
    enableTelemetry();
    const failure = new TypeError("fetch failed");
    const { transport } = makeTransport(() => {
      throw failure;
    });

    await expect(
      scrape({ url: "https://example.com" }, transport, "https://api.test"),
    ).rejects.toBe(failure); // the exact thrown value, not a wrapper

    const events = await flushedEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.status).toBeUndefined();
    expect(events[0]!.data.ok).toBe(false);
    expect(events[0]!.data.error).toBe("TypeError");
    expect(events[0]!.data.error_message).toBe("fetch failed");
  });

  it("stamps the transport's attribution — including through withAttribution", async () => {
    enableTelemetry();
    const { transport } = makeTransport(() => jsonResponse(SCRAPE_RAW), {
      attribution: { agentName: "researcher", metadata: { runId: "r-1" } },
    });
    const derived = transport.withAttribution({ traceId: "tr_42" });

    await scrape({ url: "https://example.com" }, derived, "https://api.test");

    const events = await flushedEvents(transport); // shared emitter with `derived`
    expect(events).toHaveLength(1);
    expect(events[0]!.data.agent_name).toBe("researcher");
    expect(events[0]!.data.trace_id).toBe("tr_42");
    expect(events[0]!.data.attribution_metadata).toEqual({ runId: "r-1" });
  });

  // -------------------------------------------------------------------------
  // Consent + ship-dark
  // -------------------------------------------------------------------------

  it("SAPIOM_TELEMETRY_DISABLED=1 → zero collector requests, identical result", async () => {
    enableTelemetry();
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";

    const { result, transport } = await scrapeOnce();
    await analyticsOf(transport)?.flush();

    expect(collector.requests).toHaveLength(0);
    expect(analyticsOf(transport)?.enabled).toBe(false);

    // Behavior is identical to telemetry-on.
    delete process.env.SAPIOM_TELEMETRY_DISABLED;
    const { result: withTelemetry } = await scrapeOnce();
    expect(result).toEqual(withTelemetry);
  });

  it("DO_NOT_TRACK=1 → zero collector requests", async () => {
    enableTelemetry();
    process.env.DO_NOT_TRACK = "1";

    const { transport } = await scrapeOnce();
    await analyticsOf(transport)?.flush();

    expect(collector.requests).toHaveLength(0);
  });

  it("ships dark: with no endpoint configured, nothing is sent and nothing is written", async () => {
    // No SAPIOM_ANALYTICS_ENDPOINT. Remove the seeded identity file so any
    // (forbidden) disk write would be visible.
    fs.rmSync(path.join(tempHome, ".sapiom"), { recursive: true, force: true });

    const { result, transport } = await scrapeOnce();
    expect(result.markdown).toBe("# Example");
    await analyticsOf(transport)?.flush();

    expect(collector.requests).toHaveLength(0);
    expect(analyticsOf(transport)?.enabled).toBe(false);
    expect(fs.existsSync(path.join(tempHome, ".sapiom"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Fault injection — capability behavior must be identical in every mode
  // -------------------------------------------------------------------------

  const failureModes = [
    ["down", () => collector.setMode({ kind: "down" })],
    ["responding 500", () => collector.setMode({ kind: "status", status: 500 })],
    ["slow (150ms)", () => collector.setMode({ kind: "slow", delayMs: 150 })],
  ] as const;

  for (const [label, applyMode] of failureModes) {
    it(`collector ${label} → capability result identical, nothing thrown`, async () => {
      // Baseline: telemetry fully dark.
      const { result: baseline } = await scrapeOnce();

      enableTelemetry();
      applyMode();
      const { result, transport } = await scrapeOnce();
      expect(result).toEqual(baseline);

      // Flush (delivery may fail — that must stay invisible) and prove the
      // emitter actually attempted/handled delivery in this mode.
      await expect(
        analyticsOf(transport)?.flush() ?? Promise.resolve(),
      ).resolves.toBeUndefined();
      expect(collector.requests.length).toBeGreaterThan(0);
    });
  }

  it("a failing capability call throws identically whether telemetry is on, dark, or disabled", async () => {
    const failingScrape = async (): Promise<SearchHttpError> => {
      const { transport } = makeTransport(
        () => new Response("upstream exploded", { status: 502 }),
      );
      try {
        await scrape({ url: "https://example.com" }, transport, "https://api.test");
      } catch (error) {
        return error as SearchHttpError;
      }
      throw new Error("scrape unexpectedly succeeded");
    };

    const dark = await failingScrape();

    enableTelemetry();
    const withTelemetry = await failingScrape();

    process.env.SAPIOM_TELEMETRY_DISABLED = "1";
    const disabled = await failingScrape();

    for (const thrown of [withTelemetry, disabled]) {
      expect(thrown.name).toBe(dark.name);
      expect(thrown.message).toBe(dark.message);
      expect(thrown.status).toBe(dark.status);
      expect(thrown.body).toEqual(dark.body);
    }
  });
});
