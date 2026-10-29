// jest hoists jest.mock above imports; factory-referenced vars must be `mock`-prefixed.
const mockExecFileSync = jest.fn();
jest.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pushLocalDir } from './git-push';

type Call = { args: string[]; env?: NodeJS.ProcessEnv };

describe('pushLocalDir credential handling', () => {
  let src: string;
  let calls: Call[];
  let savedCount: string | undefined;
  let gitVersion: string;

  beforeEach(() => {
    src = mkdtempSync(path.join(tmpdir(), 'sbxprev-src-'));
    calls = [];
    gitVersion = 'git version 2.53.0';
    savedCount = process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_COUNT;
    mockExecFileSync.mockReset().mockImplementation((_file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      // The version probe is not a credential-bearing call: keep it out of `calls`.
      if (args[0] === '--version') return gitVersion;
      calls.push({ args, env: opts?.env });
      return Buffer.from('');
    });
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    if (savedCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = savedCount;
  });

  it('never puts the token in argv and hands it to the push through the environment', () => {
    pushLocalDir(src, 'https://git.example/repo', 'sk_SECRET');

    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain('sk_SECRET');
        expect(arg).not.toContain('extraHeader');
      }
    }

    const push = calls.find((c) => c.args.includes('push'))!;
    expect(push.args.slice(-3)).toEqual(['--force', 'https://git.example/repo', 'HEAD:main']);
    const env = push.env!;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_1).toBe('x-sapiom-git-token: sk_SECRET');
  });

  it('gives no credential env to init, add or commit', () => {
    pushLocalDir(src, 'https://git.example/repo', 'sk_SECRET');

    const others = calls.filter((c) => !c.args.includes('push'));
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) expect(call.env).toBeUndefined();
  });

  it('appends after GIT_CONFIG pairs the caller already set', () => {
    process.env.GIT_CONFIG_COUNT = '1';

    pushLocalDir(src, 'https://git.example/repo', 'sk_SECRET');

    const env = calls.find((c) => c.args.includes('push'))!.env!;
    expect(env.GIT_CONFIG_COUNT).toBe('3');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper');
    expect(env.GIT_CONFIG_KEY_2).toBe('http.extraHeader');
  });

  it('refuses to push on git older than 2.31', () => {
    gitVersion = 'git version 2.25.1';

    expect(() => pushLocalDir(src, 'https://git.example/repo', 'sk_SECRET')).toThrow(
      expect.objectContaining({ code: 'GIT_TOO_OLD', message: expect.stringContaining('2.31') }),
    );
    // Checked before `git init -b`, which git older than 2.28 rejects on its own.
    expect(calls).toHaveLength(0);
  });
});
