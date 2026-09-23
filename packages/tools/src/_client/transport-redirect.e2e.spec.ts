/**
 * The redirect rule against real servers and the real `fetch`: proves the
 * `redirect: "manual"` semantics the unit specs mock (a readable 3xx with its
 * `Location`). Two loopback origins, so no opt-in is needed.
 */
import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Transport } from "./index.js";

interface Seen {
  server: "a" | "b";
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("Transport redirects (e2e, two loopback origins)", () => {
  const seen: Seen[] = [];
  let a: http.Server;
  let b: http.Server;
  let originA: string;
  let originB: string;

  function listen(
    name: "a" | "b",
    route: (path: string, res: http.ServerResponse) => void,
  ): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        seen.push({
          server: name,
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body,
        });
        route(req.url ?? "", res);
      });
    });
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(server)),
    );
  }

  const originOf = (s: http.Server) =>
    `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  beforeAll(async () => {
    b = await listen("b", (_path, res) => res.end('{"from":"b"}'));
    originB = originOf(b);
    a = await listen("a", (path, res) => {
      const to: Record<string, [number, string]> = {
        "/same": [302, "/landed"],
        "/cross": [302, `${originB}/landed`],
        "/cross-307": [307, `${originB}/landed`],
      };
      const hop = to[path];
      if (hop) res.writeHead(hop[0], { location: hop[1] }).end();
      else res.end('{"from":"a"}');
    });
    originA = originOf(a);
  });

  afterAll(async () => {
    await Promise.all(
      [a, b].map((s) => new Promise((resolve) => s.close(resolve))),
    );
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const transport = () =>
    new Transport({ apiKey: "k", attribution: { executionId: "e1" } });

  it("keeps the credential on a same-origin redirect", async () => {
    const res = await transport().fetch(`${originA}/same`);
    expect(await res.json()).toEqual({ from: "a" });
    expect(seen.map((s) => `${s.server}${s.path}`)).toEqual([
      "a/same",
      "a/landed",
    ]);
    expect(seen[1]!.headers["x-sapiom-api-key"]).toBe("k");
  });

  it("never lets the credential or Sapiom context reach the other origin", async () => {
    const res = await transport().fetch(`${originA}/cross`, {
      headers: { accept: "application/json" },
    });
    expect(await res.json()).toEqual({ from: "b" });
    const landed = seen.find((s) => s.server === "b")!;
    expect(landed.headers["x-sapiom-api-key"]).toBeUndefined();
    expect(landed.headers["x-sapiom-client"]).toBeUndefined();
    expect(landed.headers["x-sapiom-execution-id"]).toBeUndefined();
    expect(landed.headers.accept).toBe("application/json");
    expect(seen[0]!.headers["x-sapiom-api-key"]).toBe("k");
  });

  it("replays a 307 POST body to the other origin without the credential", async () => {
    await transport().fetch(`${originA}/cross-307`, {
      method: "POST",
      body: '{"a":1}',
      headers: { "content-type": "application/json" },
    });
    const landed = seen.find((s) => s.server === "b")!;
    expect(landed.method).toBe("POST");
    expect(landed.body).toBe('{"a":1}');
    expect(landed.headers["x-sapiom-api-key"]).toBeUndefined();
  });

  it("a same-origin request stops at a cross-origin 307: the other origin never sees the body", async () => {
    await expect(
      transport().fetch(`${originA}/cross-307`, {
        method: "POST",
        body: '{"a":1}',
        mode: "same-origin",
      }),
    ).rejects.toThrow(/"same-origin" request/);
    expect(seen.map((s) => `${s.server}${s.path}`)).toEqual(["a/cross-307"]);
  });

  it("checks integrity against the final response, not the redirect", async () => {
    const integrity = `sha256-${createHash("sha256").update('{"from":"b"}').digest("base64")}`;
    const res = await transport().fetch(`${originA}/cross`, { integrity });
    expect(await res.json()).toEqual({ from: "b" });
  });
});
