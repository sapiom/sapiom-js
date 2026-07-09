/**
 * Tests for `sapiom dev`:
 *   1. Command registration — `dev` is registered with the correct flags and
 *      allowUnknownOption so future harness flags don't error.
 *   2. Harness resolution — injectable resolver seam: HARNESS_NOT_INSTALLED,
 *      HARNESS_BIN_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED.
 *   3. Flag passthrough — buildHarnessArgv assembles the correct argv including
 *      unknown/extra flags forwarded verbatim.
 *   4. Spawn behaviour — async spawn mocked: HARNESS_SPAWN_FAILED, exit code
 *      propagation, SIGTERM forwarding (child.kill asserted).
 *   5. Analytics — command.run fires with flag names only; [dir] never leaks.
 *
 * No real harness server is started in any of these tests.
 */
import { EventEmitter } from 'node:events';

import { Command } from 'commander';

import { buildHarnessArgv, resolveHarnessBin, runDev, type DevOptions, type HarnessResolver } from '../commands/dev.js';
import { registerDevCommand } from '../commands/dev-register.js';
import { CliError } from '../lib/output.js';
import { registerCommandAnalytics, type CommandRunTracker } from '../lib/analytics.js';
import { action } from '../commands/shared.js';

// ---------------------------------------------------------------------------
// Shared mock spawn seam
// ---------------------------------------------------------------------------

/**
 * A minimal fake ChildProcess that emits `close` asynchronously so runDev's
 * Promise chain completes. Returns the EventEmitter to allow test-controlled
 * signal sequences.
 */
interface FakeChild extends EventEmitter {
  kill: jest.Mock;
}

function makeFakeChild(opts: { code?: number | null; signal?: string | null; errorOnSpawn?: Error } = {}): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.kill = jest.fn();
  if (opts.errorOnSpawn) {
    setImmediate(() => ee.emit('error', opts.errorOnSpawn));
  } else {
    setImmediate(() => ee.emit('close', opts.code ?? 0, opts.signal ?? null));
  }
  return ee;
}

