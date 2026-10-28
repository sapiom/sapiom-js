/**
 * Minimal git helpers for `deploy`. The push targets the minted credential URL
 * directly rather than persisting it via `remote set-url`, so the short-lived
 * token never lands in `.git/config`. The URL's credential is moved into the
 * child's environment (see {@link gitAuth}) so it never appears in argv.
 */
import { execFileSync } from "node:child_process";

import { AgentOperationError } from "./errors.js";

/**
 * A missing `git` binary deserves its own message: `execFileSync("git", …)`
 * rejects with a bare `spawn git ENOENT`, which reads like an internal error.
 * It is the FIRST thing that happens on a Windows machine without Git for
 * Windows (git is not preinstalled there, and Claude Code no longer requires
 * it), so the remedy has to be in the error itself.
 */
function gitMissingError(err: unknown): AgentOperationError | null {
  if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") return null;
  return new AgentOperationError({
    code: "GIT_NOT_INSTALLED",
    message: "git is not installed (or not on PATH).",
    hint: "Install Git from https://git-scm.com/downloads, then retry. On Windows, install “Git for Windows” with default options and restart the app so the new PATH is picked up.",
  });
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  try {
    // windowsHide: this runs inside console-less GUI processes (the desktop
    // app and the sapiom-dev MCP server) — a console child would otherwise
    // open a visible window on Windows.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    }).trim();
  } catch (err) {
    const missing = gitMissingError(err);
    if (missing) throw missing;
    const raw = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    // Redact any embedded credential (e.g. a token-bearing push URL echoed by
    // git into stderr) before it reaches the caller, the CLI, or the browser
    // stream. Applies to every git command so no path can leak a token.
    const hint = redactCredentials(
      raw || (err instanceof Error ? err.message : String(err)),
    );
    throw new AgentOperationError({
      code: "GIT",
      message: `git ${args[0]} failed.`,
      hint,
    });
  }
}

/** Fail clearly unless `dir` is a git repo with at least one commit. */
export function assertDeployable(dir: string): void {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new AgentOperationError({
      code: "NOT_GIT",
      message: "Not a git repository.",
      hint: 'Initialize one: git init && git add -A && git commit -m "init"',
    });
  }
  try {
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: "ignore", windowsHide: true });
  } catch {
    throw new AgentOperationError({
      code: "NO_COMMITS",
      message: "This repository has no commits yet.",
      hint: 'Commit your work: git add -A && git commit -m "…"',
    });
  }
}

/**
 * Redact embedded credentials from text before it can be logged or surfaced in
 * an error. Rewrites any URL userinfo (`https://user:token@host` →
 * `https://***@host`), so a git error that echoes a token-bearing clone URL
 * cannot leak the credential. Used by {@link cloneRepo}, whose clone URL embeds a
 * short-lived GitHub App token.
 */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
}

/**
 * Split a token-bearing `https://user:token@host/...` URL into the tokenless
 * URL (safe for argv, which every local user can read through `ps`) and an
 * environment that hands git the same credential as an `Authorization: Basic`
 * header. Anything without userinfo (a plain URL, a local path) is returned
 * unchanged with no environment.
 */
function gitAuth(url: string): { url: string; env?: NodeJS.ProcessEnv } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url };
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.username || !parsed.password) return { url };
  assertGitReadsEnvConfig();
  const basic = Buffer.from(
    `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
  ).toString("base64");
  parsed.username = "";
  parsed.password = "";
  const tokenless = parsed.toString();
  return { url: tokenless, env: gitHeaderEnv(`Authorization: Basic ${basic}`, tokenless) };
}

/**
 * git before 2.31 silently ignores `GIT_CONFIG_COUNT`/`KEY`/`VALUE`, so the
 * credential header is dropped and the request fails like a rejected token.
 * Fail with the real cause instead. An unreadable version is let through: the
 * command itself then reports what is wrong.
 */
function assertGitReadsEnvConfig(): void {
  let out: string;
  try {
    out = execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    const missing = gitMissingError(err);
    if (missing) throw missing;
    return;
  }
  const match = /(\d+)\.(\d+)/.exec(out ?? "");
  if (!match) return;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > 2 || (major === 2 && minor >= 31)) return;
  throw new AgentOperationError({
    code: "GIT_TOO_OLD",
    message: `git ${match[0]} is too old: Sapiom needs git 2.31 or newer.`,
    hint: "Upgrade Git (https://git-scm.com/downloads), then retry.",
  });
}

/**
 * Process env plus a command-scoped `http.extraHeader`, appended after any
 * `GIT_CONFIG_*` pairs the user already set. Without userinfo a rejected
 * header makes git fall back to credential helpers, askpass and the terminal,
 * which could hang or send a different credential: the helper list is reset
 * and both prompts are disabled so a 401 fails fast. The tokenless URL also
 * matches the user's `insteadOf`/`pushInsteadOf` rules (e.g. HTTPS to SSH),
 * which ignore the header: an exact-URL identity rewrite wins over them as the
 * longest match.
 */
function gitHeaderEnv(header: string, url: string): NodeJS.ProcessEnv {
  const existing = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10);
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    [`GIT_CONFIG_KEY_${base}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${base}`]: "",
    [`GIT_CONFIG_KEY_${base + 1}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${base + 1}`]: header,
    [`GIT_CONFIG_KEY_${base + 2}`]: `url.${url}.insteadOf`,
    [`GIT_CONFIG_VALUE_${base + 2}`]: url,
    [`GIT_CONFIG_KEY_${base + 3}`]: `url.${url}.pushInsteadOf`,
    [`GIT_CONFIG_VALUE_${base + 3}`]: url,
    GIT_CONFIG_COUNT: String(base + 4),
  };
}

export interface CloneRepoOptions {
  /**
   * Token-bearing HTTPS clone URL. SECRET: it embeds a live, read-only,
   * single-repo credential — never log it or include it in error output.
   */
  cloneUrl: string;
  /** Absolute path to clone into (created by git; must not already exist non-empty). */
  targetDir: string;
  /** Branch to check out. */
  branch: string;
  /**
   * Full repo name `owner/repo`. After cloning, the remote origin is reset to the
   * tokenless `https://github.com/<repoFullName>.git` so the short-lived clone
   * token is not persisted in the checkout's `.git/config`.
   */
  repoFullName: string;
  /** Working directory git runs from (its parent must exist). */
  cwd: string;
}

