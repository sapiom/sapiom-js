import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ResolvedEnvironment } from "./credentials.js";
import {
  instructionsCachePath,
  resolveInstructions,
} from "./instructions-fetch.js";
import {
  AUTHORING_INSTRUCTIONS,
  AUTHORING_INSTRUCTIONS_DIGEST,
  AUTHORING_INSTRUCTIONS_RELEASE,
} from "./instructions.js";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const SERVED_HEADERS = {
  "x-sapiom-content-release": "2.14",
  "x-sapiom-content-digest": "055076ab6773",
  "x-sapiom-content-key": "authoring",
  "x-sapiom-content-source": "served",
};

function servedResponse(
  body: string,
  headers: Record<string, string> = SERVED_HEADERS,
  ok = true,
): Response {
  return {
    ok,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockFetch(impl: (...args: unknown[]) => unknown): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;
}

describe("resolveInstructions", () => {
  let originalFetch: typeof globalThis.fetch;
  let cacheDir: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    cacheDir = await mkdtemp(path.join(tmpdir(), "sapiom-mcp-primer-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("requests the instructions endpoint on the resolved apiURL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(servedResponse("ok"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await resolveInstructions(env, { cacheDir });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/mcp/instructions",
      expect.objectContaining({
        headers: { Accept: "text/markdown, text/plain" },
        signal: expect.anything(),
      }),
    );
  });

  it("serves the live body with its header stamp and writes the cache", async () => {
    mockFetch(() => Promise.resolve(servedResponse("# Remote instructions\n")));

    const resolved = await resolveInstructions(env, { cacheDir });

    expect(resolved).toEqual({
      body: "# Remote instructions",
      source: "served",
      release: "2.14",
      digest: "055076ab6773",
    });
    const cached = JSON.parse(
      await readFile(instructionsCachePath(env.apiURL, cacheDir), "utf8"),
    );
    expect(cached).toMatchObject({
      body: "# Remote instructions",
      release: "2.14",
      digest: "055076ab6773",
      key: "authoring",
      apiURL: "https://api.sapiom.ai",
    });
    expect(new Date(cached.fetchedAt).toISOString()).toBe(cached.fetchedAt);
  });

  it("stamps release and digest as null when the server sends no headers", async () => {
    mockFetch(() => Promise.resolve(servedResponse("# Unstamped", {})));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved).toEqual({
      body: "# Unstamped",
      source: "served",
      release: null,
      digest: null,
    });
  });

  it("writes the cache atomically and leaves no temp file behind", async () => {
    mockFetch(() => Promise.resolve(servedResponse("# Remote instructions")));
    await resolveInstructions(env, { cacheDir });

    const files = await readdir(cacheDir);
    expect(files).toEqual([
      path.basename(instructionsCachePath(env.apiURL, cacheDir)),
    ]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("serves the last-known-good cache when the live fetch fails", async () => {
    mockFetch(() => Promise.resolve(servedResponse("# First session")));
    await resolveInstructions(env, { cacheDir });

    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });

    expect(resolved).toEqual({
      body: "# First session",
      source: "cached",
      release: "2.14",
      digest: "055076ab6773",
    });
  });

  it("does not overwrite a warm cache with a failed fetch", async () => {
    mockFetch(() => Promise.resolve(servedResponse("# First session")));
    await resolveInstructions(env, { cacheDir });
    const before = await readFile(
      instructionsCachePath(env.apiURL, cacheDir),
      "utf8",
    );

    mockFetch(() => Promise.resolve(servedResponse("Not found", {}, false)));
    await resolveInstructions(env, { cacheDir });

    await expect(
      readFile(instructionsCachePath(env.apiURL, cacheDir), "utf8"),
    ).resolves.toBe(before);
  });

  it("serves the bundled snapshot when the fetch fails and there is no cache", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved).toEqual({
      body: AUTHORING_INSTRUCTIONS,
      source: "bundled",
      release: AUTHORING_INSTRUCTIONS_RELEASE,
      digest: AUTHORING_INSTRUCTIONS_DIGEST.slice(0, 12),
    });
    await expect(readdir(cacheDir)).resolves.toEqual([]);
  });

  it("falls through to the bundled snapshot on a non-200", async () => {
    mockFetch(() => Promise.resolve(servedResponse("Not found", {}, false)));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved.source).toBe("bundled");
    expect(resolved.body).toBe(AUTHORING_INSTRUCTIONS);
  });

  it("falls through to the bundled snapshot when the body is empty", async () => {
    mockFetch(() => Promise.resolve(servedResponse("   ")));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved.source).toBe("bundled");
    await expect(readdir(cacheDir)).resolves.toEqual([]);
  });

  it("falls through to the bundled snapshot when the request times out", async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url: unknown, opts?: unknown) =>
        new Promise((_resolve, reject) => {
          (opts as { signal?: AbortSignal })?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const promise = resolveInstructions(env, { cacheDir });
    await vi.advanceTimersByTimeAsync(5000);
    const resolved = await promise;
    expect(resolved.source).toBe("bundled");
  });

  it("ignores a corrupt cache and serves the bundled snapshot", async () => {
    await writeFile(
      instructionsCachePath(env.apiURL, cacheDir),
      "{ not json",
      "utf8",
    );
    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved.source).toBe("bundled");
    expect(resolved.body).toBe(AUTHORING_INSTRUCTIONS);
  });

  it("ignores a cache whose body is missing or blank", async () => {
    await writeFile(
      instructionsCachePath(env.apiURL, cacheDir),
      JSON.stringify({ body: "   ", release: "2.14" }),
      "utf8",
    );
    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved.source).toBe("bundled");
  });

  it("keys the cache by apiURL so production and staging do not collide", async () => {
    const prod = instructionsCachePath("https://api.sapiom.ai", cacheDir);
    const staging = instructionsCachePath("https://api.sapiom.dev", cacheDir);
    const local = instructionsCachePath("http://localhost:3000", cacheDir);
    expect(new Set([prod, staging, local]).size).toBe(3);
    expect(path.dirname(prod)).toBe(cacheDir);
    expect(path.basename(prod)).toMatch(
      /^mcp-instructions-cache-api\.sapiom\.ai-[0-9a-f]{8}\.json$/,
    );
    expect(path.basename(local)).toMatch(
      /^mcp-instructions-cache-localhost_3000-[0-9a-f]{8}\.json$/,
    );

    mockFetch(() => Promise.resolve(servedResponse("# Production")));
    await resolveInstructions(env, { cacheDir });
    mockFetch(() => Promise.resolve(servedResponse("# Staging")));
    await resolveInstructions(
      { ...env, apiURL: "https://api.sapiom.dev" },
      { cacheDir },
    );

    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(resolveInstructions(env, { cacheDir })).resolves.toMatchObject(
      { body: "# Production", source: "cached" },
    );
    await expect(
      resolveInstructions(
        { ...env, apiURL: "https://api.sapiom.dev" },
        { cacheDir },
      ),
    ).resolves.toMatchObject({ body: "# Staging", source: "cached" });
  });

  it("still serves the live body when the cache cannot be written", async () => {
    // A file where the cache directory should be makes mkdir fail.
    const blocked = path.join(cacheDir, "not-a-dir");
    await writeFile(blocked, "", "utf8");
    mockFetch(() => Promise.resolve(servedResponse("# Remote instructions")));
    const resolved = await resolveInstructions(env, { cacheDir: blocked });
    expect(resolved).toMatchObject({
      body: "# Remote instructions",
      source: "served",
    });
  });

  it("defaults the cache to the directory that holds credentials.json", () => {
    const defaultPath = instructionsCachePath("https://api.sapiom.ai");
    expect(path.basename(path.dirname(defaultPath))).toBe(".sapiom");
  });
});
