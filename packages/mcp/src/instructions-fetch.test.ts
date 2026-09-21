import { createHash } from "node:crypto";
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

/** First twelve hex of sha-256, the shape the backend puts in the header. */
function digestOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/** The serve-time footer the backend appends; the digest does not cover it. */
function footerFor(release: string, digest: string): string {
  return `_Sapiom teaching content · authoring · release ${release} · ${digest} · served live._`;
}

/** Headers for a body that really hashes to its digest, as the backend sends. */
function stampHeaders(
  canonical: string,
  release = "2.14",
): Record<string, string> {
  return {
    "x-sapiom-content-release": release,
    "x-sapiom-content-digest": digestOf(canonical),
    "x-sapiom-content-key": "authoring",
    "x-sapiom-content-source": "served",
  };
}

function servedResponse(
  body: string,
  headers: Record<string, string>,
  ok = true,
): Response {
  return {
    ok,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A well-stamped 200 for `canonical`, delivered with its footer appended. */
function stampedResponse(canonical: string, release = "2.14"): Response {
  const digest = digestOf(canonical);
  return servedResponse(
    `${canonical}\n\n${footerFor(release, digest)}\n`,
    stampHeaders(canonical, release),
  );
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
    const fetchMock = vi.fn().mockResolvedValue(stampedResponse("ok"));
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

  it("serves the delivered body with its header stamp and caches the canonical body", async () => {
    const canonical = "# Remote instructions";
    const digest = digestOf(canonical);
    mockFetch(() => Promise.resolve(stampedResponse(canonical)));

    const resolved = await resolveInstructions(env, { cacheDir });

    // What the model sees is exactly what the server sent, footer included.
    expect(resolved).toEqual({
      body: `${canonical}\n\n${footerFor("2.14", digest)}`,
      source: "served",
      release: "2.14",
      digest,
    });
    // What is cached is the body the digest describes: the footer says
    // "served live", which a later offline session must not repeat.
    const cached = JSON.parse(
      await readFile(instructionsCachePath(env.apiURL, cacheDir), "utf8"),
    );
    expect(cached).toMatchObject({
      body: canonical,
      release: "2.14",
      digest,
      key: "authoring",
      apiURL: "https://api.sapiom.ai",
    });
    expect(new Date(cached.fetchedAt).toISOString()).toBe(cached.fetchedAt);
  });

  it("accepts a digest header in upper case and with surrounding whitespace", async () => {
    const canonical = "# Remote instructions";
    mockFetch(() =>
      Promise.resolve(
        servedResponse(canonical, {
          "x-sapiom-content-release": "2.14",
          "x-sapiom-content-digest": ` ${digestOf(canonical).toUpperCase()} `,
        }),
      ),
    );
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved).toMatchObject({
      source: "served",
      digest: digestOf(canonical),
    });
  });

  describe("a 200 that fails stamp validation is treated as a failed fetch", () => {
    const warm = "# First session";

    async function warmCache(): Promise<string> {
      mockFetch(() => Promise.resolve(stampedResponse(warm)));
      await resolveInstructions(env, { cacheDir });
      return readFile(instructionsCachePath(env.apiURL, cacheDir), "utf8");
    }

    async function expectCachedUntouched(before: string): Promise<void> {
      const resolved = await resolveInstructions(env, { cacheDir });
      expect(resolved).toMatchObject({
        body: warm,
        source: "cached",
        release: "2.14",
        digest: digestOf(warm),
      });
      await expect(
        readFile(instructionsCachePath(env.apiURL, cacheDir), "utf8"),
      ).resolves.toBe(before);
    }

    it("unstamped (no headers): keeps the warm cache and serves it", async () => {
      const before = await warmCache();
      mockFetch(() => Promise.resolve(servedResponse("# Tampered", {})));
      await expectCachedUntouched(before);
    });

    it("missing digest header: keeps the warm cache and serves it", async () => {
      const before = await warmCache();
      mockFetch(() =>
        Promise.resolve(
          servedResponse("# Tampered", { "x-sapiom-content-release": "2.15" }),
        ),
      );
      await expectCachedUntouched(before);
    });

    it("missing release header: keeps the warm cache and serves it", async () => {
      const before = await warmCache();
      mockFetch(() =>
        Promise.resolve(
          servedResponse("# Tampered", {
            "x-sapiom-content-digest": digestOf("# Tampered"),
          }),
        ),
      );
      await expectCachedUntouched(before);
    });

    it("digest mismatch: keeps the warm cache and serves it", async () => {
      const before = await warmCache();
      mockFetch(() =>
        Promise.resolve(
          servedResponse("# Tampered", stampHeaders("# What was signed")),
        ),
      );
      await expectCachedUntouched(before);
    });

    it("short digest header that is a prefix of the real digest: rejected", async () => {
      const before = await warmCache();
      mockFetch(() =>
        Promise.resolve(
          servedResponse("# Tampered", {
            "x-sapiom-content-release": "2.15",
            "x-sapiom-content-digest": digestOf("# Tampered").slice(0, 1),
          }),
        ),
      );
      await expectCachedUntouched(before);
    });

    it("unstamped with no cache: serves the bundled snapshot and writes nothing", async () => {
      mockFetch(() => Promise.resolve(servedResponse("# Tampered", {})));
      const resolved = await resolveInstructions(env, { cacheDir });
      expect(resolved.source).toBe("bundled");
      expect(resolved.body).toBe(AUTHORING_INSTRUCTIONS);
      await expect(readdir(cacheDir)).resolves.toEqual([]);
    });
  });

  it("writes the cache atomically and leaves no temp file behind", async () => {
    mockFetch(() => Promise.resolve(stampedResponse("# Remote instructions")));
    await resolveInstructions(env, { cacheDir });

    const files = await readdir(cacheDir);
    expect(files).toEqual([
      path.basename(instructionsCachePath(env.apiURL, cacheDir)),
    ]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("serves the last-known-good cache when the live fetch fails", async () => {
    mockFetch(() => Promise.resolve(stampedResponse("# First session")));
    await resolveInstructions(env, { cacheDir });

    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });

    expect(resolved).toEqual({
      body: "# First session",
      source: "cached",
      release: "2.14",
      digest: digestOf("# First session"),
    });
  });

  it("does not overwrite a warm cache with a failed fetch", async () => {
    mockFetch(() => Promise.resolve(stampedResponse("# First session")));
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
    mockFetch(() => Promise.resolve(servedResponse("   ", stampHeaders(""))));
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

  it("ignores a cache record without a release and digest", async () => {
    await writeFile(
      instructionsCachePath(env.apiURL, cacheDir),
      JSON.stringify({ body: "# Old shape" }),
      "utf8",
    );
    mockFetch(() => Promise.reject(new Error("network down")));
    const resolved = await resolveInstructions(env, { cacheDir });
    expect(resolved.source).toBe("bundled");
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

    mockFetch(() => Promise.resolve(stampedResponse("# Production")));
    await resolveInstructions(env, { cacheDir });
    mockFetch(() => Promise.resolve(stampedResponse("# Staging")));
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
    mockFetch(() => Promise.resolve(stampedResponse("# Remote instructions")));
    const resolved = await resolveInstructions(env, { cacheDir: blocked });
    expect(resolved).toMatchObject({ source: "served" });
    expect(resolved.body).toContain("# Remote instructions");
  });

  it("defaults the cache to the directory that holds credentials.json", () => {
    const defaultPath = instructionsCachePath("https://api.sapiom.ai");
    expect(path.basename(path.dirname(defaultPath))).toBe(".sapiom");
  });
});
