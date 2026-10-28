// A throwaway git-dir leaves the user's directory untouched; force-push because a new repo is
// auto-initialized and the local working tree is the preview's source of truth.
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
    // Skip deps and dotfiles like `uploadDir`; pathspecs enforce it because a project
    // `.gitignore` negation (`!.env`) outranks info/exclude.
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