/**
 * Clone a per-fork repo from a token-bearing URL into `targetDir` and check out
 * `branch`. Used during the template-clone handoff to materialize a fork locally.
 *
 * Security: the credential is redacted from any error output, and after a
 * successful clone the origin remote is rewritten to the tokenless HTTPS URL so
 * the short-lived token never lands on disk.
 *
 * Throws `AgentOperationError` (code `GIT_CLONE`) on failure — with the credential
 * scrubbed from the hint.
 */
export function cloneRepo(opts: CloneRepoOptions): void {
  const { cloneUrl, targetDir, branch, repoFullName, cwd } = opts;
  const auth = gitAuth(cloneUrl);
  try {
    execFileSync(
      "git",
      // `--` terminates option parsing so a cloneUrl/targetDir that begins with
      // `-` can never be read as a git flag (e.g. `--upload-pack=<cmd>`, which
      // would run an arbitrary command) — second-order argv injection hardening.
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        branch,
        "--",
        auth.url,
        targetDir,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true, env: auth.env },
    );
  } catch (err) {
    const missing = gitMissingError(err);
    if (missing) throw missing;
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString();
    const raw =
      stderr?.trim() || (err instanceof Error ? err.message : String(err));
    throw new AgentOperationError({
      code: "GIT_CLONE",
      message: "git clone failed.",
      hint: redactCredentials(raw),
    });
  }

  // Scrub the token from the checkout: reset origin to the tokenless URL. This is
  // hygiene, not correctness — the clone already succeeded — so a failure here
  // must not fail the whole operation. We can't log (core is console-free), so a
  // best-effort attempt is the right trade-off: worst case the ~1h token lingers
  // in .git/config, which the caller was told to treat as ephemeral anyway.
  try {
    git(
      ["remote", "set-url", "origin", `https://github.com/${repoFullName}.git`],
      targetDir,
    );
  } catch {
    // Non-fatal — see comment above.
  }
}

export function pushHead(dir: string, pushUrl: string, branch: string): void {
  // Force-push the already-committed synthesized deploy tree. This helper is
  // used only when retrying a credential-rejected push; the freshly
  // provisioned repo may already contain a starting commit, so a plain push is
  // non-fast-forward. The remote is only a build source.
  const auth = gitAuth(pushUrl);
  git(["push", "--force", auth.url, `HEAD:${branch}`], dir, auth.env);
}

/**
 * Initialize a throwaway git repo over a synthesized deploy tree and force-push
 * it to the definition repo. `deploy` uses this to ship a self-contained build
 * source (the bundled definition + a generated package.json) rather than the
 * author's raw commit — so relative imports that escape the author's repo root
 * (shared local utils) are already inlined and the remote build can resolve them.
 */
export function pushSynthesizedTree(
  treeDir: string,
  pushUrl: string,
  branch: string,
): void {
  git(["init", "-q", "-b", branch], treeDir);
  git(["add", "-A"], treeDir);
  git(
    [
      "-c",
      "user.email=deploy@sapiom.ai",
      "-c",
      "user.name=Sapiom Deploy",
      "commit",
      "-q",
      "-m",
      "deploy",
    ],
    treeDir,
  );
  const auth = gitAuth(pushUrl);
  git(["push", "--force", auth.url, `HEAD:${branch}`], treeDir, auth.env);
}
