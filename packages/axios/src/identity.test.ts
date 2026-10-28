/** The identity JWT is a bearer credential: these pin where axios may send it. */
import http from "http";
import { AddressInfo } from "net";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { SapiomClient, TransactionStatus } from "@sapiom/core";
import { withSapiom } from "./axios";

const JWT = "identity-jwt";

/** Loopback matches too, so the redirect tests can use local servers. */
function createClient() {
  const getHeaderIfMatch = jest.fn(async (url: string) => {
    const { hostname } = new URL(url);
    return hostname.endsWith("services.sapiom.ai") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
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
      const instance = axios.create({
        baseURL: "https://x.services.sapiom.ai/",
      });
      const mock = new MockAdapter(instance);
      mock.onGet("https://evil.example/x").reply(200, "ok");
      withSapiom(instance, { sapiomClient: client });

      await instance.get("https://evil.example/x");

      expect(getHeaderIfMatch).toHaveBeenCalledWith("https://evil.example/x");
      expect(mock.history.get[0]!.headers?.["Sapiom-Identity"]).toBeUndefined();
    });

    it("attaches the header to a relative url on the Sapiom host", async () => {
      const { client, getHeaderIfMatch } = createClient();
      const instance = axios.create({
        baseURL: "https://x.services.sapiom.ai/",
      });
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
      const instance = axios.create({
        baseURL: "https://x.services.sapiom.ai/",
      });
      const mock = new MockAdapter(instance);
      mock.onGet("/v1/x").reply(200, "ok");
      withSapiom(instance, { sapiomClient: client });

      await instance.get("/v1/x", { __sapiom: { enabled: false } } as any);

      expect(getHeaderIfMatch).not.toHaveBeenCalled();
      expect(mock.history.get[0]!.headers?.["Sapiom-Identity"]).toBeUndefined();
    });
  });

  describe("redirect hop origin", () => {
    async function hookFor(url: string) {
      const { client } = createClient();
      const instance = axios.create();
      const mock = new MockAdapter(instance);
      let hook: ((options: any, details: any) => void) | undefined;
      mock.onGet(url).reply((config) => {
        hook = config.beforeRedirect as typeof hook;
        return [200, "ok"];
      });
      withSapiom(instance, { sapiomClient: client });
      await instance.get(url);
      return hook!;
    }

    it("judges the hop by its href when a proxy rewrote hostname and port", async () => {
      const hook = await hookFor("https://x.services.sapiom.ai/v1/a");
      const proxied = (href: string) => ({
        protocol: "http:",
        hostname: "proxy.internal",
        port: "3128",
        href,
        headers: { "Sapiom-Identity": JWT },
      });

      const same = proxied("https://x.services.sapiom.ai/v1/b");
      hook(same, { headers: {} });
      expect(same.headers["Sapiom-Identity"]).toBe(JWT);

      const cross = proxied("https://evil.example/v1/b");
      hook(cross, { headers: {} });
      expect(cross.headers["Sapiom-Identity"]).toBeUndefined();
    });

    it("drops the header when the caller's hook retargets the hop", async () => {
      const { client } = createClient();
      const instance = axios.create();
      const mock = new MockAdapter(instance);
      let hook: ((options: any, details: any) => void) | undefined;
      mock.onGet("http://127.0.0.1:3000/start").reply((config) => {
        hook = config.beforeRedirect as typeof hook;
        return [200, "ok"];
      });
      withSapiom(instance, { sapiomClient: client });
      await instance.get("http://127.0.0.1:3000/start", {
        beforeRedirect: (options: Record<string, unknown>) => {
          options.port = "4000";
        },
      });
      const options = {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: "3000",
        href: "http://127.0.0.1:3000/landing",
        headers: { "Sapiom-Identity": JWT },
      };

      hook!(options, { headers: {} });

      expect(options.port).toBe("4000");
      expect(options.headers["Sapiom-Identity"]).toBeUndefined();
    });

    it("keeps the header on a same-origin IPv6 hop described without href", async () => {
      const hook = await hookFor("http://[::1]:3000/start");
      const options = {
        protocol: "http:",
        hostname: "::1",
        port: "3000",
        headers: { "Sapiom-Identity": JWT },
      };

      hook(options, { headers: {} });

      expect(options.headers["Sapiom-Identity"]).toBe(JWT);
    });
  });

  describe("redirects", () => {
    const servers: http.Server[] = [];
    const received: Record<string, http.IncomingHttpHeaders[]> = {};

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
