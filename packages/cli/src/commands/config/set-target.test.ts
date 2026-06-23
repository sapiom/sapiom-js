/**
 * Tests for `sapiom config set-target`. Verifies the accepted targets, the
 * `dev` → `staging` alias, rejection of unknown targets, and that the resolved
 * target persists to `~/.sapiom/config.json` (redirected via XDG_CONFIG_HOME).
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCliConfig } from '../../lib/cli-config.js';
import { CliError } from '../../lib/output.js';
import { runSetTarget } from './set-target.js';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `sapiom-set-target-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('runSetTarget', () => {
  let originalXdg: string | undefined;
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = makeTmpDir();
    // Keep the success line out of the test runner's output.
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it.each(['prod', 'staging', 'local'] as const)('persists target %s', async (target) => {
    await runSetTarget(target);
    expect(readCliConfig().target).toBe(target);
  });

  it("treats 'dev' as an alias for 'staging'", async () => {
    await runSetTarget('dev');
    expect(readCliConfig().target).toBe('staging');
  });

  it('clears any persisted host override when setting a target', async () => {
    await runSetTarget('staging');
    expect(readCliConfig().host).toBeUndefined();
  });

  it('rejects an unknown target', async () => {
    await expect(runSetTarget('production')).rejects.toBeInstanceOf(CliError);
    await expect(runSetTarget('production')).rejects.toThrow(/Unknown target/);
  });
});
