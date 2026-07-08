/**
 * Unit tests for the git helpers, focused on `cloneRepo` (the template-clone
 * handoff, SAP-1357) and its credential-redaction invariant.
 *
 * Fully offline: `cloneRepo` is exercised against a local source repo (a file
 * path is a valid git clone source), so no network is required.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cloneRepo, redactCredentials } from './git';

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
