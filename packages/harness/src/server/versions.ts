/**
 * Versions router — the deployed agent's release history, and the two writes
 * that change what runs: activating a version and moving a label.
 *
 * Studio could build and deploy, but had no idea what versions existed or which
 * one was live — that lived only in the web dashboard and the API. This is the
 * surface behind the Versions tab and the version dropdown beside the agent
 * name.
 *
 * Served by CORE (`/v1/workflows/definitions/...`), not the gateway's
 * `agents/v1`. That is deliberate: Core owns the version projection and answers
 * on every deployment including a local stack, where the gateway is not present
 * at all. Note Core authenticates `x-api-key` — the gateway's
 * `x-sapiom-api-key` is rejected there with a 401.
 *
 * The API key stays server-side, exactly as in the runs router: the browser
 * calls these routes, never Core directly.
 */

import { createHash } from "node:crypto";

import { Router } from "express";
import { packSource } from "@sapiom/agent-core";

import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "../core/api-key-provider.js";
import { resolveCoreBaseUrl } from "../core/definition-slug-resolver.js";

/** One row of release history, as Core projects it. */
export interface AgentVersion {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly committedAt: string;
  readonly buildStatus: string;
  readonly deployedAt: string | null;
  /**
   * Movable labels pointing at this version. `latest` appears here too and is
   * COMPUTED from the newest ready build rather than stored, so it cannot go
   * stale — and Core refuses to store it (a DB CHECK), so it can never be moved
   * by hand either.
   */
  readonly tags: readonly string[];
  readonly isActive: boolean;
  /** `"pinned"` when the active version is an explicit pin rather than latest. */
  readonly source?: string;
}

export interface VersionsRouterOpts {
  apiKey: string | null | ApiKeyProvider;
  /** Override the Core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam only, mirroring the runs router. */
  fetchImpl?: typeof fetch;
}

/**
 * What the local working copy would deploy as, and whether that is already a
 * deployed version.
 *
 * The digest is not guessed: `postArchive` returns the digest the engine
 * computes over exactly the bytes it received, and the engine's digest is
 * `sha256` of the archive. Packing is reproducible (sorted entries, fixed
 * mtimes), so hashing a local pack here yields the SAME value a deploy would —
 * which is what makes "your local copy is 0.0.2" a fact rather than a guess.
 *
 * A git-built version can never match: its `commit_sha` is a git sha, not a
 * content digest. So `matchesSha` finding nothing means "not deployed as an
 * archive", not "you have changes" — the UI must not overclaim.
 *
 * Returns null rather than throwing: a project with no `index.ts` is a normal
 * state (never linked, mid-scaffold), and the version list must still render.
 */
export interface LocalSourceView {
  /** sha256 of the archive this directory would upload. */
  readonly digest: string;
  /** The deployed version carrying that digest, when there is one. */
  readonly matchesSha: string | null;
}

export async function readLocalSource(
  projectDir: string,
  versions: readonly AgentVersion[],
): Promise<LocalSourceView | null> {
  try {
    const { archive } = await packSource(projectDir);
    const digest = createHash("sha256").update(archive).digest("hex");
    const match = versions.find((v) => v.sha === digest);
    return { digest, matchesSha: match?.sha ?? null };
  } catch {
    return null;
  }
}

/** How many rows the panel shows. */
export const VERSION_PAGE_SIZE = 10;

/**
 * `latest` first, always. Then labelled releases, then the rest by recency.
 *
 * Three rules, each earning its place:
 *
 * 1. **`latest` pinned to the top.** It is the build a plain deploy just
 *    produced and the one "follow latest" returns to, so it is the row people
 *    look for first. Grouping by label alone sank it below an older tagged
 *    release whenever the newest build had no label of its own — burying the
 *    most-asked-about row.
 * 2. **Labelled releases next.** A plain chronological list buries a tagged
 *    release as soon as a few untagged deploys land on top of it.
 * 3. **`latest` never counts as "labelled" for rule 2.** Every newest build
 *    carries it, so counting it would collapse the two groups into one.
 */
