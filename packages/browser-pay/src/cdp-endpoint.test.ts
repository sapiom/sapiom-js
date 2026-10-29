import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolveCdpEndpoint } from "./cdp-endpoint";

describe("CDP endpoint discovery", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    "ws://localhost:9222/browser/id",
    "wss://browser.example/cdp?token=secret",
  ])("leaves a direct WebSocket endpoint unchanged: %s", async (endpoint) => {
    const fetch = jest.spyOn(globalThis, "fetch");
    await expect(resolveCdpEndpoint(endpoint, 1000)).resolves.toBe(endpoint);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "https://provider.example/session/abc?token=secret",
      "/session/abc/json/version",
    ],
    [
      "https://provider.example/session/abc/?token=secret",
      "/session/abc/json/version",
    ],
    ["https://provider.example/json/version?token=secret", "/json/version"],
  ])("discovers a secure endpoint from %s", async (input, pathname) => {
    const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        webSocketDebuggerUrl: "wss://browser.example/owned?key=other",
      }),
    );
    await expect(resolveCdpEndpoint(input, 1000)).resolves.toBe(
      "wss://browser.example/owned?key=other",
    );
    const [url, init] = fetch.mock.calls[0];
    expect((url as URL).pathname).toBe(pathname);
    expect((url as URL).search).toBe("?token=secret");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {},
    { webSocketDebuggerUrl: "/relative" },
    { webSocketDebuggerUrl: "https://browser.example" },
    { webSocketDebuggerUrl: "ws://browser.example" },
    { webSocketDebuggerUrl: "wss://user:secret@browser.example" },
  ])("rejects invalid or downgraded discovery responses", async (body) => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(
      resolveCdpEndpoint("https://provider.example?secret=token", 1000),
    ).rejects.toThrow(/^CDP endpoint discovery failed$/);
  });

  it.each([
    new Response("private upstream message", { status: 401 }),
    new Response("invalid JSON with secret"),
    new Response("x".repeat(65537)),
  ])(
    "does not disclose failed or oversized response bodies",
    async (response) => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(response);
      await expect(
        resolveCdpEndpoint("https://provider.example?secret=token", 1000),
      ).rejects.toThrow(/^CDP endpoint discovery failed$/);
    },
  );

  it("does not disclose transport errors", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("URL contains secret"));
    await expect(
      resolveCdpEndpoint("https://provider.example?secret=token", 1000),
    ).rejects.toThrow(/^CDP endpoint discovery failed$/);
  });

  it.each([
    "invalid secret",
    "file:///tmp/secret",
    "ftp://host/secret",
    "https://user:secret@host",
  ])("rejects unsupported input without a network call", async (input) => {
    const fetch = jest.spyOn(globalThis, "fetch");
    await expect(resolveCdpEndpoint(input, 1000)).rejects.toThrow(
      /^CDP endpoint/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the deadline across a stalled response body and refuses redirects", async () => {
    let redirected = false;
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith("/redirect")) {
        response.writeHead(302, { location: "/secret-target" });
        response.end();
      } else if (request.url === "/secret-target") {
        redirected = true;
        response.end("secret");
      } else {
        response.writeHead(200);
        response.write('{"webSocketDebuggerUrl":');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(resolveCdpEndpoint(base, 100)).rejects.toThrow(
        "discovery timed out",
      );
      await expect(
        resolveCdpEndpoint(`${base}/redirect`, 1000),
      ).rejects.toThrow("discovery failed");
      expect(redirected).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
