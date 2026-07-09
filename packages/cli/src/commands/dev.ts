import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { CliError } from '../lib/output.js';

/**
 * A CJS-compatible require bound to the CLI's real on-disk location.
 *
 * - CJS (ts-jest): __filename is defined — bind to this source file directly.
 * - ESM production: __filename is not defined — resolve the REAL path of
 *   process.argv[1] before binding. This is the critical step: on a Unix
 *   global install, `npm i -g @sapiom/cli` places a symlink at e.g.
 *   `/usr/local/bin/sapiom` → `../lib/node_modules/@sapiom/cli/dist/bin.js`.
 *   `process.argv[1]` is the symlink path. `createRequire` does NOT follow
 *   symlinks internally, so resolution walks from `/usr/local/bin/` and never
 *   reaches `/usr/local/lib/node_modules/` where `@sapiom/harness` lives.
 *   `realpathSync` resolves the symlink to the real file, so the upward walk
 *   finds sibling global packages correctly. This is a no-op on Windows (no
 *   symlink), in the monorepo (already a real path), and in ts-jest (CJS
 *   __filename branch is taken instead).
 *
 * We avoid `import.meta.url` because ts-jest (CJS transform) rejects that
 * syntax at parse time even inside unreachable branches.
 */
function getCliRequire(): NodeRequire {
  // CJS environment (ts-jest): __filename is always defined.
  if (typeof __filename !== 'undefined') {
    return createRequire(__filename);
  }
  // ESM production: realpath the argv[1] symlink before anchoring so that
  // resolution walks from the package's actual on-disk location.
  const entry = process.argv[1];
  if (entry) {
    try {
      return createRequire(realpathSync(entry));
    } catch {
      // realpathSync can fail if the path doesn't exist (e.g. piped stdin
      // script). Fall back to the raw path; resolution may still work.
      return createRequire(entry);
    }
  }
  // Last resort — resolve from the process working directory.
  return createRequire(process.cwd() + '/noop.js');
}

/** Injectable seam for the harness-package.json resolver (testable without disk). */
export type HarnessResolver = {
  /** Resolve the absolute path to @sapiom/harness/package.json, or throw. */
  resolvePackageJson(): string;
};

/** Default resolver: uses the real require.resolve. */
function defaultResolver(): HarnessResolver {
  return {
    resolvePackageJson() {
      return getCliRequire().resolve('@sapiom/harness/package.json');
    },
  };
}

/**
 * Resolve the `sapiom-harness` bin entry from the installed @sapiom/harness
 * package.
 *
 * - ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND → HARNESS_NOT_INSTALLED
 * - ERR_PACKAGE_PATH_NOT_EXPORTED           → HARNESS_NOT_INSTALLED (with a
 *   hint to add "./package.json" to harness exports — we own the package so
 *   this should never occur in practice, but we name it explicitly so the
 *   error never mislabels a version mismatch as "not installed").
 * - package.json found but bin absent        → HARNESS_BIN_NOT_FOUND
 */
export function resolveHarnessBin(resolver: HarnessResolver = defaultResolver()): string {
  let pkgPath: string;
  try {
    pkgPath = resolver.resolvePackageJson();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new CliError({
        code: 'HARNESS_NOT_INSTALLED',
        message: '@sapiom/harness package.json is not exported by its exports map.',
        hint: 'Install or reinstall @sapiom/harness: npm i -g @sapiom/harness',
      });
    }
    // MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND, and any other resolution error.
    throw new CliError({
      code: 'HARNESS_NOT_INSTALLED',
      message: '@sapiom/harness is not installed.',
      hint: 'Install it with: npm i -g @sapiom/harness',
    });
  }

  // Read the bin field from package.json using fs (not require()) so we avoid
  // loading the entire package just to find the entry path.
  let pkg: { bin?: Record<string, string> | string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
  } catch {
    throw new CliError({
      code: 'HARNESS_BIN_NOT_FOUND',
      message: 'Could not read @sapiom/harness/package.json.',
      hint: 'Try reinstalling: npm i -g @sapiom/harness',
    });
  }

  const binEntry =
    typeof pkg.bin === 'string'
      ? pkg.bin
      : typeof pkg.bin === 'object' && pkg.bin !== null
        ? (pkg.bin['sapiom-harness'] ?? Object.values(pkg.bin)[0])
        : undefined;

  if (!binEntry) {
    throw new CliError({
      code: 'HARNESS_BIN_NOT_FOUND',
      message: 'Could not locate the sapiom-harness bin entry in @sapiom/harness.',
      hint: 'Try reinstalling: npm i -g @sapiom/harness',
    });
  }

  const binPath = path.resolve(path.dirname(pkgPath), binEntry);
  if (!existsSync(binPath)) {
    throw new CliError({
      code: 'HARNESS_BIN_NOT_FOUND',
      message: `sapiom-harness bin not found at ${binPath}.`,
      hint: 'Try reinstalling: npm i -g @sapiom/harness',
    });
  }
  return binPath;
}

