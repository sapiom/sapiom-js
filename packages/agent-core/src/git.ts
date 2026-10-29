/**
 * Minimal git helpers for `deploy`. Minted credentials reach git only through the
 * child's environment, never argv (readable by every local user) or `.git/config`.
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
 * argv is readable by every local user, so the password moves to an env header.
 * The non-secret username stays: a bare URL could match the user's `insteadOf` rewrites.
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
    `${decodeUserinfo(parsed.username)}:${decodeUserinfo(parsed.password)}`,
  ).toString("base64");
  parsed.password = "";
  return { url: parsed.toString(), env: gitHeaderEnv(`Authorization: Basic ${basic}`) };
}

/** Like git, keep a malformed escape as typed rather than fail with a raw `URIError`. */
function decodeUserinfo(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * git before 2.31 ignores `GIT_CONFIG_*` env, so the header would be dropped and
 * fail like a rejected token: name the real cause instead.
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
 * A rejected header must fail fast instead of falling back to a credential helper
 * or a prompt, which could hang or send a different credential.
 */
function gitHeaderEnv(header: string): NodeJS.ProcessEnv {
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
    GIT_CONFIG_COUNT: String(base + 2),
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
 * Clone a per-fork repo for the template-clone handoff. Throws `GIT_CLONE` (hint
 * redacted), `GIT_TOO_OLD` or `GIT_NOT_INSTALLED`.
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

  // Canonicalize origin to the public repository URL. The clone already
  // succeeded, so a failure here must not fail the operation.
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
  // Before `init -b` (git 2.28+), so an old git reports GIT_TOO_OLD, not a failed init.
  const auth = gitAuth(pushUrl);
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
  git(["push", "--force", auth.url, `HEAD:${branch}`], treeDir, auth.env);
}
