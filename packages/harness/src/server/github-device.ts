/**
 * GitHub Device Flow router — lets Studio users authorize GitHub without a
 * client secret or a redirect URI.
 *
 * The Client ID comes from `SAPIOM_GITHUB_CLIENT_ID` (env var, read once at
 * module load time). When it is absent the router still mounts, but every
 * endpoint returns 503 with `{ error: "notConfigured" }` so the web UI can
 * fall back gracefully to the URL-paste flow.
 *
 * Token storage: the GitHub access token is held **server-side only**, in a
 * per-process in-memory store keyed by a randomly-generated session cookie.
 * It is NEVER sent to the browser. For v1 this is an in-process Map — if the
 * server restarts the user will need to re-authorize, which is acceptable.
 * Rotate the session cookie on every new authorization to prevent fixation.
 *
 * Endpoints (all require the X-Harness-Token boot-token header, enforced by
 * the /api middleware in server/index.ts):
 *
 *   POST /api/github/device/start
 *     → POST https://github.com/login/device/code
 *     ← { user_code, verification_uri, device_code, interval, expires_in }
 *
 *   POST /api/github/device/poll { device_code }
 *     → POST https://github.com/login/oauth/access_token
 *     ← { status: "authorized"|"pending"|"slow_down"|"expired"|"denied",
 *          interval?: number }
 *
 *   GET /api/github/repos
 *     → GET https://api.github.com/user/repos?...
 *     ← [{ fullName, cloneUrl, private, description, updatedAt }]
 *
 *   GET /api/github/status
 *     ← { connected: boolean, login?: string }
 *
 *   POST /api/github/disconnect
 *     ← { ok: true }
 */

import * as crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";

// ---------------------------------------------------------------------------
// Client ID — env var, read once.
// ---------------------------------------------------------------------------

/** Sapiom Studio's GitHub OAuth App Client ID. A GitHub *Client ID* is public
 *  by design — GitHub displays it on the authorization screen every user sees —
 *  so shipping it as a default is safe and standard (it's how CLI/desktop apps
 *  distribute a Device Flow app). The paired client *secret* is the sensitive
 *  half, and Device Flow deliberately uses none. Override per-environment with
 *  SAPIOM_GITHUB_CLIENT_ID. */
const DEFAULT_GITHUB_CLIENT_ID = "Ov23lipTPRsJBWBlTxgY";

/** Resolve the GitHub OAuth App Client ID: the env override wins, else the
 *  shipped default. Null only if the default is blanked AND the env var is
 *  unset — in which case the UI falls back to the URL-paste form. */
function readClientId(): string | null {
  const v = process.env.SAPIOM_GITHUB_CLIENT_ID;
  if (v && v.trim()) return v.trim();
  return DEFAULT_GITHUB_CLIENT_ID || null;
}

// ---------------------------------------------------------------------------
// In-memory token store (server-side only).
//
// Maps a session cookie value → { githubToken, login }.
// A real production store would use encrypted persistence; for v1 an in-process
// Map is acceptable — it survives the session until the server restarts.
// The token is NEVER sent to the browser.
// ---------------------------------------------------------------------------

interface GitHubSession {
  token: string;
  login: string;
}

// Module-level singleton — one store for the whole server process.
const tokenStore = new Map<string, GitHubSession>();

const SESSION_COOKIE = "gh_sess";

