/**
 * End-to-end proof of the proxy-backed google authClient: a REAL `google-auth-library` `OAuth2Client`
 * (what the author drops into `googleapis`) drives Gmail / Drive / Sheets calls through a mock that
 * enforces the connectors proxy's multi-host contract: the caller-supplied
 * `x-sapiom-connector-host` is validated against the connector's allowed hosts, and a disallowed
 * host returns 502 `blocked_target`. The credential rides `x-sapiom-api-key` (never a Google token
 * from the sandbox). The route is provider-addressed (`/connectors/v1/providers/google/proxy/*`).
 *
 * We invoke `client.request({ url, ... })` directly — that IS the one integration point googleapis
 * uses for every generated API call (googleapis-common@7.2.0 apirequest.js:303 → `authClient.request`)
 * — a faithful proof without the 50 MB `googleapis` meta-package. The URLs are exactly the ones each
 * Google API's rootUrl makes the SDK build; the point is Gmail dials its own subdomain, forwarded
 * with zero per-method wiring.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Transport } from "../../_client/index.js";
import { createProxyAuthClient } from "./auth-client.js";

const TENANT_KEY = "sat_tenant_key_must_be_forwarded";
const PROXY_PREFIX = "/connectors/v1/providers/google/proxy";

// Mirrors the Google adapter's `proxy.allowedHosts` on the branch (curated googleapis.com set).
const DEFAULT_ALLOWED_HOSTS = [
  "www.googleapis.com",
  "gmail.googleapis.com",
  "sheets.googleapis.com",
  "people.googleapis.com",
  "calendar.googleapis.com",
];

interface CapturedRequest {
  method: string;
  path: string;
  connectorHost: string | undefined;
  apiKey: string | undefined;
  authorization: string | undefined;
  clientMarker: string | undefined;
}

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[];
let allowedHosts: string[];

/**
 * A stand-in for the multi-host proxy: validates `x-sapiom-connector-host` against `allowedHosts`,
 * returning 502 `blocked_target` on a miss, then serves a canned upstream response keyed by the
 * proxied path.
 */
