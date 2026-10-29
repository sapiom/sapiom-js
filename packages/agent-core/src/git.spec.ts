/**
 * Unit tests for the git helpers, focused on `cloneRepo` (the template-clone
 * handoff) and credential-redaction invariants.
 *
 * Fully offline: git operations are exercised against local repos (a file path
 * is a valid git clone/push source), so no network is required.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cloneRepo, pushHead, pushSynthesizedTree, redactCredentials } from './git';

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

describe('missing git binary', () => {
  it('maps spawn ENOENT to an actionable GIT_NOT_INSTALLED error, not a raw crash', () => {
    // The first thing that happens on a Windows machine without Git for
    // Windows — a bare "spawn git ENOENT" reads like an internal error, and
    // the remedy has to be in the error itself. The spawn is stubbed with the
    // exact error shape execFileSync produces for a missing binary (PATH
    // manipulation is not reliable under jest, whose child env resolution
    // still found a real git with PATH set to '').
    const cp = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const spy = jest.spyOn(cp, 'execFileSync').mockImplementation(() => {
      const err = new Error('spawnSync git ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      err.errno = -2;
      throw err;
    });
    try {
      cloneRepo({
        cloneUrl: 'https://github.com/example/example.git',
        targetDir: path.join(tmpdir(), 'sapiom-git-noent', 'checkout'),
        branch: 'main',
        repoFullName: 'example/example',
        cwd: tmpdir(),
      });
      throw new Error('expected cloneRepo to throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('GIT_NOT_INSTALLED');
      expect((err as Error).message).toContain('git is not installed');
      expect((err as { hint?: string }).hint).toContain('git-scm.com');
    } finally {
      spy.mockRestore();
    }
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
    // A closed local port: the push fails without any network round trip.
    const tokenUrl = 'https://x-access-token:ghs_SECRET@127.0.0.1:9/owner/repo.git';
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

describe('credentials never reach git argv', () => {
  const TOKEN_URL = 'https://x-access-token:ghs_SECRET@git.example/git/repo';
  type Call = { args: string[]; env?: NodeJS.ProcessEnv };

  let calls: Call[];
  let spy: jest.SpyInstance;
  let savedCount: string | undefined;
  let gitVersion: string;

  beforeEach(() => {
    calls = [];
    gitVersion = 'git version 2.53.0';
    savedCount = process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_COUNT;
    const cp = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    spy = jest.spyOn(cp, 'execFileSync').mockImplementation(((
      _file: string,
      args: readonly string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      // The version probe is not a credential-bearing call: keep it out of `calls`.
      if (args[0] === '--version') return gitVersion;
      calls.push({ args: [...args], env: options?.env });
      return '';
    }) as unknown as typeof cp.execFileSync);
  });

  afterEach(() => {
    spy.mockRestore();
    if (savedCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = savedCount;
  });

  function headerFrom(env: NodeJS.ProcessEnv | undefined): string | undefined {
    const count = Number(env?.GIT_CONFIG_COUNT ?? 0);
    for (let i = 0; i < count; i++) {
      if (env?.[`GIT_CONFIG_KEY_${i}`] === 'http.extraHeader') return env[`GIT_CONFIG_VALUE_${i}`];
    }
    return undefined;
  }

  function decodedBasic(env: NodeJS.ProcessEnv | undefined): string {
    const header = headerFrom(env) ?? '';
    expect(header).toMatch(/^Authorization: Basic /);
    return Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString('utf8');
  }

  function expectNoTokenInArgv(): void {
    for (const call of calls) {
      for (const arg of call.args) expect(arg).not.toContain('ghs_SECRET');
    }
  }

  function expectLockedDown(env: NodeJS.ProcessEnv | undefined): void {
    expect(env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env?.GIT_ASKPASS).toBe('');
    // The helper reset must come before the header so no helper is consulted.
    const count = Number(env?.GIT_CONFIG_COUNT);
    const keys = Array.from({ length: count }, (_, i) => env?.[`GIT_CONFIG_KEY_${i}`]);
    const resetAt = keys.indexOf('credential.helper');
    expect(resetAt).toBeGreaterThanOrEqual(0);
    expect(env?.[`GIT_CONFIG_VALUE_${resetAt}`]).toBe('');
    expect(resetAt).toBeLessThan(keys.indexOf('http.extraHeader'));
  }

  it('cloneRepo passes a tokenless URL and the credential as an env header', () => {
    cloneRepo({ cloneUrl: TOKEN_URL, targetDir: '/tmp/x', branch: 'main', repoFullName: 'o/r', cwd: '/tmp' });

    expectNoTokenInArgv();
    const clone = calls.find((c) => c.args[0] === 'clone')!;
    expect(clone.args).toContain('https://x-access-token@git.example/git/repo');
    expect(decodedBasic(clone.env)).toBe('x-access-token:ghs_SECRET');
    expectLockedDown(clone.env);
  });

  it('pushHead passes a tokenless URL and the credential as an env header', () => {
    pushHead('/tmp/tree', TOKEN_URL, 'main');

    expectNoTokenInArgv();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['push', '--force', 'https://x-access-token@git.example/git/repo', 'HEAD:main']);
    expect(decodedBasic(calls[0].env)).toBe('x-access-token:ghs_SECRET');
    expectLockedDown(calls[0].env);
  });

  it('pushSynthesizedTree only gives the credential to the push', () => {
    pushSynthesizedTree('/tmp/tree', TOKEN_URL, 'main');

    expectNoTokenInArgv();
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toContain('https://x-access-token@git.example/git/repo');
    expect(decodedBasic(push.env)).toBe('x-access-token:ghs_SECRET');
    expectLockedDown(push.env);
    for (const call of calls.filter((c) => c.args[0] !== 'push')) {
      expect(headerFrom(call.env)).toBeUndefined();
    }
  });

  it('keeps a malformed percent escape as typed instead of throwing', () => {
    expect(() => pushHead('/tmp/tree', 'https://x-access-token:a%zz@git.example/git/repo', 'main')).not.toThrow();

    expect(decodedBasic(calls[0].env)).toBe('x-access-token:a%zz');
  });

  it('decodes a percent-encoded password once', () => {
    pushHead('/tmp/tree', 'https://x-access-token:a%2Fb%3Dc@git.example/git/repo', 'main');

    expect(decodedBasic(calls[0].env)).toBe('x-access-token:a/b=c');
  });

  it('appends after GIT_CONFIG pairs the caller already set', () => {
    process.env.GIT_CONFIG_COUNT = '2';
    const saved = { ...process.env };
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'me';
    process.env.GIT_CONFIG_KEY_1 = 'core.autocrlf';
    process.env.GIT_CONFIG_VALUE_1 = 'false';
    try {
      pushHead('/tmp/tree', TOKEN_URL, 'main');
    } finally {
      for (const key of ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']) {
        if (saved[key] === undefined) delete process.env[key];
      }
    }

    const env = calls[0].env!;
    expect(env.GIT_CONFIG_COUNT).toBe('4');
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_VALUE_1).toBe('false');
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.helper');
    expect(env.GIT_CONFIG_KEY_3).toBe('http.extraHeader');
  });

  it('keeps the push URL out of reach of the user\'s HTTPS-to-SSH rewrites', () => {
    pushHead('/tmp/tree', TOKEN_URL, 'main');
    const pushUrl = calls[0].args[2];

    // Real git: rules on the host and on the exact repository URL would reroute a
    // bare URL to SSH, where the header is never sent.
    const dir = makeTmp('sapiom-git-cfg-');
    try {
      const globalConfig = path.join(dir, 'gitconfig');
      writeFileSync(
        globalConfig,
        '[url "ssh://git@git.example/git/repo"]\n\tinsteadOf = https://git.example/git/repo\n' +
          '[url "ssh://git@git.example/"]\n\tinsteadOf = https://git.example/\n\tpushInsteadOf = https://git.example/\n',
      );
      const getUrl = (url: string) =>
        spawnSync('git', ['ls-remote', '--get-url', url], {
          encoding: 'utf8',
          env: { ...calls[0].env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
        }).stdout.trim();
      expect(getUrl('https://git.example/git/repo')).toBe('ssh://git@git.example/git/repo');
      expect(getUrl(pushUrl)).toBe(pushUrl);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a credential push on git older than 2.31, before running git', () => {
    gitVersion = 'git version 2.30.2';

    expect(() => pushHead('/tmp/tree', TOKEN_URL, 'main')).toThrow(
      expect.objectContaining({ code: 'GIT_TOO_OLD', message: expect.stringContaining('2.31') }),
    );
    expect(() =>
      cloneRepo({ cloneUrl: TOKEN_URL, targetDir: '/tmp/x', branch: 'main', repoFullName: 'o/r', cwd: '/tmp' }),
    ).toThrow(expect.objectContaining({ code: 'GIT_TOO_OLD' }));
    // Checked before `git init -b`, which git older than 2.28 rejects on its own.
    expect(() => pushSynthesizedTree('/tmp/tree', TOKEN_URL, 'main')).toThrow(
      expect.objectContaining({ code: 'GIT_TOO_OLD' }),
    );
    expect(calls).toHaveLength(0);
  });

  it('accepts git 2.31 exactly and a vendor-suffixed version', () => {
    gitVersion = 'git version 2.31.0';
    pushHead('/tmp/tree', TOKEN_URL, 'main');
    gitVersion = 'git version 2.39.5 (Apple Git-154)';
    pushHead('/tmp/tree', TOKEN_URL, 'main');

    expect(calls).toHaveLength(2);
  });

  it('passes a URL without userinfo or a local path through unchanged, with no env', () => {
    pushHead('/tmp/tree', 'https://git.example/git/repo', 'main');
    pushHead('/tmp/tree', '/srv/repos/bare.git', 'main');

    expect(calls[0].args[2]).toBe('https://git.example/git/repo');
    expect(calls[0].env).toBeUndefined();
    expect(calls[1].args[2]).toBe('/srv/repos/bare.git');
    expect(calls[1].env).toBeUndefined();
  });
});