// ---------------------------------------------------------------------------
// 1. Command registration
// ---------------------------------------------------------------------------
describe('sapiom dev — command registration', () => {
  function buildMinimalProgram(): Command {
    const program = new Command('sapiom');
    registerDevCommand(program);
    return program;
  }

  it('registers a top-level "dev" command on the program', () => {
    const program = buildMinimalProgram();
    expect(program.commands.map((c) => c.name())).toContain('dev');
  });

  it('accepts --port, --no-open, --no-auth, --no-telemetry, --no-session', () => {
    const program = buildMinimalProgram();
    const devCmd = program.commands.find((c) => c.name() === 'dev')!;
    const optionNames = devCmd.options.map((o) => o.long);
    expect(optionNames).toContain('--port');
    expect(optionNames).toContain('--no-open');
    expect(optionNames).toContain('--no-auth');
    expect(optionNames).toContain('--no-telemetry');
    expect(optionNames).toContain('--no-session');
  });

  it('does not error when an unknown flag is passed', async () => {
    // commander would throw/exit if allowUnknownOption() weren't set.
    const program = new Command('sapiom');
    registerDevCommand(program);
    // Override the action after registration with a safe stub so runDev isn't called.
    const devCmd = program.commands.find((c) => c.name() === 'dev')!;
    devCmd.action(async () => {});

    await expect(
      program.parseAsync(['dev', '--future-harness-flag'], { from: 'user' }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Harness resolution — injectable resolver
// ---------------------------------------------------------------------------
describe('resolveHarnessBin — injectable resolver', () => {
  it('throws HARNESS_NOT_INSTALLED when resolver throws MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    const resolver: HarnessResolver = {
      resolvePackageJson() {
        throw err;
      },
    };
    expect(() => resolveHarnessBin(resolver)).toThrow(
      expect.objectContaining({ code: 'HARNESS_NOT_INSTALLED' }),
    );
  });

  it('throws HARNESS_NOT_INSTALLED when resolver throws ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    const err = Object.assign(new Error('Package path not exported'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    const resolver: HarnessResolver = {
      resolvePackageJson() {
        throw err;
      },
    };
    expect(() => resolveHarnessBin(resolver)).toThrow(
      expect.objectContaining({ code: 'HARNESS_NOT_INSTALLED' }),
    );
  });

  it('includes an install hint in HARNESS_NOT_INSTALLED', () => {
    const resolver: HarnessResolver = {
      resolvePackageJson() {
        throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
      },
    };
    let thrown: CliError | null = null;
    try {
      resolveHarnessBin(resolver);
    } catch (e) {
      thrown = e as CliError;
    }
    expect(thrown?.hint).toContain('npm i -g @sapiom/harness');
  });

  it('throws HARNESS_BIN_NOT_FOUND when package.json has no bin field', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sapiom-dev-test-'));
    const pkgPath = path.join(tmpDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: '@sapiom/harness', version: '0.1.1' }));

    const resolver: HarnessResolver = { resolvePackageJson: () => pkgPath };
    expect(() => resolveHarnessBin(resolver)).toThrow(
      expect.objectContaining({ code: 'HARNESS_BIN_NOT_FOUND' }),
    );
  });

  it('throws HARNESS_BIN_NOT_FOUND when bin file does not exist on disk', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sapiom-dev-test-'));
    const pkgPath = path.join(tmpDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ bin: { 'sapiom-harness': './dist/cli/bin.js' } }));

    const resolver: HarnessResolver = { resolvePackageJson: () => pkgPath };
    expect(() => resolveHarnessBin(resolver)).toThrow(
      expect.objectContaining({ code: 'HARNESS_BIN_NOT_FOUND' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Flag passthrough — argv construction (pure unit test, no process spawn)
// ---------------------------------------------------------------------------
describe('buildHarnessArgv', () => {
  it('returns an empty array when no options are given', () => {
    expect(buildHarnessArgv({})).toEqual([]);
  });

  it('places dir as the first positional argument', () => {
    expect(buildHarnessArgv({ dir: '/my/project' })[0]).toBe('/my/project');
  });

  it('appends --port with its value', () => {
    expect(buildHarnessArgv({ port: '4200' })).toEqual(['--port', '4200']);
  });

  it('appends --no-open when noOpen is true', () => {
    expect(buildHarnessArgv({ noOpen: true })).toContain('--no-open');
  });

  it('does NOT append --no-open when noOpen is false or absent', () => {
    expect(buildHarnessArgv({ noOpen: false })).not.toContain('--no-open');
    expect(buildHarnessArgv({})).not.toContain('--no-open');
  });

  it('appends --no-auth when noAuth is true', () => {
    expect(buildHarnessArgv({ noAuth: true })).toContain('--no-auth');
  });

  it('appends --no-telemetry when noTelemetry is true', () => {
    expect(buildHarnessArgv({ noTelemetry: true })).toContain('--no-telemetry');
  });

  it('appends --no-session when noSession is true', () => {
    expect(buildHarnessArgv({ noSession: true })).toContain('--no-session');
  });

  it('builds a full argv with dir and multiple flags', () => {
    const opts: DevOptions = {
      dir: '/workspace/my-app',
      port: '4567',
      noOpen: true,
      noTelemetry: true,
    };
    expect(buildHarnessArgv(opts)).toEqual(['/workspace/my-app', '--port', '4567', '--no-open', '--no-telemetry']);
  });

  it('omits dir when not provided, even alongside flags', () => {
    const argv = buildHarnessArgv({ port: '9000', noOpen: true });
    expect(argv[0]).toBe('--port');
  });

  it('appends extraArgs (unknown flags) verbatim after known flags', () => {
    const argv = buildHarnessArgv({
      port: '4100',
      extraArgs: ['--future-flag', '--debug'],
    });
    expect(argv).toEqual(['--port', '4100', '--future-flag', '--debug']);
  });

  it('unknown flags alone reach the child without error', () => {
    expect(buildHarnessArgv({ extraArgs: ['--new-harness-only-flag'] })).toEqual([
      '--new-harness-only-flag',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Spawn behaviour — async spawn mocked
// ---------------------------------------------------------------------------
describe('runDev — spawn behaviour', () => {
  let spawnMock: jest.SpyInstance;
  let originalExitCode: typeof process.exitCode;

  // A resolver that points at a real (fabricated) bin path so resolveHarnessBin passes.
  function makeOkResolver(): HarnessResolver {
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const nodePath = require('node:path') as typeof import('node:path');

    const tmpDir = mkdtempSync(nodePath.join(os.tmpdir(), 'sapiom-dev-test-'));
    const binPath = nodePath.join(tmpDir, 'bin.js');
    writeFileSync(binPath, '');
    const pkgPath = nodePath.join(tmpDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ bin: { 'sapiom-harness': './bin.js' } }));
    return { resolvePackageJson: () => pkgPath };
  }

  beforeEach(() => {
    originalExitCode = process.exitCode;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    spawnMock = jest.spyOn(require('node:child_process') as typeof import('node:child_process'), 'spawn');
  });

  afterEach(() => {
    spawnMock.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('throws HARNESS_SPAWN_FAILED when the child emits an error', async () => {
    const fakeChild = makeFakeChild({ errorOnSpawn: new Error('ENOENT no such file') });
    spawnMock.mockReturnValue(fakeChild);

    await expect(runDev(undefined, {}, makeOkResolver())).rejects.toMatchObject({
      code: 'HARNESS_SPAWN_FAILED',
    });
  });

  it('propagates non-zero exit code to process.exitCode', async () => {
    const fakeChild = makeFakeChild({ code: 2 });
    spawnMock.mockReturnValue(fakeChild);

    await runDev(undefined, {}, makeOkResolver());
    expect(process.exitCode).toBe(2);
  });

  it('sets exitCode 0 (unchanged) on clean exit', async () => {
    const fakeChild = makeFakeChild({ code: 0 });
    spawnMock.mockReturnValue(fakeChild);
    process.exitCode = undefined;

    await runDev(undefined, {}, makeOkResolver());
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sets 128+signum (143) when child exits via SIGTERM', async () => {
    const fakeChild = makeFakeChild({ code: null, signal: 'SIGTERM' });
    spawnMock.mockReturnValue(fakeChild);

    await runDev(undefined, {}, makeOkResolver());
    expect(process.exitCode).toBe(143); // 128 + 15
  });

  it('forwards SIGTERM to the child and does not throw', async () => {
    let sigTermHandler: (() => void) | undefined;
    const origOn = process.on.bind(process);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onSpy = jest.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      if (event === 'SIGTERM') sigTermHandler = handler as () => void;
      return origOn(event, handler);
    });

    const fakeChild = makeFakeChild({ code: 0 });
    spawnMock.mockReturnValue(fakeChild);

    const devPromise = runDev(undefined, {}, makeOkResolver());
    // Fire SIGTERM before the child closes.
    if (sigTermHandler) sigTermHandler();

    await devPromise;

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    onSpy.mockRestore();
  });

  it('forwards rawArgs verbatim to the child spawn argv', async () => {
    let capturedArgs: string[] | undefined;
    spawnMock.mockImplementation((_execPath: string, args: string[]) => {
      capturedArgs = args;
      return makeFakeChild({ code: 0 });
    });

    const rawArgs = ['/my/project', '--port', '5000', '--future-harness-flag'];
    await runDev(undefined, { rawArgs }, makeOkResolver());

    // The spawned args are [harnessBin, ...rawArgs]; rawArgs start at index 1.
    expect(capturedArgs?.slice(1)).toEqual(rawArgs);
  });
});

// ---------------------------------------------------------------------------
// 5. Analytics — dev fires command.run with flag names only; no dir leakage
// ---------------------------------------------------------------------------
interface TrackedEvent {
  eventType: string;
  data: Record<string, unknown>;
}

function recordingTracker(): { tracker: CommandRunTracker; events: TrackedEvent[] } {
  const events: TrackedEvent[] = [];
  return {
    events,
    tracker: {
      track(eventType: string, data?: Record<string, unknown>) {
        events.push({ eventType, data: data ?? {} });
      },
    },
  };
}

describe('sapiom dev — analytics', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  function buildDevTestProgram(
    tracker: CommandRunTracker,
    act: () => Promise<void> = async () => {},
  ): Command {
    const program = new Command('sapiom');
    registerCommandAnalytics(program, () => tracker);
    program
      .command('dev [dir]')
      .option('--port <port>', 'port for the harness server')
      .option('--no-open', 'skip browser open')
      .option('--no-auth', 'skip auth')
      .option('--no-telemetry', 'skip telemetry')
      .option('--no-session', 'skip session')
      .action(action(act));
    return program;
  }

  it('emits command.run with command path "dev" and exit code 0', async () => {
    const { tracker, events } = recordingTracker();
    await buildDevTestProgram(tracker).parseAsync(['dev'], { from: 'user' });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('command.run');
    expect(events[0].data.command).toBe('dev');
    expect(events[0].data.exit_code).toBe(0);
  });

  it('records --port and --no-open flag names, never their values or the dir positional', async () => {
    const { tracker, events } = recordingTracker();
    const SECRET_DIR = '/secret/project/path';
    await buildDevTestProgram(tracker).parseAsync(
      ['dev', SECRET_DIR, '--port', '9999', '--no-open'],
      { from: 'user' },
    );

    expect(events[0].data.flags).toEqual(['--port', '--no-open']);
    const serialized = JSON.stringify(events[0].data);
    expect(serialized).not.toContain(SECRET_DIR);
    expect(serialized).not.toContain('/secret');
    expect(serialized).not.toContain('9999');
  });

  it('records no flags when dev is called with only a positional [dir]', async () => {
    const { tracker, events } = recordingTracker();
    await buildDevTestProgram(tracker).parseAsync(['dev', '/some/dir'], { from: 'user' });

    expect(events[0].data.flags).toEqual([]);
    expect(JSON.stringify(events[0].data)).not.toContain('/some/dir');
  });

  it('records only the flags that were explicitly passed — no defaults', async () => {
    const { tracker, events } = recordingTracker();
    await buildDevTestProgram(tracker).parseAsync(['dev', '--no-auth', '--no-telemetry'], {
      from: 'user',
    });
    expect(events[0].data.flags).toEqual(['--no-auth', '--no-telemetry']);
  });
});