export function orderVersions(
  versions: readonly AgentVersion[],
  limit: number = VERSION_PAGE_SIZE,
): AgentVersion[] {
  const carriesLatest = (v: AgentVersion): boolean => v.tags.includes("latest");
  const isLabelled = (v: AgentVersion): boolean =>
    v.tags.some((t) => t !== "latest");
  const byRecency = (a: AgentVersion, b: AgentVersion): number =>
    Date.parse(b.deployedAt ?? b.committedAt) -
    Date.parse(a.deployedAt ?? a.committedAt);

  // Filtered rather than assumed-single: `latest` should point at exactly one
  // build, and sorting the group keeps the order defined if it ever does not.
  const latest = versions.filter(carriesLatest).sort(byRecency);
  const rest = versions.filter((v) => !carriesLatest(v));
  const labelled = rest.filter(isLabelled).sort(byRecency);
  const plain = rest.filter((v) => !isLabelled(v)).sort(byRecency);
  return [...latest, ...labelled, ...plain].slice(0, limit);
}

/**
 * True when `sha` is the newest ready build — i.e. activating it returns the
 * agent to following latest rather than pinning it back.
 *
 * Drives the confirm: pinning to an older version has consequences worth a
 * second look (later deploys stop going live), returning to the newest does not.
 */
export function isNewestReady(
  versions: readonly AgentVersion[],
  sha: string,
): boolean {
  const ready = versions
    .filter((v) => v.buildStatus === "ready")
    .sort(
      (a, b) =>
        Date.parse(b.deployedAt ?? b.committedAt) -
        Date.parse(a.deployedAt ?? a.committedAt),
    );
  return ready.length > 0 && ready[0].sha === sha;
}

/**
 * Core's own sentence, not its envelope.
 *
 * Core answers errors as `{statusCode, code, message, error, requestId, ...}`,
 * where `message` is written for a human — "'latest' is computed from the
 * newest ready build and cannot be set." — and `error` is the bare HTTP phrase,
 * "Bad Request". Forwarding the envelope untouched put that entire JSON blob,
 * request id and all, into the Versions panel's error banner.
 *
 * Normalising to `{error: <sentence>}` here gives every route in this router
 * the one shape its own 400s already use, so the browser has a single thing to
 * read. Nest also reports validation failures as a `message` ARRAY, hence the
 * join rather than a bare string check.
 */
export function humanError(body: unknown, status: number): string {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: unknown };
    if (typeof b.message === "string" && b.message.trim()) return b.message;
    if (Array.isArray(b.message)) {
      const parts = b.message.filter((m): m is string => typeof m === "string");
      if (parts.length > 0) return parts.join("; ");
    }
    if (typeof b.error === "string" && b.error.trim()) return b.error;
  }
  return `request failed (${status})`;
}

