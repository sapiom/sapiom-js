import { createHash } from "node:crypto";

import { Transport, type TransportConfig } from "./index.js";
import { capabilityCall } from "./capability-call.js";
import { ALLOW_INSECURE_HTTP_ENV, MAX_REDIRECTS } from "./credential-policy.js";

interface Hop {
  url: string;
  method: string | undefined;
  body: unknown;
  redirect: RequestInit["redirect"];
  integrity: string | undefined;
  headers: Record<string, string>;
}

/** A transport whose fetch records every hop and answers with `route`. */
function transportWith(
  route: (url: URL, hop: number) => Response = () => new Response("{}"),
  config: Omit<TransportConfig, "fetch"> = {},
): { transport: Transport; hops: Hop[] } {
  const hops: Hop[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    hops.push({
      url: String(input),
      method: init.method,
      body: init.body,
      redirect: init.redirect,
      integrity: init.integrity,
      headers: { ...(init.headers as Record<string, string>) },
    });
    return route(new URL(String(input)), hops.length - 1);
  }) as typeof globalThis.fetch;
  return {
    transport: new Transport({ apiKey: "k", ...config, fetch: fetchMock }),
    hops,
  };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

/** Redirects the first hop to `location`, answers 200 after. */
const onceTo =
  (location: string, status = 302) =>
  (_url: URL, hop: number) =>
    hop === 0 ? redirectTo(location, status) : new Response("{}");

const sri = (body: string) =>
  `sha256-${createHash("sha256").update(body).digest("base64")}`;

const ORIGINAL_ENV = process.env[ALLOW_INSECURE_HTTP_ENV];
beforeEach(() => {
  delete process.env[ALLOW_INSECURE_HTTP_ENV];
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ALLOW_INSECURE_HTTP_ENV];
  else process.env[ALLOW_INSECURE_HTTP_ENV] = ORIGINAL_ENV;
});

describe("Transport: the credential's channel", () => {
  it("refuses plaintext to a non-loopback host before sending anything", async () => {
    const { transport, hops } = transportWith();
    await expect(transport.fetch("http://api:3000/v1/memory")).rejects.toThrow(
      /refusing plaintext HTTP to http:\/\/api:3000.*SAPIOM_ALLOW_INSECURE_HTTP=1/,
    );
    expect(hops).toHaveLength(0);
  });

  it.each([
    "http://localhost:3000/v1/memory",
    "http://api.localhost:3100/v1/memory",
    "http://127.0.0.1:3000/v1/memory",
    "http://[::1]:3000/v1/memory",
  ])("sends to loopback %s with the credential", async (url) => {
    const { transport, hops } = transportWith();
    await transport.fetch(url);
    expect(hops).toHaveLength(1);
    expect(hops[0]!.headers["x-sapiom-api-key"]).toBe("k");
  });

  it("sends plaintext to a non-loopback host once opted in", async () => {
    const { transport, hops } = transportWith(undefined, {
      allowInsecureHttp: true,
    });
    await transport.fetch("http://api:3000/v1/memory");
    expect(hops).toHaveLength(1);
  });

  it("reads the opt-in from SAPIOM_ALLOW_INSECURE_HTTP=1", async () => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = "1";
    const { transport, hops } = transportWith();
    await transport.fetch("http://api:3000/v1/memory");
    expect(hops).toHaveLength(1);
  });

  it("an explicit allowInsecureHttp: false beats the env", async () => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = "1";
    const { transport } = transportWith(undefined, {
      allowInsecureHttp: false,
    });
    await expect(transport.fetch("http://api:3000/v1/memory")).rejects.toThrow(
      /refusing plaintext HTTP/,
    );
  });

  it("refuses a non-http scheme even when opted in", async () => {
    const { transport, hops } = transportWith(undefined, {
      allowInsecureHttp: true,
    });
    await expect(transport.fetch("gopher://api.sapiom.ai/")).rejects.toThrow(
      /cannot request 'gopher:' URLs/,
    );
    expect(hops).toHaveLength(0);
  });

  it("a transport derived with withAttribution keeps the resolved policy", async () => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = "1";
    const optedIn = transportWith();
    const strict = transportWith(undefined, { allowInsecureHttp: false });
    delete process.env[ALLOW_INSECURE_HTTP_ENV];

    await optedIn.transport
      .withAttribution({ traceId: "t" })
      .fetch("http://api:3000/v1/memory");
    expect(optedIn.hops).toHaveLength(1);
    await expect(
      strict.transport
        .withAttribution({ traceId: "t" })
        .fetch("http://api:3000/v1/memory"),
    ).rejects.toThrow(/refusing plaintext HTTP/);
  });

  it("covers the routed seam too (capabilityCall on a plaintext Core URL)", async () => {
    const { transport, hops } = transportWith();
    await expect(
      capabilityCall(
        "web.scrape",
        {},
        {
          transport,
          baseUrl: "http://core:3000",
          makeError: (m) => new Error(m),
          errorPrefix: "x",
        },
      ),
    ).rejects.toThrow(/refusing plaintext HTTP to http:\/\/core:3000/);
    expect(hops).toHaveLength(0);
  });

  it("leaves an https call as it was: one hop, the caller's URL verbatim", async () => {
    const { transport, hops } = transportWith();
    const res = await transport.fetch("https://api.test", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(hops).toHaveLength(1);
    expect(hops[0]!.url).toBe("https://api.test");
    expect(hops[0]!.headers).toMatchObject({
      "x-sapiom-api-key": "k",
      accept: "application/json",
    });
    expect(hops[0]!.headers["x-sapiom-client"]).toMatch(/^sapiom-tools\//);
  });
});

