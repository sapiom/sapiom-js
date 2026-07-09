/**
 * Usage analytics for the CLI: one `command.run` event per executed command,
 * emitted through @sapiom/analytics-core via commander lifecycle hooks.
 *
 * Live by default: the emitter delivers to the hosted Sapiom collector unless
 * opted out. `SAPIOM_ANALYTICS_ENDPOINT` overrides the destination (useful in
 * tests). Opt out with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` —
 * either makes the emitter a complete no-op (zero network calls, zero disk
 * writes, no notice).
 *
 * Privacy: an event carries the command path (canonical command names only),
 * the NAMES of the flags that were passed, the duration, and the exit status.
 * Flag values, positional arguments, tokens, and emails are never recorded.
 * Delivery is enqueue-only — nothing in the command path ever awaits the
 * network; batches flush best-effort on process exit inside analytics-core.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { createAnalytics, type SapiomAnalytics } from '@sapiom/analytics-core';
import { Command } from 'commander';

import { readCredential } from './session.js';

/** The slice of the analytics client the hooks need (injectable in tests). */
export type CommandRunTracker = Pick<SapiomAnalytics, 'track'>;

let sharedAnalytics: SapiomAnalytics | null = null;

/**
 * Lazy process-wide analytics instance. Created on the first completed
 * command, never at import time, so `--help`, parse errors, and library use
 * of `buildProgram()` touch nothing.
 */
function getAnalytics(): SapiomAnalytics {
  if (sharedAnalytics === null) {
    sharedAnalytics = createAnalytics({
      source: 'cli',
      sdkName: '@sapiom/cli',
      sdkVersion: cliVersion(),
      apiKey: resolveTelemetryApiKey(),
    });
  }
  return sharedAnalytics;
}

/**
 * Identity for server-side enrichment (sent as a header by analytics-core,
 * never placed in event payloads). Environment first, then the stored
 * session — same precedence as the API client, but non-throwing: no
 * credential simply means anonymous events.
 */
function resolveTelemetryApiKey(): string | undefined {
  try {
    if (process.env.SAPIOM_API_KEY) return process.env.SAPIOM_API_KEY;
    const stored = readCredential();
    return stored?.accessToken ?? stored?.apiKey ?? undefined;
  } catch {
    return undefined;
  }
}

let cachedVersion: string | null = null;

/**
 * The CLI's own version, read from the package.json that ships next to the
 * running `dist/bin.js`. Resolved from the entry script (argv[1]) rather than
 * `import.meta` so this module stays loadable under CJS test runners; the
 * name check guarantees we never report some other package's version.
 *
 * `0.0.0` is the expected, non-error state whenever the CLI is not the
 * process entrypoint — e.g. under Jest, argv[1] is the worker script, so the
 * name check fails by design; likewise for library imports of buildProgram().
 */
function cliVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = '0.0.0';
  try {
    const entry = process.argv[1];
    if (entry) {
      const pkgPath = path.resolve(path.dirname(realpathSync(entry)), '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === '@sapiom/cli' && typeof pkg.version === 'string') cachedVersion = pkg.version;
    }
  } catch {
    // Unreadable entry path — keep the honest fallback rather than guess.
  }
  return cachedVersion;
}

/** Space-joined canonical command names from the root down, e.g. `agents deploy`. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  // Stop before the root program so the path is `agents deploy`, not
  // `sapiom agents deploy`. Aliases resolve to canonical names via name().
  for (let current: Command | null = command; current && current.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

/**
 * The long names of the options the user actually passed on the command line
 * (`--json`, `--host`, …), collected across the whole command chain (root
 * program → groups → leaf) so group-level options are captured too. Defaults,
 * env-derived, and implied values are excluded, and option VALUES are never
 * read — names only.
 */
export function specifiedFlagNames(command: Command): string[] {
  // Root-to-leaf, mirroring the command-path order; a name that appears on
  // both an ancestor and the leaf is recorded once.
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    chain.unshift(current);
  }

  const seen = new Set<string>();
  const flags: string[] = [];
  for (const owner of chain) {
    for (const option of owner.options) {
      if (owner.getOptionValueSource(option.attributeName()) !== 'cli') continue;
      const name = option.long ?? option.short ?? option.name();
      if (seen.has(name)) continue;
      seen.add(name);
      flags.push(name);
    }
  }
  return flags;
}

/**
 * The exit status the process will report. Commands signal failure by setting
 * `process.exitCode` (see `fail()` in output.ts) rather than throwing, so the
 * post-action hook still runs and can record it.
 */
function currentExitCode(): number {
  const code: unknown = process.exitCode;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string') {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Instrument a commander program with `command.run` usage analytics. Program-
 * level hooks fire for every (nested) subcommand action: `preAction` stamps a
 * start time, `postAction` enqueues one event. Analytics must never change
 * command behavior — every hook body is fully guarded, `track()` is a
 * synchronous enqueue, and nothing here awaits delivery.
 */
export function registerCommandAnalytics(
  program: Command,
  getTracker: () => CommandRunTracker = getAnalytics,
): void {
  const startedAt = new WeakMap<Command, number>();

  program.hook('preAction', (_thisCommand, actionCommand) => {
    try {
      startedAt.set(actionCommand, Date.now());
    } catch {
      // Analytics must never affect the command.
    }
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    try {
      const start = startedAt.get(actionCommand);
      getTracker().track('command.run', {
        command: commandPath(actionCommand),
        flags: specifiedFlagNames(actionCommand),
        duration_ms: start === undefined ? null : Date.now() - start,
        exit_code: currentExitCode(),
      });
    } catch {
      // Analytics must never affect the command.
    }
  });
}
