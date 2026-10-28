import { fetchDroppingIdentityCrossOrigin } from "./identity-fetch";

interface Hop {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: string;
}

/** A fetch that answers from `routes` (url -> response factory) and records every hop. */
function recordingFetch(routes: Record<string, () => Response>) {
  const hops: Hop[] = [];
  const impl = jest.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const headers =
      typeof input === "string"
        ? (init?.headers as Record<string, string>)
        : Object.fromEntries((input as Request).headers);
    const body =
      init?.body instanceof ArrayBuffer
        ? Buffer.from(init.body).toString()
        : undefined;
    hops.push({ url, headers, method: init?.method, body });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  });
  return { impl: impl as unknown as typeof fetch, hops, calls: impl };
}

const redirect = (status: number, location: string) => () =>
  new Response(null, { status, headers: { location } });
const ok = () => () => new Response("ok", { status: 200 });

describe("fetchDroppingIdentityCrossOrigin", () => {
  it("drops Sapiom-Identity on a redirect to another origin", async () => {
    const { impl, hops } = recordingFetch({
      "https://a.services.sapiom.ai/x": redirect(302, "https://b.example/y"),
      "https://b.example/y": ok(),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      headers: { "Sapiom-Identity": "jwt", accept: "application/json" },
    });

    const res = await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    expect(res.status).toBe(200);
    expect(hops).toHaveLength(2);
    expect(hops[0]!.headers["sapiom-identity"]).toBe("jwt");
    expect(hops[1]!.headers["sapiom-identity"]).toBeUndefined();
    expect(hops[1]!.headers.accept).toBe("application/json");
  });

  it("keeps Sapiom-Identity on a same-origin redirect", async () => {
    const { impl, hops } = recordingFetch({
      "https://a.services.sapiom.ai/x": redirect(302, "/y"),
      "https://a.services.sapiom.ai/y": ok(),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      headers: { "Sapiom-Identity": "jwt" },
    });

    await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    expect(hops[1]!.headers["sapiom-identity"]).toBe("jwt");
  });

  it("resends a buffered body on a 307", async () => {
    const { impl, hops } = recordingFetch({
      "https://a.services.sapiom.ai/x": redirect(307, "https://b.example/y"),
      "https://b.example/y": ok(),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      method: "POST",
      headers: { "Sapiom-Identity": "jwt" },
      body: JSON.stringify({ a: 1 }),
    });

    await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    expect(hops[1]!.method).toBe("POST");
    expect(hops[1]!.body).toBe('{"a":1}');
    expect(hops[1]!.headers["sapiom-identity"]).toBeUndefined();
  });

  it("passes a request without the header to fetch untouched", async () => {
    const { impl, calls } = recordingFetch({ "https://b.example/y": ok() });
    const request = new Request("https://b.example/y");

    await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![0]).toBe(request);
  });

  it("passes a manual-redirect request to fetch untouched", async () => {
    const { impl, calls } = recordingFetch({
      "https://a.services.sapiom.ai/x": redirect(302, "https://b.example/y"),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      headers: { "Sapiom-Identity": "jwt" },
      redirect: "manual",
    });

    const res = await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    expect(res.status).toBe(302);
    expect(calls.mock.calls[0]![0]).toBe(request);
  });
  it("forwards a caller stream unbuffered and refuses to resend it on a 307", async () => {
    const seen: RequestInit[] = [];
    const impl = jest.fn(async (_url: any, init?: RequestInit) => {
      seen.push(init!);
      return new Response(null, {
        status: 307,
        headers: { location: "https://a.services.sapiom.ai/y" },
      });
    }) as unknown as typeof fetch;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      method: "POST",
      headers: { "Sapiom-Identity": "jwt" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    await expect(
      fetchDroppingIdentityCrossOrigin(impl, request, "test", {
        streamBody: true,
      }),
    ).rejects.toThrow(/streamed request body/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBeInstanceOf(ReadableStream);
    expect((seen[0] as { duplex?: string }).duplex).toBe("half");
  });

  it("keeps the caller's dispatcher on every hop", async () => {
    const dispatcher = { name: "proxy-agent" };
    const { impl, calls } = recordingFetch({
      "https://a.services.sapiom.ai/x": redirect(302, "https://b.example/y"),
      "https://b.example/y": ok(),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      headers: { "Sapiom-Identity": "jwt" },
    });

    await fetchDroppingIdentityCrossOrigin(impl, request, "test", {
      dispatcher,
    });

    expect(calls).toHaveBeenCalledTimes(2);
    for (const [, init] of calls.mock.calls) {
      expect((init as { dispatcher?: unknown }).dispatcher).toBe(dispatcher);
    }
  });
  it("rejects promptly when aborted while buffering an open body", async () => {
    const impl = jest.fn() as unknown as typeof fetch;
    let cancelled = false;
    const open = new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const request = new Request("https://a.services.sapiom.ai/x", {
      method: "POST",
      headers: { "Sapiom-Identity": "jwt" },
      body: open,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);

    const pending = fetchDroppingIdentityCrossOrigin(impl, request, "test");
    controller.abort(new Error("caller gave up"));

    await expect(pending).rejects.toThrow("caller gave up");
    expect(cancelled).toBe(true);
    expect(impl).not.toHaveBeenCalled();
  });

  it("keeps the request's cache mode and referrer", async () => {
    const { impl, calls } = recordingFetch({
      "https://a.services.sapiom.ai/x": ok(),
    });
    const request = new Request("https://a.services.sapiom.ai/x", {
      headers: { "Sapiom-Identity": "jwt" },
      cache: "no-cache",
      referrer: "https://a.services.sapiom.ai/from",
    } as RequestInit);

    await fetchDroppingIdentityCrossOrigin(impl, request, "test");

    const init = calls.mock.calls[0]![1] as RequestInit & { cache?: string };
    expect(init.cache).toBe("no-cache");
    expect(init.referrer).toBe("https://a.services.sapiom.ai/from");
  });
});
