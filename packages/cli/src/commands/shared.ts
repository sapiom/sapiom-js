import { Command } from 'commander';

import { fail, setJsonMode } from '../lib/output.js';

/**
 * Wrap a command action with `--json` capture and structured error handling, so
 * every command across every group fails the same legible way. The Commander
 * instance is always the last argument the action receives.
 */
export function action<A extends unknown[]>(fn: (...a: A) => Promise<void>) {
  return async (...a: A): Promise<void> => {
    const cmd = a[a.length - 1] as Command;
    setJsonMode(Boolean(cmd.opts().json));
    try {
      await fn(...a);
    } catch (err) {
      fail(err);
    }
  };
}

/** Add the global `--json` option to a command. */
export const json = (cmd: Command): Command => cmd.option('--json', 'emit machine-readable JSON output');
