/**
 * Minimal git helpers for `deploy`. The push targets the minted credential URL
 * directly (passed as the remote argument) rather than persisting it via
 * `remote set-url`, so the short-lived token never lands in `.git/config`.
 */
import { execFileSync } from 'node:child_process';

import { AgentOperationError } from './errors.js';

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new AgentOperationError({
      code: 'GIT',
      message: `git ${args[0]} failed.`,
      hint: stderr || (err instanceof Error ? err.message : String(err)),
    });
  }
}

/** Fail clearly unless `dir` is a git repo with at least one commit. */
export function assertDeployable(dir: string): void {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
  } catch {
    throw new AgentOperationError({
      code: 'NOT_GIT',
      message: 'Not a git repository.',
      hint: 'Initialize one: git init && git add -A && git commit -m "init"',
    });
  }
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' });
  } catch {
    throw new AgentOperationError({
      code: 'NO_COMMITS',
      message: 'This repository has no commits yet.',
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
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
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
 * `branch`. The template-clone handoff (SAP-1357) uses this to materialize a fork
 * locally.
 *
 * Security: the credential is redacted from any error output, and after a
 * successful clone the origin remote is rewritten to the tokenless HTTPS URL so
 * the short-lived token never lands on disk.
 *
 * Throws `OrchestrationError` (code `GIT_CLONE`) on failure — with the credential
 * scrubbed from the hint.
 */
export function cloneRepo(opts: CloneRepoOptions): void {
  const { cloneUrl, targetDir, branch, repoFullName, cwd } = opts;
  try {
    execFileSync(
      'git',
      // `--` terminates option parsing so a cloneUrl/targetDir that begins with
      // `-` can never be read as a git flag (e.g. `--upload-pack=<cmd>`, which
      // would run an arbitrary command) — second-order argv injection hardening.
      ['clone', '--depth', '1', '--single-branch', '--branch', branch, '--', cloneUrl, targetDir],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString();
    const raw = stderr?.trim() || (err instanceof Error ? err.message : String(err));
    throw new OrchestrationError({
      code: 'GIT_CLONE',
      message: 'git clone failed.',
      hint: redactCredentials(raw),
    });
  }

  // Scrub the token from the checkout: reset origin to the tokenless URL. This is
  // hygiene, not correctness — the clone already succeeded — so a failure here
  // must not fail the whole operation. We can't log (core is console-free), so a
  // best-effort attempt is the right trade-off: worst case the ~1h token lingers
  // in .git/config, which the caller was told to treat as ephemeral anyway.
  try {
    git(['remote', 'set-url', 'origin', `https://github.com/${repoFullName}.git`], targetDir);
  } catch {
    // Non-fatal — see comment above.
  }
}

export function pushHead(dir: string, pushUrl: string, branch: string): void {
  // Force-push: `deploy` ships the author's current commit, and the freshly
  // provisioned repo is auto-initialized (a starting commit on the branch), so
  // a plain push is non-fast-forward. The author's working tree is the source
  // of truth for their definition; the remote is only a build source.
  git(['push', '--force', pushUrl, `HEAD:${branch}`], dir);
}

/**
 * Initialize a throwaway git repo over a synthesized deploy tree and force-push
 * it to the definition repo. `deploy` uses this to ship a self-contained build
 * source (the bundled definition + a generated package.json) rather than the
 * author's raw commit — so relative imports that escape the author's repo root
 * (shared local utils) are already inlined and the remote build can resolve them.
 */
export function pushSynthesizedTree(treeDir: string, pushUrl: string, branch: string): void {
  git(['init', '-q', '-b', branch], treeDir);
  git(['add', '-A'], treeDir);
  git(['-c', 'user.email=deploy@sapiom.ai', '-c', 'user.name=Sapiom Deploy', 'commit', '-q', '-m', 'deploy'], treeDir);
  git(['push', '--force', pushUrl, `HEAD:${branch}`], treeDir);
}
