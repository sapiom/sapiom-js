/**
 * POST /api/connect/github — clone a public or private GitHub repository and
 * return its local path. The web client then registers that path through the
 * existing `/api/workflows/connect` contract, so GitHub import uses the same
 * Agent-project discovery and registry path as every other manually connected
 * folder instead of defining a second project detector here.
 *
 * Primary path: when a GitHub access token is stored in the session (obtained
 * via the Device Flow in github-device.ts), git receives a process-only
 * `http.extraHeader` through its environment. The clone URL stays
 * credential-free, so the token cannot be persisted as the origin URL in
 * `.git/config`, exposed in argv, logged, or surfaced in an error.
 *
 * When production supplies the Device Flow token resolver, a missing/expired
 * OAuth session is rejected before git starts. Tests and other internal callers
 * may omit the resolver to exercise credential-free public clones.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter, type Request } from "express";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// URL validation — kept in sync with the client-side parseGitHubRepoUrl.
// ---------------------------------------------------------------------------

const HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/;
const SSH_RE =
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Normalised clone URL (HTTPS). Used for validation/display, NOT necessarily
   *  what we pass to git — we pass the original so SSH URLs use SSH transport. */
  cloneUrl: string;
}

function parseGitHubUrl(raw: string): ParsedGitHubUrl | null {
  const trimmed = raw.trim();
  let owner: string | undefined;
  let repo: string | undefined;

  const httpsMatch = HTTPS_RE.exec(trimmed);
  if (httpsMatch) {
    owner = httpsMatch[1];
    repo = httpsMatch[2];
  } else {
    const sshMatch = SSH_RE.exec(trimmed);
    if (sshMatch) {
      owner = sshMatch[1];
      repo = sshMatch[2];
    }
  }

  if (!owner || !repo) return null;
  // Reject degenerate names that would cause `git clone` to write into an
  // unintended directory (e.g. "..git" → repo="." → clone into parent).
  if (repo === "." || repo === "..") return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Redact any credential-bearing URL fragment from git output before surfacing
 * it as an error message. Matches the pattern in agent-core/src/git.ts.
 */
function redactCredentials(text: string, token?: string): string {
  let redacted = text.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  redacted = redacted.replace(
    /(authorization:\s*(?:basic|bearer)\s+)[^\s'"`]+/gi,
    "$1***",
  );
  if (token) {
    const basicCredential = Buffer.from(`x-access-token:${token}`).toString(
      "base64",
    );
    redacted = redacted.split(token).join("***");
    redacted = redacted.split(basicCredential).join("***");
  }
  return redacted;
}

export interface ConnectGitHubRouterOptions {
  /**
   * Absolute path to the default parent directory for new clones when the
   * caller does not provide a targetDir. Defaults to `~/sapiom` when omitted.
   */
  defaultCloneParent?: string;
  /**
   * Optional seam for retrieving the GitHub access token stored in the Device
   * Flow session. When provided and the request carries a matching session
   * cookie, private repos are cloned using the token. When absent (or null for
   * the request) the clone falls back to the user's local git credentials.
   *
   * Accepts the same signature as `getGitHubToken` from github-device.ts so
   * the production wiring is a one-liner and tests can inject a stub.
   */
  getToken?: (req: Request) => string | null;
}

/**
 * Run `git clone <repoUrl> <targetDir>` using the user's local git. Returns the
 * absolute target directory on success, throws with a user-readable message on
 * failure.
 *
 * Exported for unit testing (the route handler calls this after validation).
 */
export async function gitClone(
  repoUrl: string,
  targetDir: string,
  token?: string,
): Promise<void> {
  try {
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // A lost OAuth session must fail instead of opening an invisible prompt
      // inside the Studio server process.
      GIT_TERMINAL_PROMPT: "0",
    };
    // A user's debug environment must not print the ephemeral Authorization
    // header. Normal git diagnostics still flow through stderr on failure.
    delete gitEnv.GIT_TRACE;
    delete gitEnv.GIT_TRACE_CURL;
    delete gitEnv.GIT_CURL_VERBOSE;
    if (token) {
      gitEnv.GIT_CONFIG_COUNT = "1";
      gitEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${token}`,
      ).toString("base64")}`;
    }
    // `--` terminates option parsing: a repoUrl/targetDir starting with `-`
    // cannot be misread as a flag (argv-injection hardening mirrors agent-core).
    await execFileAsync("git", ["clone", "--", repoUrl, targetDir], {
      // Run from the user's home directory so relative paths in git config
      // (includeIf, etc.) resolve correctly.
      cwd: os.homedir(),
      // Capture stderr for diagnostics; stdout is not needed for a clone.
      encoding: "utf8",
      env: gitEnv,
    });
  } catch (err) {
    const stderr = redactCredentials(
      (err as { stderr?: string }).stderr ?? "",
      token,
    );
    const msg = redactCredentials(
      err instanceof Error ? err.message : String(err),
      token,
    );
    throw new Error(stderr.trim() || msg);
  }
}

export function createConnectGitHubRouter(
  options: ConnectGitHubRouterOptions = {},
): ExpressRouter {
  const { defaultCloneParent, getToken } = options;
  const router = Router();

  /**
   * POST /api/connect/github
   *
   * Body: { repoUrl: string; targetDir?: string }
   *   repoUrl   — HTTPS or SSH GitHub URL
   *   targetDir — absolute path for the clone (optional; derived from repo
   *               name under the defaultCloneParent when absent)
   *
   * Success: 200 { path: string } — the absolute path of the cloned directory.
   *   The caller registers it through the normal workflows/connect endpoint.
   *
   * Errors:
   *   400 { error }  — invalid URL or dir already exists / non-empty
   *   500 { error }  — git clone failed
   */
  router.post("/api/connect/github", async (req, res) => {
    const body = req.body as
      | { repoUrl?: unknown; targetDir?: unknown }
      | undefined;
    const rawUrl = typeof body?.repoUrl === "string" ? body.repoUrl.trim() : "";
    const rawTarget =
      typeof body?.targetDir === "string" ? body.targetDir.trim() : "";

    // Resolve the GitHub access token for this session (may be null).
    const githubToken = getToken ? getToken(req) : null;
    if (getToken && !githubToken) {
      res.status(401).json({
        error: "GitHub authorization expired. Connect GitHub again.",
      });
      return;
    }

    // --- Validate URL ---
    if (!rawUrl) {
      res.status(400).json({ error: "repoUrl is required" });
      return;
    }
    const parsed = parseGitHubUrl(rawUrl);
    if (!parsed) {
      res.status(400).json({
        error:
          "Invalid GitHub URL. Accepted forms: https://github.com/owner/repo or git@github.com:owner/repo.git",
      });
      return;
    }

    // --- Resolve targetDir ---
    const parent = defaultCloneParent ?? path.join(os.homedir(), "sapiom");
    const resolvedTarget = rawTarget
      ? path.resolve(rawTarget)
      : path.join(parent, parsed.repo);

    // Guard against path traversal: the target must be within an allowed root
    // (the clone parent or the user's home directory).
    if (rawTarget) {
      const allowedRoots = [parent, os.homedir()];
      const withinAllowed = allowedRoots.some(
        (r) => resolvedTarget === r || resolvedTarget.startsWith(r + path.sep),
      );
      if (!withinAllowed) {
        res
          .status(400)
          .json({ error: "targetDir must be within the home directory" });
        return;
      }
    }

    const targetDir = resolvedTarget;

    // Ensure the parent directory exists before checking for collisions.
    try {
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
    } catch {
      // Best-effort: if mkdir fails, the clone itself will surface the error.
    }

    // Reject if targetDir already exists and is non-empty (git clone would fail
    // anyway, but we give a clearer message here).
    try {
      const entries = await fs.readdir(targetDir);
      if (entries.length > 0) {
        res.status(400).json({
          error: `Directory already exists and is not empty: ${targetDir}`,
        });
        return;
      }
    } catch (err) {
      // ENOENT = does not exist yet; that is exactly what we want. Any other
      // error (ENOTDIR, EACCES) is surfaced to the caller.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        res.status(400).json({
          error: `Cannot access target directory: ${(err as Error).message}`,
        });
        return;
      }
    }

    // --- Clone ---
    // With a stored token, use the canonical credential-free HTTPS URL and
    // pass authentication separately through git's process environment. This
    // prevents the OAuth token from becoming the persisted origin URL.
    const cloneUrl = githubToken ? parsed.cloneUrl : rawUrl;
    try {
      await gitClone(cloneUrl, targetDir, githubToken ?? undefined);
    } catch (err) {
      res
        .status(500)
        .json({ error: `git clone failed: ${(err as Error).message}` });
      return;
    }

    // Registration deliberately stays outside this router. The client follows
    // this successful clone with the existing workflows/connect API, whose
    // registry uses the shared marker parser from agent-project-discovery.ts.
    res.json({ path: targetDir });
  });

  return router;
}
