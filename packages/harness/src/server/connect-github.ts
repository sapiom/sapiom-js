/**
 * POST /api/connect/github — clone a public or private GitHub repository and
 * register the cloned directory in the workflow registry so it appears in the
 * Workspace rail.
 *
 * Primary path: when a GitHub access token is stored in the session (obtained
 * via the Device Flow in github-device.ts) the clone URL is rewritten to the
 * authenticated form `https://x-access-token:<token>@github.com/owner/repo.git`
 * so private repos clone without requiring the user's local SSH/credential store.
 * The token is NEVER logged or surfaced in error messages (redacted via
 * `redactCredentials`).
 *
 * Fallback path: when no token is present the clone falls back to the user's
 * local git credential store — exactly as before. Public repos work with no
 * credentials; private repos work when the user has SSH keys or a credential
 * helper configured.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter, type Request } from "express";

import type { WorkflowRegistryLike } from "../core/workflow-registry.js";
import type { WorkflowInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// URL validation — kept in sync with the client-side parseGitHubRepoUrl.
// ---------------------------------------------------------------------------

const HTTPS_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/;
const SSH_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

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
function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
}

export interface ConnectGitHubRouterOptions {
  /** Live workflow registry — the cloned dir is registered via connectPath(). */
  registry: WorkflowRegistryLike;
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
 * Run `git clone <repoUrl> <targetDir>` using the user's local git (and
 * credential store). Returns the absolute target directory on success, throws
 * with a user-readable message on failure.
 *
 * Exported for unit testing (the route handler calls this after validation).
 */
export async function gitClone(repoUrl: string, targetDir: string): Promise<void> {
  try {
    // `--` terminates option parsing: a repoUrl/targetDir starting with `-`
    // cannot be misread as a flag (argv-injection hardening mirrors agent-core).
    await execFileAsync("git", ["clone", "--", repoUrl, targetDir], {
      // Run from the user's home directory so relative paths in git config
      // (includeIf, etc.) resolve correctly.
      cwd: os.homedir(),
      // Capture stderr for diagnostics; stdout is not needed for a clone.
      encoding: "utf8",
    });
  } catch (err) {
    const stderr = redactCredentials((err as { stderr?: string }).stderr ?? "");
    const msg = redactCredentials(err instanceof Error ? err.message : String(err));
    throw new Error(stderr.trim() || msg);
  }
}

export function createConnectGitHubRouter(options: ConnectGitHubRouterOptions): ExpressRouter {
  const { registry, defaultCloneParent, getToken } = options;
  const router = Router();

  /**
   * POST /api/connect/github
   *
   * Body: { repoUrl: string; targetDir?: string }
   *   repoUrl   — HTTPS or SSH GitHub URL
   *   targetDir — absolute path for the clone (optional; derived from repo
   *               name under the defaultCloneParent when absent)
   *
   * Success: 200 { path: string } — the absolute path of the cloned directory,
   *   already registered in the workflow registry.
   *
   * Errors:
   *   400 { error }  — invalid URL or dir already exists / non-empty
   *   500 { error }  — git clone failed
   */
  router.post("/api/connect/github", async (req, res) => {
    const body = req.body as { repoUrl?: unknown; targetDir?: unknown } | undefined;
    const rawUrl = typeof body?.repoUrl === "string" ? body.repoUrl.trim() : "";
    const rawTarget = typeof body?.targetDir === "string" ? body.targetDir.trim() : "";

    // Resolve the GitHub access token for this session (may be null).
    const githubToken = getToken ? getToken(req) : null;

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
        res.status(400).json({ error: "targetDir must be within the home directory" });
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
        res.status(400).json({ error: `Cannot access target directory: ${(err as Error).message}` });
        return;
      }
    }

    // --- Clone ---
    // When a GitHub token is stored for this session, rewrite the URL to the
    // authenticated HTTPS form so private repos clone without the user's local
    // SSH key or credential helper. The token is never logged (redactCredentials
    // strips it from any error message surfaced to the browser).
    // Fall back to the original URL (SSH or plain HTTPS) when no token exists.
    let cloneUrl: string;
    if (githubToken && parsed) {
      // Always use the authenticated HTTPS form when we have a token; ignore
      // whatever transport the user typed (SSH URLs won't accept the header).
      cloneUrl = `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
    } else {
      cloneUrl = rawUrl;
    }
    try {
      await gitClone(cloneUrl, targetDir);
    } catch (err) {
      res.status(500).json({ error: `git clone failed: ${(err as Error).message}` });
      return;
    }

    // --- Register ---
    // connectPath() mirrors what POST /api/workflows/connect does for local dirs.
    let info: WorkflowInfo;
    try {
      info = await registry.connectPath(targetDir);
    } catch (err) {
      // Clone succeeded but registration failed — surface the path so the user
      // can manually connect it. Not a fatal error.
      res.status(500).json({
        error: `Cloned to ${targetDir} but could not register: ${(err as Error).message}`,
      });
      return;
    }

    res.json({ path: info.path });
  });

  return router;
}
