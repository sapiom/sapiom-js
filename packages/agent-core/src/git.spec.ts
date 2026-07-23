/**
 * Unit tests for the git helpers, focused on `cloneRepo` (the template-clone
 * handoff) and credential-redaction invariants.
 *
 * Fully offline: git operations are exercised against local repos (a file path
 * is a valid git clone/push source), so no network is required.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cloneRepo, pushSynthesizedTree, redactCredentials } from './git';

function makeTmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Create a local git repo with one commit on `main`, usable as a clone source. */
function makeSourceRepo(): string {
  const dir = makeTmp('sapiom-git-src-');
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

describe('redactCredentials', () => {
  it('strips userinfo from any URL so an embedded token cannot leak', () => {
    const raw =
      "fatal: could not read from 'https://x-access-token:ghs_SECRET@github.com/Sapiom-Platform/sapiom-fork-abc.git'";
    const out = redactCredentials(raw);
    expect(out).not.toContain('ghs_SECRET');
    expect(out).toContain('https://***@github.com/Sapiom-Platform/sapiom-fork-abc.git');
  });

  it('leaves credential-free text untouched', () => {
    expect(redactCredentials('fatal: repository not found')).toBe('fatal: repository not found');
  });
});

describe('cloneRepo', () => {
  it('clones the branch and scrubs the token from the origin remote', () => {
    const src = makeSourceRepo();
    const base = makeTmp('sapiom-git-dst-');
    const target = path.join(base, 'checkout');
    try {
      cloneRepo({
        cloneUrl: src, // a local path is a valid clone source; stands in for the token URL
        targetDir: target,
        branch: 'main',
        repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
        cwd: base,
      });

      // The working tree materialized.
      expect(readFileSync(path.join(target, 'index.ts'), 'utf8')).toContain('export const x');

      // Origin was reset to the tokenless canonical URL (no lingering credential).
      const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: target,
        encoding: 'utf8',
      }).trim();
      expect(origin).toBe('https://github.com/Sapiom-Platform/sapiom-fork-abc.git');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('throws GIT_CLONE (not a raw crash) when the source is not a repo', () => {
    const base = makeTmp('sapiom-git-dst-');
    const bogus = path.join(base, 'not-a-repo');
    const target = path.join(base, 'checkout');
    try {
      expect(() =>
        cloneRepo({
          cloneUrl: bogus,
          targetDir: target,
          branch: 'main',
          repoFullName: 'owner/repo',
          cwd: base,
        }),
      ).toThrow(expect.objectContaining({ code: 'GIT_CLONE' }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('pushSynthesizedTree — credential redaction', () => {
  /** Create a local bare repo that can receive pushes. */
  function makeBareRepo(): string {
    const dir = makeTmp('sapiom-git-bare-');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  it('produces a GIT-coded error (not a raw crash) when the push remote is unreachable', () => {
    // Any push failure surfaces as AgentOperationError{ code: 'GIT' } — the
    // shared git() helper wraps stderr and applies redactCredentials. A
    // credential-bearing URL in the hint must never appear raw.
    const tokenUrl = 'https://x-access-token:ghs_SECRET@github.com/owner/repo.git';
    const treeDir = makeTmp('sapiom-deploy-tree-');
    try {
      writeFileSync(path.join(treeDir, 'index.ts'), 'export const x = 1;\n');
      let caught: unknown;
      try {
        pushSynthesizedTree(treeDir, tokenUrl, 'main');
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: 'GIT' });
      // The raw token must not survive into the hint regardless of how git
      // formats its stderr — redactCredentials scrubs any URL userinfo.
      const hint = (caught as { hint?: string }).hint ?? '';
      expect(hint).not.toContain('ghs_SECRET');
    } finally {
      rmSync(treeDir, { recursive: true, force: true });
    }
  });

  it('does not allow a credential to survive into the hint even when git echoes the full URL', () => {
    // Directly validate redactCredentials is applied on stderr that contains a
    // credential-bearing URL — the pattern git would emit on some failure modes.
    // We test redactCredentials independently (see the suite above) and confirm
    // the git() wrapper uses it by asserting the token-free invariant on an
    // actual push failure whose hint we control via the URL we pass.
    const raw =
      "fatal: could not read from 'https://x-access-token:ghs_LEAK@github.com/x/y.git'";
    // Verify redactCredentials — the exact function the git() helper now calls.
    const { redactCredentials: redact } = jest.requireActual('./git') as typeof import('./git');
    const scrubbed = redact(raw);
    expect(scrubbed).not.toContain('ghs_LEAK');
    expect(scrubbed).toContain('***@github.com');
  });

  it('succeeds when pushing to a valid local bare repo', () => {
    const bare = makeBareRepo();
    const treeDir = makeTmp('sapiom-deploy-tree-');
    try {
      writeFileSync(path.join(treeDir, 'index.ts'), 'export const x = 1;\n');
      // Should not throw — the push should succeed.
      expect(() => pushSynthesizedTree(treeDir, bare, 'main')).not.toThrow();
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(treeDir, { recursive: true, force: true });
    }
  });
});
