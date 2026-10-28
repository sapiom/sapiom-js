/**
 * Push a local directory's current contents to a Sapiom git repo — without
 * touching the user's directory (no `.git` created there).
 *
 * Uses a throwaway git-dir in the OS temp area with the source as the work-tree,
 * so `git add -A` snapshots the current files (respecting an exclude for
 * node_modules/.git), commits, and force-pushes to the repo's clone URL. Auth is
 * the caller's credential sent as the `x-sapiom-git-token` header (the git
 * smart-HTTP data plane accepts it), passed through the environment rather than
 * argv, which every local user can read. Force-push because a freshly-created repo is
 * auto-initialized, so a plain push is non-fast-forward — the local working tree
 * is the source of truth for a preview.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PreviewOperationError } from './errors.js';

export function pushLocalDir(sourceDir: string, cloneUrl: string, token: string, branch = 'main'): void {
  const gitDir = mkdtempSync(path.join(tmpdir(), 'sbxprev-git-'));
  const git = (args: string[], env?: NodeJS.ProcessEnv): void => {
    try {
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', sourceDir, ...args], { stdio: 'pipe', env });
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
    // Never upload deps / vcs metadata — the sandbox build installs deps.
    mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    writeFileSync(path.join(gitDir, 'info', 'exclude'), 'node_modules/\n.git/\n');
    git(['add', '-A']);
    git(['-c', 'user.email=preview@sapiom.ai', '-c', 'user.name=sapiom-preview', 'commit', '-q', '-m', 'preview']);
    git(['push', '--force', cloneUrl, `HEAD:${branch}`], tokenHeaderEnv(token));
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/**
 * Process env plus a command-scoped `http.extraHeader` carrying the token,
 * appended after any `GIT_CONFIG_*` pairs the user already set. A rejected
 * header would otherwise send git to credential helpers, askpass and the
 * terminal: the helper list is reset and both prompts are disabled.
 */
function tokenHeaderEnv(token: string): NodeJS.ProcessEnv {
  const existing = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    [`GIT_CONFIG_KEY_${base}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${base}`]: '',
    [`GIT_CONFIG_KEY_${base + 1}`]: 'http.extraHeader',
    [`GIT_CONFIG_VALUE_${base + 1}`]: `x-sapiom-git-token: ${token}`,
    GIT_CONFIG_COUNT: String(base + 2),
  };
}
