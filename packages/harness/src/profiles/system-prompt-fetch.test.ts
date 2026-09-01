import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";

// `resolveEnvironment` reads ~/.sapiom/credentials.json, so the wrapper's tests would
// otherwise depend on whichever environments the machine running them has logged into.
const resolveEnvironment = vi.hoisted(() => vi.fn());
vi.mock("@sapiom/mcp/auth", () => ({ resolveEnvironment }));

import { DEFAULT_SYSTEM_PROMPT } from "./default.js";
import {
  fetchSystemPrompt,
  fetchSystemPromptForActiveEnvironment,
} from "./system-prompt-fetch.js";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

describe("fetchSystemPrompt", () => {
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
      text: () => Promise.resolve("You are the coding agent, but deployed."),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchSystemPrompt(env)).resolves.toBe(
      "You are the coding agent, but deployed.",
    );
  });

  it("requests the system-prompt endpoint on the resolved apiURL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await fetchSystemPrompt(env);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/harness/system-prompt",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("falls back to the bundled prompt on a non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("Not found"),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchSystemPrompt(env)).resolves.toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("falls back when the body is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("   "),
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchSystemPrompt(env)).resolves.toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("falls back on a network error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("network down"),
      ) as unknown as typeof globalThis.fetch;
    await expect(fetchSystemPrompt(env)).resolves.toBe(DEFAULT_SYSTEM_PROMPT);
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

    const promise = fetchSystemPrompt(env);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("fetchSystemPromptForActiveEnvironment", () => {
  let originalFetch: typeof globalThis.fetch;
  const originalFlag = process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED = originalFlag;
    vi.restoreAllMocks();
  });

  it("pins the bundled prompt without requesting anything when the fetch is disabled", async () => {
    // src/test-setup.ts sets this for the whole suite, which is what keeps every
    // startServer spec off the network — assert the switch actually does that.
    process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED = "1";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(fetchSystemPromptForActiveEnvironment()).resolves.toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the environment and serves what the backend returns", async () => {
    delete process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED;
    resolveEnvironment.mockResolvedValue(env);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("# Deployed prompt"),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(fetchSystemPromptForActiveEnvironment("production")).resolves.toBe(
      "# Deployed prompt",
    );
    expect(resolveEnvironment).toHaveBeenCalledWith("production");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/harness/system-prompt",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("falls back to the bundled prompt when the environment cannot be resolved", async () => {
    // An unreadable credential store must not take a session down with it.
    delete process.env.SAPIOM_HARNESS_PROMPT_FETCH_DISABLED;
    resolveEnvironment.mockRejectedValue(new Error("HOME unset"));
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(fetchSystemPromptForActiveEnvironment()).resolves.toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });
});