describe("Transport: redirects", () => {
  it("keeps the credential on a same-origin redirect", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed"));
    await transport.fetch("https://api.sapiom.ai/v1/start");
    expect(hops.map((h) => h.url)).toEqual([
      "https://api.sapiom.ai/v1/start",
      "https://api.sapiom.ai/v1/landed",
    ]);
    expect(hops[1]!.headers["x-sapiom-api-key"]).toBe("k");
  });

  it("keeps the x-api-key credential on a same-origin redirect", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed"));
    await transport.fetch(
      "https://api.sapiom.ai/v1/start",
      {},
      { authHeader: "x-api-key" },
    );
    expect(hops[1]!.headers["x-api-key"]).toBe("k");
  });

  it("drops the credential and every x-sapiom-* header on a cross-origin redirect", async () => {
    const { transport, hops } = transportWith(
      onceTo("https://cdn.example.com/object"),
      { attribution: { executionId: "e1", traceId: "t1" } },
    );
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      headers: {
        accept: "application/json",
        authorization: "Bearer a",
        cookie: "c=1",
        "x-sapiom-workflow-token": "w",
      },
    });
    expect(hops).toHaveLength(2);
    expect(hops[0]!.headers["x-sapiom-execution-id"]).toBe("e1");
    expect(hops[1]!.url).toBe("https://cdn.example.com/object");
    expect(hops[1]!.headers).toEqual({ accept: "application/json" });
  });

  it("drops the x-api-key credential on a cross-origin redirect", async () => {
    const { transport, hops } = transportWith(
      onceTo("https://cdn.example.com/object"),
    );
    await transport.fetch(
      "https://api.sapiom.ai/v1/start",
      {},
      { authHeader: "x-api-key" },
    );
    expect(hops[1]!.headers["x-api-key"]).toBeUndefined();
  });

  it("keeps it dropped after hopping back to the first origin", async () => {
    const { transport, hops } = transportWith((_url, hop) =>
      hop === 0
        ? redirectTo("https://cdn.example.com/a")
        : hop === 1
          ? redirectTo("https://api.sapiom.ai/v1/back")
          : new Response("{}"),
    );
    await transport.fetch("https://api.sapiom.ai/v1/start");
    expect(hops).toHaveLength(3);
    expect(hops[2]!.headers["x-sapiom-api-key"]).toBeUndefined();
  });

  it("refuses a redirect to plaintext on a non-loopback host", async () => {
    const { transport, hops } = transportWith(
      onceTo("http://evil:3000/landed"),
    );
    await expect(
      transport.fetch("https://api.sapiom.ai/v1/start"),
    ).rejects.toThrow(
      "refusing plaintext HTTP to http://evil:3000 (redirected from https://api.sapiom.ai)",
    );
    expect(hops).toHaveLength(1);
  });

  it("treats an https to http downgrade on the same host as a refused hop", async () => {
    const { transport, hops } = transportWith(
      onceTo("http://api.sapiom.ai/v1/start"),
    );
    await expect(
      transport.fetch("https://api.sapiom.ai/v1/start"),
    ).rejects.toThrow(/refusing plaintext HTTP/);
    expect(hops).toHaveLength(1);
  });

  it("follows to plaintext loopback, without the credential", async () => {
    const { transport, hops } = transportWith(
      onceTo("http://127.0.0.1:9/landed"),
    );
    await transport.fetch("https://api.sapiom.ai/v1/start");
    expect(hops).toHaveLength(2);
    expect(hops[1]!.headers["x-sapiom-api-key"]).toBeUndefined();
  });

  it("with the opt-in, follows to plaintext but still drops the credential", async () => {
    const { transport, hops } = transportWith(
      onceTo("http://evil:3000/landed"),
      { allowInsecureHttp: true },
    );
    await transport.fetch("https://api.sapiom.ai/v1/start");
    expect(hops).toHaveLength(2);
    expect(hops[1]!.headers["x-sapiom-api-key"]).toBeUndefined();
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const { transport, hops } = transportWith(onceTo("file:///etc/passwd"));
    await expect(
      transport.fetch("https://api.sapiom.ai/v1/start"),
    ).rejects.toThrow(/cannot request 'file:' URLs/);
    expect(hops).toHaveLength(1);
  });

  it.each([
    [301, "POST"],
    [302, "POST"],
    [303, "POST"],
    [303, "PUT"],
  ])("a %i after %s continues as a bodiless GET", async (status, method) => {
    const { transport, hops } = transportWith(onceTo("/v1/landed", status));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      method,
      body: '{"a":1}',
      headers: { "content-type": "application/json", accept: "*/*" },
    });
    expect(hops[1]!.method).toBe("GET");
    expect(hops[1]!.body).toBeUndefined();
    expect(hops[1]!.headers["content-type"]).toBeUndefined();
    expect(hops[1]!.headers.accept).toBe("*/*");
    expect(hops[1]!.headers["x-sapiom-api-key"]).toBe("k");
  });

  it.each([307, 308])(
    "a %i replays the method, body, and content-type",
    async (status) => {
      const { transport, hops } = transportWith(onceTo("/v1/landed", status));
      await transport.fetch("https://api.sapiom.ai/v1/start", {
        method: "POST",
        body: '{"a":1}',
        headers: { "content-type": "application/json" },
      });
      expect(hops[1]!.method).toBe("POST");
      expect(hops[1]!.body).toBe('{"a":1}');
      expect(hops[1]!.headers["content-type"]).toBe("application/json");
    },
  );

  it("keeps HEAD on a 303", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed", 303));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      method: "HEAD",
    });
    expect(hops[1]!.method).toBe("HEAD");
  });

  it.each([302, 307])(
    "refuses to resend a streamed body after a %i",
    async (status) => {
      const { transport, hops } = transportWith(onceTo("/v1/landed", status));
      await expect(
        transport.fetch("https://api.sapiom.ai/v1/start", {
          method: "POST",
          body: new Blob(["x"]).stream(),
        }),
      ).rejects.toThrow(/cannot resend a streamed request body/);
      expect(hops).toHaveLength(1);
    },
  );

  it("drops a streamed body on a 303 instead of resending it", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed", 303));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      method: "POST",
      body: new Blob(["x"]).stream(),
    });
    expect(hops[1]!.method).toBe("GET");
    expect(hops[1]!.body).toBeUndefined();
  });

  it("resolves a relative Location against the current URL", async () => {
    const { transport, hops } = transportWith(onceTo("landed?x=1"));
    await transport.fetch("https://api.sapiom.ai/v1/a/start");
    expect(hops[1]!.url).toBe("https://api.sapiom.ai/v1/a/landed?x=1");
  });

  it("returns a 3xx without a Location as the final response", async () => {
    const { transport, hops } = transportWith(
      () => new Response(null, { status: 302 }),
    );
    const res = await transport.fetch("https://api.sapiom.ai/v1/start");
    expect(res.status).toBe(302);
    expect(hops).toHaveLength(1);
  });

  it(`follows ${MAX_REDIRECTS} redirects and refuses the next one`, async () => {
    const chain = (limit: number) =>
      transportWith((_url, hop) =>
        hop < limit ? redirectTo(`/v1/hop-${hop + 1}`) : new Response("{}"),
      );

    const ok = chain(MAX_REDIRECTS);
    expect(
      (await ok.transport.fetch("https://api.sapiom.ai/v1/0")).status,
    ).toBe(200);
    expect(ok.hops).toHaveLength(MAX_REDIRECTS + 1);

    const tooMany = chain(MAX_REDIRECTS + 1);
    await expect(
      tooMany.transport.fetch("https://api.sapiom.ai/v1/0"),
    ).rejects.toThrow(
      `more than ${MAX_REDIRECTS} redirects from https://api.sapiom.ai`,
    );
    expect(tooMany.hops).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("sends every hop with redirect: manual, even when the caller asked for follow", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed"));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      redirect: "follow",
    });
    expect(hops.map((h) => h.redirect)).toEqual(["manual", "manual"]);
  });

  it.each(["manual", "error"] as const)(
    "leaves redirect: %s to fetch",
    async (redirect) => {
      const { transport, hops } = transportWith(onceTo("/v1/landed"));
      const res = await transport.fetch("https://api.sapiom.ai/v1/start", {
        redirect,
      });
      expect(res.status).toBe(302);
      expect(hops).toHaveLength(1);
      expect(hops[0]!.redirect).toBe(redirect);
    },
  );

  it.each([
    ["followed", "/v1/landed"],
    ["refused", "http://evil:3000/landed"],
  ])("cancels the body of a %s redirect", async (_label, location) => {
    let cancelled = false;
    const { transport } = transportWith((_url, hop) =>
      hop === 0
        ? new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 302, headers: { location } },
          )
        : new Response("{}"),
    );
    await transport.fetch("https://api.sapiom.ai/v1/start").catch(() => {});
    expect(cancelled).toBe(true);
  });

  it("a same-origin request refuses a redirect to another origin, before sending it", async () => {
    const { transport, hops } = transportWith(
      onceTo("https://cdn.example.com/object", 307),
    );
    await expect(
      transport.fetch("https://api.sapiom.ai/v1/start", {
        method: "POST",
        body: '{"a":1}',
        mode: "same-origin",
      }),
    ).rejects.toThrow(
      'a "same-origin" request to https://api.sapiom.ai was redirected to https://cdn.example.com',
    );
    expect(hops).toHaveLength(1);
  });

  it("a same-origin request still follows a same-origin redirect", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed"));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      mode: "same-origin",
    });
    expect(hops.map((h) => h.url)).toEqual([
      "https://api.sapiom.ai/v1/start",
      "https://api.sapiom.ai/v1/landed",
    ]);
  });

  it("checks integrity on the final response only, and hands it back whole", async () => {
    const { transport, hops } = transportWith((_url, hop) =>
      hop === 0
        ? redirectTo("https://cdn.example.com/object")
        : new Response('{"done":true}'),
    );
    const res = await transport.fetch("https://api.sapiom.ai/v1/start", {
      integrity: sri('{"done":true}'),
    });
    expect(await res.json()).toEqual({ done: true });
    expect(hops.map((h) => h.integrity)).toEqual([undefined, undefined]);
  });

  it.each([
    [
      "after a redirect",
      onceTo("https://cdn.example.com/object"),
      "https://cdn.example.com",
    ],
    ["without a redirect", () => new Response("{}"), "https://api.sapiom.ai"],
  ])(
    "refuses a final response that fails the integrity check (%s)",
    async (_label, route, origin) => {
      const { transport } = transportWith(route);
      const error: unknown = await transport
        .fetch("https://api.sapiom.ai/v1/start", { integrity: sri("other") })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        `@sapiom/tools: the response from ${origin} does not match the request's integrity metadata`,
      );
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it("refuses a bodiless final response when integrity is set", async () => {
    const { transport } = transportWith(() => new Response(null));
    await expect(
      transport.fetch("https://api.sapiom.ai/v1/start", {
        method: "HEAD",
        integrity: sri(""),
      }),
    ).rejects.toThrow(/does not match the request's integrity metadata/);
  });

  it("leaves integrity to fetch under redirect: manual", async () => {
    const { transport, hops } = transportWith(onceTo("/v1/landed"));
    await transport.fetch("https://api.sapiom.ai/v1/start", {
      redirect: "manual",
      integrity: sri("{}"),
    });
    expect(hops[0]!.integrity).toBe(sri("{}"));
  });

  it("request() parses the final response of a redirected call", async () => {
    const { transport } = transportWith((_url, hop) =>
      hop === 0
        ? redirectTo("https://cdn.example.com/doc")
        : new Response('{"done":true}'),
    );
    await expect(
      transport.request("https://api.sapiom.ai/v1/start"),
    ).resolves.toEqual({ done: true });
  });
});
