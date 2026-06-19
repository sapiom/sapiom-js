/**
 * Minimal git helpers for `deploy`. The push targets the minted credential URL
 * directly (passed as the remote argument) rather than persisting it via
 * `remote set-url`, so the short-lived token never lands in `.git/config`.
 */
import { execFileSync } from 'node:child_process';

import { CliError } from './output.js';

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new CliError({
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
    throw new CliError({
      code: 'NOT_GIT',
      message: 'Not a git repository.',
      hint: 'Initialize one: git init && git add -A && git commit -m "init"',
    });
  }
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' });
  } catch {
    throw new CliError({
      code: 'NO_COMMITS',
      message: 'This repository has no commits yet.',
      hint: 'Commit your work: git add -A && git commit -m "…"',
    });
  }
}

export function pushHead(dir: string, pushUrl: string, branch: string): void {
  // Force-push: `deploy` ships the author's current commit, and the freshly
  // provisioned repo is auto-initialized (a starting commit on the branch), so
  // a plain push is non-fast-forward. The author's working tree is the source
  // of truth for their definition; the remote is only a build source.
  git(['push', '--force', pushUrl, `HEAD:${branch}`], dir);
}