export function createVersionsRouter(opts: VersionsRouterOpts): Router {
  const router = Router();
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (): string => opts.baseUrl ?? resolveCoreBaseUrl();

  /** Core call with the server-held key. Never leaks the key to the caller. */
  const core = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> => {
    const key = provider.getKey();
    if (!key) return { status: 503, body: { error: "not signed in to Sapiom" } };
    const response = await fetchImpl(`${base()}/v1/workflows${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        // Core's header. `x-sapiom-api-key` (the gateway's) 401s here.
        "x-api-key": key,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    // One error shape for every route here, carrying Core's sentence rather
    // than its envelope. Success bodies pass through untouched.
    if (!response.ok) {
      return {
        status: response.status,
        body: { error: humanError(body, response.status) },
      };
    }
    return { status: response.status, body };
  };

  const definitionIdOf = (raw: unknown): string | null =>
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

  /**
   * GET /api/versions/:definitionId
   *
   * 200 { versions, activeSha, pinned } — ordered, capped at VERSION_PAGE_SIZE
   * 400 definitionId missing
   * 503 not signed in
   */
  router.get("/api/versions/:definitionId", async (req, res) => {
    const definitionId = definitionIdOf(req.params.definitionId);
    if (!definitionId) {
      res.status(400).json({ error: "definitionId is required" });
      return;
    }
    try {
      const { status, body } = await core(
        `/definitions/${encodeURIComponent(definitionId)}/versions`,
      );
      if (status !== 200 || !Array.isArray(body)) {
        res.status(status === 200 ? 502 : status).json(
          body ?? { error: "could not load versions" },
        );
        return;
      }
      const all = body as AgentVersion[];
      const active = all.find((v) => v.isActive) ?? null;
      // `dir` is optional: without it the list still renders, just with no
      // statement about the working copy.
      const dir = typeof req.query.dir === "string" ? req.query.dir : null;
      const local = dir ? await readLocalSource(dir, all) : null;
      res.json({
        versions: orderVersions(all),
        activeSha: active?.sha ?? null,
        // An explicit pin means later deploys will NOT go live — the state the
        // panel has to surface, or a pinned agent looks merely up to date.
        pinned: active?.source === "pinned",
        total: all.length,
        local,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /api/versions/:definitionId/activate  { sha }
   *
   * Makes `sha` the live version. The confirm decision lives in the UI (only
   * when pinning to an older build); this route always performs it.
   */
  router.post("/api/versions/:definitionId/activate", async (req, res) => {
    const definitionId = definitionIdOf(req.params.definitionId);
    const sha = definitionIdOf((req.body ?? {}).sha);
    if (!definitionId || !sha) {
      res.status(400).json({ error: "definitionId and sha are required" });
      return;
    }
    try {
      const { status, body } = await core(
        `/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(sha)}/activate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      res.status(status === 200 ? 200 : status).json(body ?? {});
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * DELETE /api/versions/:definitionId/pin — resume following latest.
   *
   * The counterpart to activating an older version: without this the only way
   * out of a pin is to activate the newest build by hand.
   */
  router.delete("/api/versions/:definitionId/pin", async (req, res) => {
    const definitionId = definitionIdOf(req.params.definitionId);
    if (!definitionId) {
      res.status(400).json({ error: "definitionId is required" });
      return;
    }
    try {
      const { status, body } = await core(
        `/definitions/${encodeURIComponent(definitionId)}/version-pin`,
        { method: "DELETE" },
      );
      res.status(status).json(body ?? {});
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * PUT /api/versions/:definitionId/labels/:name  { sha }
   *
   * Create a label, or move an existing one onto `sha`. Core enforces the rules
   * (1–64 chars, and `latest` is reserved by a DB CHECK), so a bad name comes
   * back as its 4xx rather than being guessed at here.
   */
  router.put("/api/versions/:definitionId/labels/:name", async (req, res) => {
    const definitionId = definitionIdOf(req.params.definitionId);
    const name = definitionIdOf(req.params.name);
    const sha = definitionIdOf((req.body ?? {}).sha);
    if (!definitionId || !name || !sha) {
      res
        .status(400)
        .json({ error: "definitionId, label name and sha are required" });
      return;
    }
    try {
      const { status, body } = await core(
        `/definitions/${encodeURIComponent(definitionId)}/tags/${encodeURIComponent(name)}`,
        { method: "PUT", body: JSON.stringify({ sha }) },
      );
      res.status(status).json(body ?? {});
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** DELETE /api/versions/:definitionId/labels/:name — remove a label. */
  router.delete("/api/versions/:definitionId/labels/:name", async (req, res) => {
    const definitionId = definitionIdOf(req.params.definitionId);
    const name = definitionIdOf(req.params.name);
    if (!definitionId || !name) {
      res.status(400).json({ error: "definitionId and label name are required" });
      return;
    }
    try {
      const { status, body } = await core(
        `/definitions/${encodeURIComponent(definitionId)}/tags/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      res.status(status).json(body ?? {});
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
