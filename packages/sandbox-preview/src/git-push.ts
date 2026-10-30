/**
 * A throwaway git-dir leaves the user's checkout untouched, and the token travels
 * in the environment, not argv. Force-push: the local tree replaces the auto-initialized remote.
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
    // Before `init -b` (git 2.28+), so an old git reports GIT_TOO_OLD, not a failed init.
    assertGitReadsEnvConfig();
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
 * git before 2.31 ignores `GIT_CONFIG_*` env, so the header would be dropped and
 * fail like a rejected token: name the real cause instead.
 */
function assertGitReadsEnvConfig(): void {
  let out: string;
  try {
    out = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return;
  }
  const match = /(\d+)\.(\d+)/.exec(out ?? '');
  if (!match) return;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > 2 || (major === 2 && minor >= 31)) return;
  throw new PreviewOperationError({
    code: 'GIT_TOO_OLD',
    message: `git ${match[0]} is too old: Sapiom needs git 2.31 or newer.`,
    hint: 'Upgrade Git (https://git-scm.com/downloads), then retry.',
  });
}

/**
 * Keeps the token out of argv, and stops a rejected header from falling back to a
 * credential helper or a prompt.
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
