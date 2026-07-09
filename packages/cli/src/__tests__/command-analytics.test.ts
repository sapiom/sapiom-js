/**
 * Unit tests for the `command.run` analytics hooks: command-path resolution,
 * flag-name extraction (names only — never values), duration/exit capture,
 * and the guarantee that analytics can never affect a command.
 *
 * These run the hooks in-process against a synthetic program wired with the
 * same `action()`/`json()` helpers as the real CLI; the real built binary is
 * covered end-to-end in command-analytics.e2e.test.ts.
 */
import { Command } from 'commander';

import { action, json } from '../commands/shared.js';
import {
  commandPath,
  registerCommandAnalytics,
  specifiedFlagNames,
  type CommandRunTracker,
} from '../lib/analytics.js';
import { CliError } from '../lib/output.js';

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

/**
 * A miniature program mirroring the real CLI's wiring: a root program with
 * analytics hooks, a nested command group, and actions wrapped with the
 * shared `action()` error handling.
 */
function buildTestProgram(
  tracker: CommandRunTracker,
  act: (...args: unknown[]) => Promise<void> = async () => {},
): Command {
  const program = new Command('sapiom');
  registerCommandAnalytics(program, () => tracker);

  json(program.command('login').description('top-level command')).action(action(act));

  const group = program.command('things').alias('th').description('nested group');
  json(
    group
      .command('push [dir]')
      .description('nested command with a defaulted value option')
      .option('-b, --branch <branch>', 'branch to push to', 'main'),
  ).action(action(act));

  return program;
}

describe('command.run analytics hooks', () => {
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
    // `fail()` sets process.exitCode; leaving it set would fail the jest run.
    process.exitCode = originalExitCode;
  });

  it('tracks a nested command with its canonical path and exit code 0', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(['things', 'push'], { from: 'user' });

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('command.run');
    expect(events[0].data.command).toBe('things push');
    expect(events[0].data.exit_code).toBe(0);
    expect(typeof events[0].data.duration_ms).toBe('number');
    expect(events[0].data.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('emits exactly the documented data fields', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(['things', 'push'], { from: 'user' });

    expect(Object.keys(events[0].data).sort()).toEqual(['command', 'duration_ms', 'exit_code', 'flags']);
  });

  it('records the names of user-passed flags only — no defaults, no values, no positionals', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(
      ['things', 'push', 'secret-positional-dir', '--branch', 'secret-branch-value', '--json'],
      { from: 'user' },
    );

    expect(events[0].data.flags).toEqual(['--branch', '--json']);
    const serialized = JSON.stringify(events[0].data);
    expect(serialized).not.toContain('secret-positional-dir');
    expect(serialized).not.toContain('secret-branch-value');
  });

  it('excludes defaulted options that the user did not pass', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(['things', 'push'], { from: 'user' });

    // --branch has a default of 'main' but was not passed.
    expect(events[0].data.flags).toEqual([]);
  });

  it('resolves group aliases to their canonical command path', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(['th', 'push'], { from: 'user' });

    expect(events[0].data.command).toBe('things push');
  });

  it('tracks top-level commands without a root-program prefix', async () => {
    const { tracker, events } = recordingTracker();
    await buildTestProgram(tracker).parseAsync(['login'], { from: 'user' });

    expect(events[0].data.command).toBe('login');
  });

  it('captures exit code 1 when the action fails through fail()', async () => {
    const { tracker, events } = recordingTracker();
    const program = buildTestProgram(tracker, async () => {
      throw new CliError({ code: 'BOOM', message: 'it broke' });
    });
    await program.parseAsync(['things', 'push'], { from: 'user' });

    expect(events).toHaveLength(1);
    expect(events[0].data.exit_code).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('a throwing tracker never breaks the command', async () => {
    let actionRan = false;
    const tracker: CommandRunTracker = {
      track() {
        throw new Error('analytics exploded');
      },
    };
    const program = buildTestProgram(tracker, async () => {
      actionRan = true;
    });

    await expect(program.parseAsync(['things', 'push'], { from: 'user' })).resolves.toBeDefined();
    expect(actionRan).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  describe('helpers', () => {
    it('commandPath returns an empty string for the root program', () => {
      expect(commandPath(new Command('sapiom'))).toBe('');
    });

    it('specifiedFlagNames returns an empty list for a command with no options', () => {
      expect(specifiedFlagNames(new Command('bare'))).toEqual([]);
    });
  });
});
