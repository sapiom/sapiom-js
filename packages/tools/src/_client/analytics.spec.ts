/**
 * Unit tests for the `capability.call` analytics helpers: capability-name
 * derivation, event payload shape, SDK version resolution, and the
 * one-emitter-per-client holder sharing. End-to-end delivery (mock collector,
 * consent, fault injection) lives in `analytics.e2e.spec.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CAPABILITY_CALL_EVENT,
  capabilityCallData,
  capabilityFromUrl,
  resolveSdkVersion,
  urlWithoutQuery,
  type AnalyticsHolder,
} from "./analytics.js";
import { VERSION } from "../_generated/version.js";
import { Transport } from "./index.js";
import { createClient } from "../client.js";

describe("CAPABILITY_CALL_EVENT", () => {
  it("is the canonical dot-form event name", () => {
    expect(CAPABILITY_CALL_EVENT).toBe("capability.call");
  });
});

describe("capabilityFromUrl()", () => {
  it("extracts the capability id from a routed call URL", () => {
    expect(
      capabilityFromUrl("https://api.sapiom.ai/v1/capabilities/web.scrape"),
    ).toBe("web.scrape");
  });

  it("decodes an URL-encoded routed capability id", () => {
    expect(
      capabilityFromUrl(
        "https://api.sapiom.ai/v1/capabilities/email.domain%2Dsearch",
      ),
    ).toBe("email.domain-search");
  });

  it("tolerates a trailing slash on a routed call URL", () => {
    expect(
      capabilityFromUrl("https://api.test/v1/capabilities/email.verify/"),
    ).toBe("email.verify");
  });

  it("uses the URL path for service-gateway capabilities", () => {
    expect(
      capabilityFromUrl(
        "https://blaxel.services.sapiom.ai/v1/sandboxes/demo/filesystem/notes.txt",
      ),
    ).toBe("/v1/sandboxes/demo/filesystem/notes.txt");
    expect(
      capabilityFromUrl("https://git.services.sapiom.ai/v1/git/repositories"),
    ).toBe("/v1/git/repositories");
  });

  it("does not treat deeper /v1/capabilities/… paths as routed ids", () => {
    expect(
      capabilityFromUrl("https://api.test/v1/capabilities/web.scrape/extra"),
    ).toBe("/v1/capabilities/web.scrape/extra");
  });

  it("returns the raw string when the URL is unparseable", () => {
    expect(capabilityFromUrl("not a url")).toBe("not a url");
  });
});

describe("capabilityCallData()", () => {
  const base = {
    url: "https://api.test/v1/capabilities/web.scrape",
    method: "POST" as string | undefined,
    requestBody: '{"url":"https://example.com"}',
    durationMs: 42,
    status: 200 as number | undefined,
    ok: true,
    attribution: {},
  };

  it("captures capability, method, url, status, duration, and body size", () => {
    expect(capabilityCallData(base)).toEqual({
      capability: "web.scrape",
      method: "POST",
      url: "https://api.test/v1/capabilities/web.scrape",
      ok: true,
      status: 200,
      duration_ms: 42,
      request_bytes: Buffer.byteLength('{"url":"https://example.com"}'),
    });
  });

  it("defaults an absent method to GET and normalizes case", () => {
    expect(
      capabilityCallData({ ...base, method: undefined, requestBody: undefined })
        .method,
    ).toBe("GET");
    expect(capabilityCallData({ ...base, method: "put" }).method).toBe("PUT");
  });

  it("measures binary bodies via size/byteLength and skips unknown shapes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      capabilityCallData({ ...base, requestBody: bytes }).request_bytes,
    ).toBe(3);
    expect(
      capabilityCallData({ ...base, requestBody: { size: 7 } }).request_bytes,
    ).toBe(7);
    expect(
      capabilityCallData({ ...base, requestBody: () => "stream" })
        .request_bytes,
    ).toBeUndefined();
  });

  it("records the error label + message on a network-level failure (no status)", () => {
    const failure = Object.assign(new TypeError("fetch failed"), {});
    const data = capabilityCallData({
      ...base,
      status: undefined,
      ok: false,
      error: failure,
    });
    expect(data.status).toBeUndefined();
    expect(data.ok).toBe(false);
    expect(data.error).toBe("TypeError");
    expect(data.error_message).toBe("fetch failed");
  });

  it("labels a non-Error thrown value by its type", () => {
    const data = capabilityCallData({ ...base, ok: false, error: "boom" });
    expect(data.error).toBe("string");
    expect(data.error_message).toBeUndefined();
  });

  it("includes every attribution field the transport carries, and only those set", () => {
    const data = capabilityCallData({
      ...base,
      attribution: {
        agentName: "researcher",
        traceId: "tr_123",
        metadata: { runId: "r-9" },
      },
    });
    expect(data.agent_name).toBe("researcher");
    expect(data.trace_id).toBe("tr_123");
    expect(data.attribution_metadata).toEqual({ runId: "r-9" });
    expect(data.agent_id).toBeUndefined();
    expect(data.trace_external_id).toBeUndefined();
  });

  it("strips query strings and fragments from the recorded url", () => {
    const data = capabilityCallData({
      ...base,
      url: "https://files.test/v1/files?token=SECRET&prefix=a#frag",
    });
    expect(data.url).toBe("https://files.test/v1/files");
    expect(JSON.stringify(data)).not.toContain("SECRET");
  });
});

describe("urlWithoutQuery()", () => {
  it("returns origin + pathname, dropping query and fragment", () => {
    expect(
      urlWithoutQuery("https://api.test/v1/things?secret=abc&x=1#frag"),
    ).toBe("https://api.test/v1/things");
    expect(urlWithoutQuery("https://api.test/v1/things")).toBe(
      "https://api.test/v1/things",
    );
  });

  it("strips at the first ? or # even when the URL is unparseable", () => {
    expect(urlWithoutQuery("not a url?secret=abc")).toBe("not a url");
    expect(urlWithoutQuery("not a url#frag")).toBe("not a url");
  });
});

describe("resolveSdkVersion()", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
  ) as { name: string; version: string };

  it("the generated VERSION constant matches package.json", () => {
    expect(manifest.name).toBe("@sapiom/tools"); // reading the right manifest
    expect(VERSION).toBe(manifest.version);
  });

  it("resolves to the generated constant (primary source)", () => {
    expect(resolveSdkVersion()).toBe(VERSION);
  });
});

describe("Transport analytics holder", () => {
  const holderOf = (t: Transport): AnalyticsHolder =>
    (t as unknown as { analyticsHolder: AnalyticsHolder }).analyticsHolder;

  it("withAttribution shares the parent's emitter holder (one emitter per client)", () => {
    const parent = new Transport({ apiKey: "k" });
    const derived = parent.withAttribution({ traceId: "tr_1" });
    const derivedTwice = derived.withAttribution({ agentName: "a" });
    expect(holderOf(derived)).toBe(holderOf(parent));
    expect(holderOf(derivedTwice)).toBe(holderOf(parent));
  });

  it("independent transports get independent holders", () => {
    expect(holderOf(new Transport({ apiKey: "k" }))).not.toBe(
      holderOf(new Transport({ apiKey: "k" })),
    );
  });
});

describe("shutdown()", () => {
  it("Transport.shutdown resolves immediately when no emitter was created, and is idempotent", async () => {
    const transport = new Transport({ apiKey: "k" });
    await expect(transport.shutdown()).resolves.toBeUndefined();
    await expect(transport.shutdown()).resolves.toBeUndefined();
  });

  it("is wired through the public client (and derived clients share it)", async () => {
    const client = createClient({ apiKey: "k" });
    expect(typeof client.shutdown).toBe("function");
    await expect(client.shutdown()).resolves.toBeUndefined();
    await expect(
      client.withAttribution({ traceId: "t" }).shutdown(),
    ).resolves.toBeUndefined();
  });
});