/**
 * Options collected from the `sapiom dev` command.
 *
 * The `rawArgs` field is the primary path used in production: everything after
 * the "dev" token is forwarded verbatim to the harness so the harness performs
 * its own full argument parsing (including future flags we don't know about).
 *
 * `buildHarnessArgv` is kept as a separately-testable helper that constructs
 * argv from typed options — used in unit tests and as documentation of the
 * known flag set.
 */
export interface DevOptions {
  /** Everything after the 'dev' token — forwarded raw to the harness. */
  rawArgs?: string[];
  // The individual typed fields below are used by buildHarnessArgv for
  // unit-testing purposes; production always uses rawArgs.
  dir?: string;
  port?: string;
  noOpen?: boolean;
  noAuth?: boolean;
  noTelemetry?: boolean;
  noSession?: boolean;
  /** Any extra flags/args beyond the declared set. */
  extraArgs?: string[];
}

/**
 * Construct the argv array passed to the harness bin from typed options.
 * Positional [dir] comes first (if provided), then known flags, then any extra
 * flags forwarded verbatim. Used in unit tests and as documentation of the
 * known flag set; production passes rawArgs directly.
 */
export function buildHarnessArgv(opts: DevOptions): string[] {
  const args: string[] = [];

  if (opts.dir) args.push(opts.dir);
  if (opts.port) args.push('--port', opts.port);
  if (opts.noOpen) args.push('--no-open');
  if (opts.noAuth) args.push('--no-auth');
  if (opts.noTelemetry) args.push('--no-telemetry');
  if (opts.noSession) args.push('--no-session');
  if (opts.extraArgs && opts.extraArgs.length > 0) args.push(...opts.extraArgs);

  return args;
}

/**
 * `sapiom dev [dir]` — launch the Sapiom Harness.
 *
 * Spawns the `sapiom-harness` bin with stdio inherited so the terminal is
 * handed over cleanly. SIGTERM and SIGHUP are forwarded to the child process;
 * SIGINT is intentionally NOT forwarded here — the TTY process group delivers
 * it to both parent and child simultaneously, so double-forwarding would cause
 * the child to receive it twice. The child's exit code is propagated; if the
 * child is killed by a signal, the process exits with 128+signum per POSIX
 * convention. The harness handles its own doctor check, auth, consent prompt,
 * browser open, and startup banner.
 *
 * When `opts.rawArgs` is provided it is used as-is (production path). When
 * absent, `buildHarnessArgv(opts)` is used (test/programmatic path).
 */
export async function runDev(
  dir: string | undefined,
  opts: DevOptions,
  resolver?: HarnessResolver,
): Promise<void> {
  const harnessBin = resolveHarnessBin(resolver);
  const argv = opts.rawArgs !== undefined ? opts.rawArgs : buildHarnessArgv({ ...opts, dir });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [harnessBin, ...argv], {
      stdio: 'inherit',
      env: process.env,
    });

    // Forward SIGTERM and SIGHUP to the child. SIGINT is handled by the TTY
    // process group (Ctrl-C reaches both parent and child) — do NOT re-send it.
    const forwardSigterm = (): void => {
      child.kill('SIGTERM');
    };
    const forwardSighup = (): void => {
      child.kill('SIGHUP');
    };
    process.on('SIGTERM', forwardSigterm);
    process.on('SIGHUP', forwardSighup);

    child.on('error', (err) => {
      process.off('SIGTERM', forwardSigterm);
      process.off('SIGHUP', forwardSighup);
      reject(
        new CliError({
          code: 'HARNESS_SPAWN_FAILED',
          message: `Failed to launch sapiom-harness: ${err.message}`,
        }),
      );
    });

    child.on('close', (code, signal) => {
      process.off('SIGTERM', forwardSigterm);
      process.off('SIGHUP', forwardSighup);
      if (signal) {
        // Mirror POSIX 128+signum convention so callers / shell scripts can
        // distinguish signal termination from a clean non-zero exit.
        const signum = signalToNumber(signal);
        process.exitCode = 128 + signum;
      } else if (code !== null && code !== 0) {
        process.exitCode = code;
      }
      resolve();
    });
  });
}

/** Map a signal name to its POSIX number for exit-code propagation. */
function signalToNumber(signal: string): number {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 0;
}
