import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ResolvedEnvironment } from "./credentials.js";
import { fetchInstructions } from "./instructions-fetch.js";
import { AUTHORING_INSTRUCTIONS } from "./instructions.js";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

describe("fetchInstructions", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the fetched body on a 200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("# Remote instructions"),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchInstructions(env)).resolves.toBe("# Remote instructions");
  });

  it("requests the instructions endpoint on the resolved apiURL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await fetchInstructions(env);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/mcp/instructions",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("falls back to the bundled instructions on a non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("Not found"),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchInstructions(env)).resolves.toBe(AUTHORING_INSTRUCTIONS);
  });

  it("falls back when the body is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("   "),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchInstructions(env)).resolves.toBe(AUTHORING_INSTRUCTIONS);
  });

  it("falls back on a network error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof globalThis.fetch;
    await expect(fetchInstructions(env)).resolves.toBe(AUTHORING_INSTRUCTIONS);
  });

  it("falls back when the request times out", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;

    const promise = fetchInstructions(env);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe(AUTHORING_INSTRUCTIONS);
  });
});
