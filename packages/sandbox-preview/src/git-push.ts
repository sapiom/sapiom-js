/**
 * Push a local directory's current contents to a Sapiom git repo — without
 * touching the user's directory (no `.git` created there).
 *
 * Uses a throwaway git-dir in the OS temp area with the source as the work-tree,
 * so `git add -A` snapshots the current files (minus node_modules and dotfiles,
 * like the upload mode), commits, and force-pushes to the repo's clone URL.
 * Symlinks are committed as links, never their target. Auth is
 * the caller's credential sent as the `x-sapiom-git-token` header (the git
 * smart-HTTP data plane accepts it). Force-push because a freshly-created repo is
 * auto-initialized, so a plain push is non-fast-forward — the local working tree
 * is the source of truth for a preview.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PreviewOperationError } from './errors.js';

const NEVER_PUSHED = [':(exclude,glob)**/.*', ':(exclude,glob)**/.*/**', ':(exclude,glob)**/node_modules/**'];

export function pushLocalDir(sourceDir: string, cloneUrl: string, token: string, branch = 'main'): void {
  const gitDir = mkdtempSync(path.join(tmpdir(), 'sbxprev-git-'));
  const git = (args: string[]): void => {
    try {
      // cwd = sourceDir: pathspecs (`.` and the excludes below) resolve against the cwd, not the work tree.
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', sourceDir, ...args], { cwd: sourceDir, stdio: 'pipe' });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
      throw new PreviewOperationError({
        code: 'GIT_PUSH_FAILED',
        message: `git ${args[0]} failed while pushing to the Sapiom repo.`,
        hint: stderr || (err instanceof Error ? err.message : String(err)),
      });
    }
  };

  try {
    git(['init', '-q', '-b', branch]);
    // Never upload deps (the sandbox build installs them) or dotfiles (`.env`, `.npmrc`,
    // `.git/`), matching `uploadDir`. The exclude file keeps git from walking them; the
    // pathspec enforces it, since a project `.gitignore` negation (`!.env`) beats the exclude file.
    mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    writeFileSync(path.join(gitDir, 'info', 'exclude'), 'node_modules/\n.*\n');
    git(['add', '-A', '--', '.', ...NEVER_PUSHED]);
    git(['-c', 'user.email=preview@sapiom.ai', '-c', 'user.name=sapiom-preview', 'commit', '-q', '-m', 'preview']);
    // Token via -c http.extraHeader (scoped to this command). Force-push HEAD.
    git(['-c', `http.extraHeader=x-sapiom-git-token: ${token}`, 'push', '--force', cloneUrl, `HEAD:${branch}`]);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}
