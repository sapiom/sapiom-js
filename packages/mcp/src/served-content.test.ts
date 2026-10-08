import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  fetchServedContent,
  SERVED_CONTENT_FETCH_TIMEOUT_MS,
  servedContentFetchDisabled,
} from "./served-content.js";

const env = { apiURL: "https://api.sapiom.ai" };
const FLAG = "SAPIOM_TEST_SERVED_CONTENT_DISABLED";

const STAMP_HEADERS = {
  "x-sapiom-content-release": "1.2",
  "x-sapiom-content-digest": "abcdefabcdef",
  "x-sapiom-content-key": "authoring-rules",
};

function mockFetch(impl: (...args: unknown[]) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe("fetchServedContent", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[FLAG];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the trimmed body and the stamp headers from {apiURL}{path}", async () => {
    const fetchMock = mockFetch(() =>
      Promise.resolve(
        new Response("\n# Rules\n\nBody.\n", {
          status: 200,
          headers: STAMP_HEADERS,
        }),
      ),
    );

    await expect(
      fetchServedContent(env, { path: "/v1/agents/authoring-rules" }),
    ).resolves.toEqual({
      body: "# Rules\n\nBody.",
      release: "1.2",
      digest: "abcdefabcdef",
      key: "authoring-rules",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/agents/authoring-rules",
      expect.objectContaining({
        headers: { Accept: "text/markdown, text/plain" },
        signal: expect.anything(),
      }),
    );
  });

  it("returns null stamp fields for an unstamped body", async () => {
    mockFetch(() => Promise.resolve(new Response("plain", { status: 200 })));
    await expect(fetchServedContent(env, { path: "/x" })).resolves.toEqual({
      body: "plain",
      release: null,
      digest: null,
      key: null,
    });
  });

  it("is null on a non-200, an empty body, and a network error", async () => {
    mockFetch(() => Promise.resolve(new Response("gone", { status: 503 })));
    await expect(fetchServedContent(env, { path: "/x" })).resolves.toBeNull();

    mockFetch(() => Promise.resolve(new Response("  \n ", { status: 200 })));
    await expect(fetchServedContent(env, { path: "/x" })).resolves.toBeNull();

    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(fetchServedContent(env, { path: "/x" })).resolves.toBeNull();
  });

  it("is null when the request times out", async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          (opts as { signal: AbortSignal }).signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const pending = fetchServedContent(env, { path: "/x" });
    await vi.advanceTimersByTimeAsync(SERVED_CONTENT_FETCH_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it("reads only the headers when headersOnly is set, even for an empty body", async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response("", { status: 200, headers: STAMP_HEADERS }),
      ),
    );
    await expect(
      fetchServedContent(env, { path: "/x", headersOnly: true }),
    ).resolves.toEqual({
      body: "",
      release: "1.2",
      digest: "abcdefabcdef",
      key: "authoring-rules",
    });
  });

  it.each(["1", "true", " TRUE "])(
    "makes no request when the disable flag is %j",
    async (value) => {
      process.env[FLAG] = value;
      const fetchMock = mockFetch(() => Promise.resolve(new Response("x")));
      await expect(
        fetchServedContent(env, { path: "/x", disableEnv: FLAG }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("servedContentFetchDisabled", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("is false with no flag name, an unset flag, or a value other than 1/true", () => {
    expect(servedContentFetchDisabled()).toBe(false);
    expect(servedContentFetchDisabled(FLAG)).toBe(false);
    process.env[FLAG] = "0";
    expect(servedContentFetchDisabled(FLAG)).toBe(false);
    process.env[FLAG] = "yes";
    expect(servedContentFetchDisabled(FLAG)).toBe(false);
  });
});