function startMockProxy(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const connectorHost = header(req.headers["x-sapiom-connector-host"]);
      captured.push({
        method: req.method ?? "GET",
        path: url.pathname + url.search,
        connectorHost,
        apiKey: header(req.headers["x-sapiom-api-key"]),
        authorization: header(req.headers["authorization"]),
        clientMarker: header(req.headers["x-sapiom-client"]),
      });

      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // Tenant credential is required (the proxy is identity-gated).
      if (!header(req.headers["x-sapiom-api-key"])) {
        return json(401, { error: "tenant_identity_required" });
      }
      // The security contract: an untrusted caller can only pick a DECLARED host. A disallowed
      // host surfaces as HTTP 502 `blocked_target`, NOT a 4xx — the host is a server-owned egress
      // decision, so it renders as a bad gateway.
      if (connectorHost && !allowedHosts.includes(connectorHost)) {
        return json(502, {
          error: "blocked_target",
          message: "Target host is not permitted",
        });
      }

      const upstreamPath = url.pathname.startsWith(PROXY_PREFIX)
        ? url.pathname.slice(PROXY_PREFIX.length)
        : "";

      if (upstreamPath === "/gmail/v1/users/me/messages") {
        return json(200, {
          messages: [
            { id: "msg-1", threadId: "t-1" },
            { id: "msg-2", threadId: "t-2" },
          ],
          resultSizeEstimate: 2,
        });
      }
      if (upstreamPath === "/drive/v3/files") {
        return json(200, { files: [{ id: "file-1", name: "Q3 plan" }] });
      }
      return json(404, {
        error: { code: 404, message: `no mock for ${upstreamPath}` },
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function authClient() {
  const transport = new Transport({
    apiKey: TENANT_KEY,
    fetch: globalThis.fetch,
  });
  return createProxyAuthClient({
    provider: "google",
    proxyBaseUrl: baseUrl,
    transport,
  });
}

beforeAll(() => startMockProxy());
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured = [];
  allowedHosts = [...DEFAULT_ALLOWED_HOSTS];
});

describe("google authClient via the connectors proxy (multi-host)", () => {
  it("returns a real google-auth-library OAuth2Client", async () => {
    const client = await authClient();
    expect(typeof client.request).toBe("function");
    expect(typeof client.getRequestHeaders).toBe("function");
    expect(client.constructor.name).toBe("OAuth2Client");
  });

  it("routes a Gmail call through the proxy on gmail.googleapis.com, token-free", async () => {
    const client = await authClient();

    // The exact call googleapis-common makes for gmail.users.messages.list.
    const res = await client.request<{ messages: { id: string }[] }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
      params: { maxResults: 2 },
    });

    // The proxied response was parsed as if it came straight from Google.
    expect(res.status).toBe(200);
    expect(res.data.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);

    const call = captured.at(-1)!;
    // The SDK chose Gmail's own subdomain; our client forwarded it verbatim — no per-method logic.
    expect(call.connectorHost).toBe("gmail.googleapis.com");
    expect(call.path).toBe(
      `${PROXY_PREFIX}/gmail/v1/users/me/messages?maxResults=2`,
    );
    // The tenant credential is present; no Google token ever left the sandbox.
    expect(call.apiKey).toBe(TENANT_KEY);
    expect(call.authorization).toBeUndefined();
    expect(call.clientMarker).toMatch(/^sapiom-tools\//);
  });

  it("derives a different host per API (Drive → www.googleapis.com) with the same client", async () => {
    const client = await authClient();

    const res = await client.request<{ files: { name: string }[] }>({
      url: "https://www.googleapis.com/drive/v3/files",
      method: "GET",
    });

    expect(res.status).toBe(200);
    expect(res.data.files[0].name).toBe("Q3 plan");
    expect(captured.at(-1)!.connectorHost).toBe("www.googleapis.com");
  });

  it("surfaces the proxy's allowlist rejection (502 blocked_target) as a normal googleapis error", async () => {
    // Drop Sheets from the connector's declared hosts → the proxy must refuse it with 502.
    allowedHosts = allowedHosts.filter((h) => h !== "sheets.googleapis.com");
    const client = await authClient();

    await expect(
      client.request({
        url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-1",
        method: "GET",
      }),
    ).rejects.toMatchObject({ status: 502 });

    expect(captured.at(-1)!.connectorHost).toBe("sheets.googleapis.com");
  });

  it("forwards the caller's abort signal (an already-aborted request rejects)", async () => {
    const client = await authClient();
    const before = captured.length;

    await expect(
      client.request({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        method: "GET",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();

    // Aborted before dialing — the proxy never received the request.
    expect(captured.length).toBe(before);
  });

  // responseType: "stream" is googleapis' download contract (e.g. drive.files.get({ alt: "media" })
  // then res.data.pipe(...)). Transport uses undici (web streams); we must hand back a Node Readable.
  it("returns a Node Readable for responseType: 'stream' (not a web ReadableStream)", async () => {
    const client = await authClient();
    const res = await client.request({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
      responseType: "stream",
    });
    const data = res.data as {
      pipe?: unknown;
      on?: unknown;
      getReader?: unknown;
    };
    expect(typeof data.pipe).toBe("function");
    expect(typeof data.on).toBe("function");
    expect(data.getReader).toBeUndefined(); // i.e. NOT a web ReadableStream
  });

  it("streams the response bytes for responseType: 'stream'", async () => {
    const client = await authClient();
    const res = await client.request({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
      responseType: "stream",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res.data as AsyncIterable<Buffer>)
      chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("msg-1");
  });

  it("still parses JSON responses (the stream shim leaves res.json() untouched)", async () => {
    const client = await authClient();
    const res = await client.request<{ messages: { id: string }[] }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
    });
    expect(res.data.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });
});