/** Read the session key from the cookie header, or return null. */
function readSessionKey(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const kv = part.trim();
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    if (kv.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(kv.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Write a new randomised session key to the response's Set-Cookie header.
 *  Returns the new key so the route handler can store the token against it. */
function issueSessionKey(res: Response): string {
  const key = crypto.randomBytes(32).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/api/`,
  );
  return key;
}

/** Look up the stored GitHubSession for the current request, or null. */
function getSession(req: Request): GitHubSession | null {
  const key = readSessionKey(req);
  if (!key) return null;
  return tokenStore.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Redaction helper (mirrors connect-github.ts).
// ---------------------------------------------------------------------------

function redactToken(text: string): string {
  // Redact any Bearer / x-access-token credential in a URL.
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
}

// ---------------------------------------------------------------------------
// GitHub API repo shape → our wire shape.
// ---------------------------------------------------------------------------

export interface GitHubRepoEntry {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
}

interface GitHubApiRepo {
  full_name: string;
  clone_url: string;
  private: boolean;
  description: string | null;
  updated_at: string | null;
}

function mapRepo(r: GitHubApiRepo): GitHubRepoEntry {
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: r.private,
    description: r.description ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Device flow poll response shapes.
// ---------------------------------------------------------------------------

export type PollStatus = "authorized" | "pending" | "slow_down" | "expired" | "denied";

export interface PollResult {
  status: PollStatus;
  /** Only present when status === "slow_down" — the updated interval (seconds). */
  interval?: number;
}

/**
 * Map a GitHub token-endpoint response to our PollResult. Called with the
 * parsed JSON body from POST /login/oauth/access_token.
 *
 * Exported so the poll state-machine can be unit-tested without HTTP.
 */
export function mapPollResponse(body: Record<string, unknown>): PollResult {
  if (typeof body.access_token === "string" && body.access_token.length > 0) {
    return { status: "authorized" };
  }
  const error = typeof body.error === "string" ? body.error : "";
  switch (error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down": {
      const interval =
        typeof body.interval === "number" && body.interval > 0
          ? body.interval
          : undefined;
      return { status: "slow_down", ...(interval !== undefined ? { interval } : {}) };
    }
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      // Unknown error — treat as pending so the poller can retry.
      return { status: "pending" };
  }
}

// ---------------------------------------------------------------------------
// Fetch injection seam (for unit tests).
// ---------------------------------------------------------------------------

export interface GitHubDeviceRouterOptions {
  /**
   * Injectable fetch — tests supply a mock, production uses the global.
   * Default: globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override the client ID at construction time (tests). When absent the
   * router reads `SAPIOM_GITHUB_CLIENT_ID` from the environment.
   */
  clientId?: string | null;
}

// ---------------------------------------------------------------------------
// Router factory.
// ---------------------------------------------------------------------------

export function createGitHubDeviceRouter(
  opts: GitHubDeviceRouterOptions = {},
): ReturnType<typeof Router> {
  const clientId = "clientId" in opts ? opts.clientId : readClientId();
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;

  const router = Router();

  /** Middleware: reject all requests when the client ID is not configured. */
  const requireClientId = (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!clientId) {
      res.status(503).json({ error: "notConfigured" });
      return;
    }
    next();
  };

  // ── POST /api/github/device/start ─────────────────────────────────────────

  router.post("/api/github/device/start", requireClientId, async (_req, res) => {
    try {
      const ghRes = await fetchImpl("https://github.com/login/device/code", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: clientId, scope: "repo" }),
      });
      if (!ghRes.ok) {
        res
          .status(502)
          .json({ error: `GitHub device/code responded ${ghRes.status}` });
        return;
      }
      const data = (await ghRes.json()) as Record<string, unknown>;
      // Only forward verification_uri when it is a well-known GitHub device URL
      // to prevent open-redirect via a tampered response.
      const GITHUB_DEVICE_URI = "https://github.com/login/device";
      const rawUri = typeof data.verification_uri === "string" ? data.verification_uri : "";
      const safeUri =
        rawUri.startsWith("https://github.com/") ? rawUri : GITHUB_DEVICE_URI;
      res.json({
        user_code: data.user_code,
        verification_uri: safeUri,
        device_code: data.device_code,
        interval: data.interval,
        expires_in: data.expires_in,
      });
    } catch (err) {
      res.status(502).json({
        error: `Failed to reach GitHub: ${(err as Error).message}`,
      });
    }
  });

  // ── POST /api/github/device/poll ──────────────────────────────────────────

  router.post("/api/github/device/poll", requireClientId, async (req, res) => {
    const body = req.body as { device_code?: unknown } | undefined;
    const deviceCode =
      typeof body?.device_code === "string" ? body.device_code.trim() : "";

    if (!deviceCode) {
      res.status(400).json({ error: "device_code is required" });
      return;
    }

    try {
      const ghRes = await fetchImpl(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
      );

      if (!ghRes.ok) {
        res
          .status(502)
          .json({ error: `GitHub token endpoint responded ${ghRes.status}` });
        return;
      }

      const data = (await ghRes.json()) as Record<string, unknown>;
      const result = mapPollResponse(data);

      if (result.status === "authorized") {
        // Store the token server-side — NEVER return it to the browser.
        const accessToken = data.access_token as string;

        // Fetch the authenticated user's login to populate the status endpoint.
        let login = "unknown";
        try {
          const userRes = await fetchImpl("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github+json",
            },
          });
          if (userRes.ok) {
            const user = (await userRes.json()) as { login?: string };
            if (typeof user.login === "string") login = user.login;
          }
        } catch {
          // Non-fatal — we store the token even if the login lookup fails.
        }

        const sessionKey = issueSessionKey(res);
        tokenStore.set(sessionKey, { token: accessToken, login });
      }

      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(502).json({ error: `Failed to reach GitHub: ${redactToken(msg)}` });
    }
  });

  // ── GET /api/github/repos ─────────────────────────────────────────────────

  router.get("/api/github/repos", async (req, res) => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: "not connected" });
      return;
    }

    try {
      const ghRes = await fetchImpl(
        "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: "application/vnd.github+json",
          },
        },
      );

      if (!ghRes.ok) {
        if (ghRes.status === 401) {
          // Token expired or revoked — clear and ask for re-auth.
          const key = readSessionKey(req);
          if (key) tokenStore.delete(key);
          res.status(401).json({ error: "not connected" });
          return;
        }
        res
          .status(502)
          .json({ error: `GitHub repos API responded ${ghRes.status}` });
        return;
      }

      const repos = (await ghRes.json()) as GitHubApiRepo[];
      res.json(repos.map(mapRepo));
    } catch (err) {
      res.status(502).json({
        error: `Failed to reach GitHub: ${(err as Error).message}`,
      });
    }
  });

  // ── GET /api/github/status ────────────────────────────────────────────────

  router.get("/api/github/status", async (req, res) => {
    // When no client ID is set we still respond (no requireClientId middleware)
    // so the UI can immediately know to show the fallback.
    if (!clientId) {
      res.json({ connected: false, configured: false });
      return;
    }

    const session = getSession(req);
    if (!session) {
      res.json({ connected: false, configured: true });
      return;
    }

    // Verify the token is still valid by calling /user.
    try {
      const ghRes = await fetchImpl("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!ghRes.ok) {
        // Token gone — purge.
        const key = readSessionKey(req);
        if (key) tokenStore.delete(key);
        res.json({ connected: false, configured: true });
        return;
      }
      const user = (await ghRes.json()) as { login?: string };
      res.json({
        connected: true,
        configured: true,
        login: user.login ?? session.login,
      });
    } catch {
      // Network error — report whatever we have cached.
      res.json({ connected: true, configured: true, login: session.login });
    }
  });

  // ── POST /api/github/disconnect ───────────────────────────────────────────

  router.post("/api/github/disconnect", (req, res) => {
    const key = readSessionKey(req);
    if (key) tokenStore.delete(key);
    res.json({ ok: true });
  });

  // ── GET /api/github/token (internal — used by connect-github clone path) ──
  //
  // Not a public endpoint: only used server-side by gitCloneWithToken (called
  // from the existing POST /api/connect/github handler via the extended export).
  // We expose it as a function rather than an HTTP route to keep the token
  // server-side. See connectGitHubWithToken below.

  return router;
}

/**
 * Retrieve the GitHub access token for the request's session.
 * Returns null when the session is absent or the token store has been cleared.
 *
 * Used by the extended clone path (POST /api/connect/github) so private repos
 * can be cloned using the stored token without ever sending it to the browser.
 * The caller is responsible for redacting the token from any error output.
 */
export function getGitHubToken(req: Request): string | null {
  return getSession(req)?.token ?? null;
}

// ---------------------------------------------------------------------------
// Expose the token store for testing only.
// ---------------------------------------------------------------------------

/** @internal — used by unit tests to reset state between runs. */
export function _clearTokenStoreForTest(): void {
  tokenStore.clear();
}
