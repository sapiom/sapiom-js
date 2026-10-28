/**
 * Sapiom-Identity attachment: the audience is checked against the URL axios really
 * requests, the per-request opt-out is honoured, and the JWT never follows a
 * redirect to another origin.
 */
import http from "http";
import { AddressInfo } from "net";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { SapiomClient, TransactionStatus } from "@sapiom/core";
import { withSapiom } from "./axios";

const JWT = "identity-jwt";

/** Matches the real audience rule closely enough: Sapiom services hosts and loopback. */
function createClient() {
  const getHeaderIfMatch = jest.fn(async (url: string) => {
    const { hostname } = new URL(url);
    return hostname.endsWith("services.sapiom.ai") || hostname === "127.0.0.1"
      ? { "Sapiom-Identity": JWT }
      : {};
  });
  const client = {
    identity: { getHeaderIfMatch },
    transactions: {
      create: jest.fn().mockResolvedValue({
        id: "tx_1",
        status: TransactionStatus.AUTHORIZED,
      }),
      complete: jest.fn().mockResolvedValue({}),
    },
  } as unknown as SapiomClient;
  return { client, getHeaderIfMatch };
}

describe("withSapiom identity header", () => {
  describe("audience target", () => {
    it("checks an absolute url against its own host, not baseURL", async () => {
      const { client, getHeaderIfMatch } = createClient();
      const instance = axios.create({ baseURL: "https://x.services.sapiom.ai/" });
      const mock = new MockAdapter(instance);
      mock.onGet("https://evil.example/x").reply(200, "ok");
      withSapiom(instance, { sapiomClient: client });

      await instance.get("https://evil.example/x");

      expect(getHeaderIfMatch).toHaveBeenCalledWith("https://evil.example/x");
      expect(mock.history.get[0]!.headers?.["Sapiom-Identity"]).toBeUndefined();
    });

    it("attaches the header to a relative url on the Sapiom host", async () => {
      const { client, getHeaderIfMatch } = createClient();
      const instance = axios.create({ baseURL: "https://x.services.sapiom.ai/" });
      const mock = new MockAdapter(instance);
      mock.onGet("/v1/x").reply(200, "ok");
      withSapiom(instance, { sapiomClient: client });

      await instance.get("/v1/x");

      expect(getHeaderIfMatch).toHaveBeenCalledWith(
        "https://x.services.sapiom.ai/v1/x",
      );
      expect(mock.history.get[0]!.headers?.["Sapiom-Identity"]).toBe(JWT);
    });

    it("skips the identity for a request with __sapiom.enabled false", async () => {
      const { client, getHeaderIfMatch } = createClient();
      const instance = axios.create({ baseURL: "https://x.services.sapiom.ai/" });
      const mock = new MockAdapter(instance);
      mock.onGet("/v1/x").reply(200, "ok");
      withSapiom(instance, { sapiomClient: client });

      await instance.get("/v1/x", { __sapiom: { enabled: false } } as any);

      expect(getHeaderIfMatch).not.toHaveBeenCalled();
      expect(mock.history.get[0]!.headers?.["Sapiom-Identity"]).toBeUndefined();
    });
  });

  describe("redirects", () => {
    const servers: http.Server[] = [];
    const received: Record<string, http.IncomingHttpHeaders[]> = {};

    /** A local server that records request headers, then runs `handle`. */
    async function listen(
      name: string,
      handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    ): Promise<string> {
      received[name] = [];
      const server = http.createServer((req, res) => {
        received[name]!.push(req.headers);
        handle(req, res);
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    afterEach(async () => {
      await Promise.all(
        servers
          .splice(0)
          .map((s) => new Promise((resolve) => s.close(resolve))),
      );
    });

    it("drops the header on a redirect to another origin", async () => {
      const target = await listen("b", (_req, res) => res.end("ok"));
      const origin = await listen("a", (_req, res) => {
        res.writeHead(302, { location: `${target}/landing` });
        res.end();
      });
      const { client } = createClient();
      const instance = withSapiom(axios.create(), { sapiomClient: client });

      await instance.get(`${origin}/start`);

      expect(received.a![0]!["sapiom-identity"]).toBe(JWT);
      expect(received.b![0]!["sapiom-identity"]).toBeUndefined();
    });

    it("keeps the header on a same-origin redirect and still runs the caller's hook", async () => {
      const origin = await listen("a", (req, res) => {
        if (req.url === "/start") {
          res.writeHead(302, { location: "/landing" });
          res.end();
        } else {
          res.end("ok");
        }
      });
      const { client } = createClient();
      const instance = withSapiom(axios.create(), { sapiomClient: client });
      const callerHook = jest.fn();

      await instance.get(`${origin}/start`, { beforeRedirect: callerHook });

      expect(received.a).toHaveLength(2);
      expect(received.a![1]!["sapiom-identity"]).toBe(JWT);
      expect(callerHook).toHaveBeenCalledTimes(1);
    });
  });
});
