import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { sapiomStateDirPath, type ResolvedEnvironment } from "./credentials.js";
import {
  AUTHORING_INSTRUCTIONS,
  AUTHORING_INSTRUCTIONS_DIGEST,
  AUTHORING_INSTRUCTIONS_RELEASE,
} from "./instructions.js";

/** How long to wait for the instructions endpoint before falling back. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * How much of a sha-256 a stamp carries — the same prefix the backend puts in
 * `X-Sapiom-Content-Digest`, so a value read off a transcript matches by eye.
 */
const DIGEST_PREFIX_LENGTH = 12;

/**
 * Where the served primer came from, in order of preference:
 * - `served`  — fetched live from `GET {apiURL}/v1/mcp/instructions` this session;
 * - `cached`  — the last body this machine fetched successfully from the same
 *               `apiURL`, because the live fetch failed;
 * - `bundled` — the snapshot compiled into this package at publish time, because
 *               the live fetch failed and no cache exists for this `apiURL`.
 */
export type InstructionsSource = "served" | "cached" | "bundled";

export interface ResolvedInstructions {
  body: string;
  source: InstructionsSource;
  /** Content release id (`X-Sapiom-Content-Release`), or `null` when unstamped. */
  release: string | null;
  /** Body digest prefix (`X-Sapiom-Content-Digest`), or `null` when unstamped. */
  digest: string | null;
}

export interface ResolveInstructionsOptions {
  /**
   * Directory for the last-known-good cache. Defaults to the directory that
   * holds `~/.sapiom/credentials.json`; tests point it at a temp dir.
   */
  cacheDir?: string;
}

/** On-disk shape of one cached primer. One file per `apiURL`. */
interface PrimerCacheRecord {
  body: string;
  release: string | null;
  digest: string | null;
  key: string | null;
  fetchedAt: string;
  apiURL: string;
}

/**
 * Cache file for one `apiURL`, keyed so production and staging (or a local
 * backend) never overwrite each other: a readable, filesystem-safe form of the
 * host plus a short hash of the exact URL to rule out collisions.
 */
export function instructionsCachePath(
  apiURL: string,
  cacheDir: string = sapiomStateDirPath(),
): string {
  const readable = apiURL
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[^a-z0-9.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(apiURL, "utf8").digest("hex");
  return path.join(
    cacheDir,
    `mcp-instructions-cache-${readable || "api"}-${hash.slice(0, 8)}.json`,
  );
}

/**
 * Resolve the authoring instructions the server returns on the MCP `initialize`
 * handshake. Live first, then the last-known-good cache, then the bundled
 * snapshot — so guidance can change without republishing this package, a
 * machine that has connected once keeps the newest text it saw, and a fresh
 * install still starts offline.
 *
 * Never throws and never rejects: the MCP server must always start with
 * usable instructions. A non-200, an empty body, a network error or a timeout
 * moves on to the next source; a cache that is missing, unreadable, corrupt or
 * for another shape is ignored; a cache write that fails is ignored.
 */
export async function resolveInstructions(
  env: Pick<ResolvedEnvironment, "apiURL">,
  options: ResolveInstructionsOptions = {},
): Promise<ResolvedInstructions> {
  const cachePath = instructionsCachePath(env.apiURL, options.cacheDir);

  const served = await fetchServedInstructions(env.apiURL);
  if (served) {
    await writeCache(cachePath, served);
    return {
      body: served.body,
      source: "served",
      release: served.release,
      digest: served.digest,
    };
  }

  const cached = await readCache(cachePath);
  if (cached) {
    return {
      body: cached.body,
      source: "cached",
      release: cached.release,
      digest: cached.digest,
    };
  }

  return {
    body: AUTHORING_INSTRUCTIONS,
    source: "bundled",
    release: AUTHORING_INSTRUCTIONS_RELEASE,
    digest: AUTHORING_INSTRUCTIONS_DIGEST.slice(0, DIGEST_PREFIX_LENGTH),
  };
}

/**
 * The live fetch: `GET {apiURL}/v1/mcp/instructions` (public, no auth), with the
 * content stamp read from the response headers. `null` on any failure.
 */
async function fetchServedInstructions(
  apiURL: string,
): Promise<PrimerCacheRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiURL}/v1/mcp/instructions`, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.text()).trim();
    if (body.length === 0) return null;
    return {
      body,
      release: response.headers.get("x-sapiom-content-release"),
      digest: response.headers.get("x-sapiom-content-digest"),
      key: response.headers.get("x-sapiom-content-key"),
      fetchedAt: new Date().toISOString(),
      apiURL,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write the cache atomically: a temp file in the same directory, then a
 * rename, so a reader never sees a half-written file and a crash mid-write
 * leaves the previous good copy in place. Failures are swallowed — the cache
 * is an optimisation, and the served body is already in hand.
 */
async function writeCache(
  cachePath: string,
  record: PrimerCacheRecord,
): Promise<void> {
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(tempPath, cachePath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** Read and validate the cache. `null` when missing, unreadable, or malformed. */
async function readCache(cachePath: string): Promise<PrimerCacheRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.body !== "string" || record.body.trim().length === 0) {
      return null;
    }
    const optionalString = (value: unknown): string | null =>
      typeof value === "string" ? value : null;
    return {
      body: record.body,
      release: optionalString(record.release),
      digest: optionalString(record.digest),
      key: optionalString(record.key),
      fetchedAt: optionalString(record.fetchedAt) ?? "",
      apiURL: optionalString(record.apiURL) ?? "",
    };
  } catch {
    return null;
  }
}
