/**
 * The definition App Link reader (SAP-3255).
 *
 * What these guard: a URL from the network reaching an `href` unless it is a
 * well-formed `https:` link, a failed read surfacing as anything but "no App
 * Link", and the key contract (Bearer, `/v1`, one refresh on 401/403).
 */

import { describe, expect, it, vi } from "vitest";

import type { ApiKeyProvider } from "./api-key-provider.js";
import {
  NO_APP_LINK,
  createDefinitionAppLinkReader,
  extractDefinitionAppLink,
} from "./definition-app-link.js";

const BASE = "http://localhost:3000";
const LIVE = "https://apps.sapiom.ai/acme/content-pack";

function fetchReturning(
  ...responses: Array<{ status: number; body?: unknown } | Error>
): typeof fetch & ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof Error) throw next;
    return new Response(
      next.body === undefined ? "" : JSON.stringify(next.body),
      {
        status: next.status,
      },
    );
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** A provider whose key can change, so refresh-on-401 is observable. */
function provider(
  keys: Array<string | null>,
): ApiKeyProvider & { refreshCalls: number } {
  let index = 0;
  const state = {
    refreshCalls: 0,
    getKey: () => keys[Math.min(index, keys.length - 1)],
    refresh: async () => {
      state.refreshCalls += 1;
      index += 1;
      return keys[Math.min(index, keys.length - 1)];
    },
  };
  return state as unknown as ApiKeyProvider & { refreshCalls: number };
}

describe("extractDefinitionAppLink", () => {
  it("passes a live https link through", () => {
    expect(extractDefinitionAppLink({ url: LIVE, status: "live" })).toEqual({
      url: LIVE,
      status: "live",
    });
  });

  it("keeps unpublished without a URL, even if one is sent", () => {
    expect(
      extractDefinitionAppLink({ url: LIVE, status: "unpublished" }),
    ).toEqual({
      url: null,
      status: "unpublished",
    });
  });

  it.each([
    ["no link", { url: null, status: null }],
    ["live without a URL", { url: null, status: "live" }],
    ["a non-https scheme", { url: "javascript:alert(1)", status: "live" }],
    ["plain http", { url: "http://apps.sapiom.ai/acme/x", status: "live" }],
    ["an unparseable URL", { url: "not a url", status: "live" }],
    ["an unknown status", { url: LIVE, status: "awake" }],
    ["a non-object body", "live"],
    ["null", null],
  ])("reads %s as no App Link", (_label, body) => {
    expect(extractDefinitionAppLink(body)).toEqual(NO_APP_LINK);
  });
});

describe("createDefinitionAppLinkReader", () => {
  it("reads core's definition route with a Bearer key", async () => {
    const fetchImpl = fetchReturning({
      status: 200,
      body: { url: LIVE, status: "live" },
    });
    const reader = createDefinitionAppLinkReader({
      apiKey: "sk_a",
      baseUrl: BASE,
      fetchImpl,
    });

    await expect(reader.read("886")).resolves.toEqual({
      url: LIVE,
      status: "live",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/v1/workflows/definitions/886/app-link`,
      expect.objectContaining({
        headers: { Authorization: "Bearer sk_a" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not call core when signed out", async () => {
    const fetchImpl = fetchReturning({
      status: 200,
      body: { url: LIVE, status: "live" },
    });
    const reader = createDefinitionAppLinkReader({
      apiKey: null,
      baseUrl: BASE,
      fetchImpl,
    });

    await expect(reader.read("886")).resolves.toEqual(NO_APP_LINK);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes the key once on a 401 and retries", async () => {
    const keys = provider(["sk_old", "sk_new"]);
    const fetchImpl = fetchReturning(
      { status: 401 },
      { status: 200, body: { url: LIVE, status: "live" } },
    );
    const reader = createDefinitionAppLinkReader({
      apiKey: keys,
      baseUrl: BASE,
      fetchImpl,
    });

    await expect(reader.read("886")).resolves.toEqual({
      url: LIVE,
      status: "live",
    });
    expect(keys.refreshCalls).toBe(1);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${BASE}/v1/workflows/definitions/886/app-link`,
      expect.objectContaining({
        headers: { Authorization: "Bearer sk_new" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [
      "a 404 (definition not in this org)",
      fetchReturning({ status: 404, body: { code: "not_found" } }),
    ],
    ["a 500", fetchReturning({ status: 500 })],
    ["a transport failure", fetchReturning(new Error("ECONNREFUSED"))],
    [
      "a non-JSON body",
      vi.fn(
        async () => new Response("<html>", { status: 200 }),
      ) as unknown as typeof fetch,
    ],
  ])("degrades %s to no App Link", async (_label, fetchImpl) => {
    const reader = createDefinitionAppLinkReader({
      apiKey: "sk_a",
      baseUrl: BASE,
      fetchImpl,
    });
    await expect(reader.read("886")).resolves.toEqual(NO_APP_LINK);
  });

  it("settles a stalled core as no App Link once the deadline passes", async () => {
    // A fetch that never answers on its own: it settles only when the reader's
    // signal aborts it, the way a hung upstream behaves.
    const stalled = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    ) as unknown as typeof fetch;
    const reader = createDefinitionAppLinkReader({
      apiKey: "sk_a",
      baseUrl: BASE,
      fetchImpl: stalled,
      timeoutMs: 20,
    });

    await expect(reader.read("886")).resolves.toEqual(NO_APP_LINK);
  });

  it("gives the refresh retry the remaining budget, not a fresh one", async () => {
    // The first attempt answers 401 at once; the retry stalls. With one
    // deadline per read the retry is aborted at the original budget, so the
    // read settles well before a second full timeout could elapse.
    const keys = provider(["sk_old", "sk_new"]);
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      call += 1;
      if (call === 1) return Promise.resolve(new Response("", { status: 401 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    }) as unknown as typeof fetch;
    const reader = createDefinitionAppLinkReader({
      apiKey: keys,
      baseUrl: BASE,
      fetchImpl,
      timeoutMs: 40,
    });

    await expect(reader.read("886")).resolves.toEqual(NO_APP_LINK);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });
});
