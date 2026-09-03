/**
 * The vault client — the deployed half of an agent's credentials.
 *
 * What these guard: that the auth contract is the CORE one (Bearer, `/v1`) and
 * not the agents surface's, that a read which merely failed is not reported as
 * "no secrets", and that deleting a key the vault does not hold is a success
 * rather than a dead end.
 */

import { describe, expect, it } from "vitest";

import { VaultSecretError, createVaultSecretsClient } from "./vault-secrets.js";

const BASE = "https://api.test.sapiom.ai";

/** Records every request and replies from a scripted queue. */
function stubFetch(...replies: (Response | (() => Response))[]) {
  const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers as HeadersInit),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return typeof reply === "function" ? reply() : reply;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const empty = (status: number): Response => new Response(null, { status });

const clientWith = (fetchImpl: typeof fetch, apiKey: string | null = "sk_test") =>
  createVaultSecretsClient({ apiKey, baseUrl: BASE, fetchImpl });

describe("auth contract", () => {
  it("uses Bearer on the core surface, not the agents key header", async () => {
    const { fetchImpl, calls } = stubFetch(json({ keys: [] }));
    await clientWith(fetchImpl).list("188");

    expect(calls[0]!.url).toBe(`${BASE}/v1/workflows/definitions/188/secrets`);
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer sk_test");
    // The agents surface takes `x-sapiom-api-key`; core does not, and sending
    // it would be a credential on a request that has no use for it.
    expect(calls[0]!.headers.get("x-sapiom-api-key")).toBeNull();
  });

  it("refreshes and retries exactly once on a rejected key", async () => {
    const { fetchImpl, calls } = stubFetch(empty(401), json({ keys: ["A"] }));
    let refreshed = 0;
    const client = createVaultSecretsClient({
      apiKey: {
        getKey: () => "sk_stale",
        refresh: async () => {
          refreshed += 1;
          return "sk_fresh";
        },
        clear: () => {},
      },
      baseUrl: BASE,
      fetchImpl,
    });

    expect(await client.list("188")).toEqual(["A"]);
    expect(refreshed).toBe(1);
    expect(calls[1]!.headers.get("Authorization")).toBe("Bearer sk_fresh");
  });

  it("reads nothing when signed out, rather than sending a keyless request", async () => {
    const { fetchImpl, calls } = stubFetch(json({ keys: [] }));
    expect(await clientWith(fetchImpl, null).list("188")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("list", () => {
  it("sorts the names it is given", async () => {
    const { fetchImpl } = stubFetch(json({ keys: ["ZED", "ALPHA"] }));
    expect(await clientWith(fetchImpl).list("188")).toEqual(["ALPHA", "ZED"]);
  });

  it("returns null — not [] — when the read fails or the shape drifts", async () => {
    // The caller renders these differently on purpose: telling a user an agent
    // has no secrets when we could not look invites re-adding one already set.
    for (const reply of [empty(500), json({ notKeys: 1 }), json({ keys: "nope" })]) {
      const { fetchImpl } = stubFetch(reply);
      expect(await clientWith(fetchImpl).list("188")).toBeNull();
    }
  });

  it("survives a transport failure without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await clientWith(fetchImpl).list("188")).toBeNull();
  });
});

describe("set", () => {
  it("posts the documented body and accepts 204", async () => {
    const { fetchImpl, calls } = stubFetch(empty(204));
    await clientWith(fetchImpl).set("188", "API_KEY", "sk-value");

    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ key: "API_KEY", secret: "sk-value" });
  });

  it("throws a message naming the key, and never echoing the value", async () => {
    const { fetchImpl } = stubFetch(
      new Response("your secret sk-value was rejected", { status: 400 }),
    );
    await expect(
      clientWith(fetchImpl).set("188", "API_KEY", "sk-value"),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as VaultSecretError;
      // An upstream that reflects part of the credential back must not put it
      // in a toast.
      return (
        e instanceof VaultSecretError &&
        e.message.includes("API_KEY") &&
        !e.message.includes("sk-value")
      );
    });
  });
});

describe("remove", () => {
  it("treats 404 as success — the vault not holding the key IS the goal", async () => {
    // Reachable from the ordinary path: add a secret before linking, then
    // link. The row is `pending` on a linked agent, so the route asks the
    // vault to delete a name it was never given. Refusing here left the local
    // copy in place with no way to remove it from the UI.
    const { fetchImpl } = stubFetch(empty(404));
    await expect(clientWith(fetchImpl).remove("188", "NEVER_UPLOADED")).resolves.toBeUndefined();
  });

  it("still throws on a real refusal", async () => {
    const { fetchImpl } = stubFetch(empty(500));
    await expect(clientWith(fetchImpl).remove("188", "API_KEY")).rejects.toThrow(
      VaultSecretError,
    );
  });
});
