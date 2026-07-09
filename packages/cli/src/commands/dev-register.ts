import { Command } from 'commander';

import { runDev } from './dev.js';
import { fail } from '../lib/output.js';

/**
 * Register the `sapiom dev [dir]` command.
 *
 * The command spawns the `sapiom-harness` bin with stdio inherited, forwarding
 * SIGTERM/SIGHUP and propagating the child's exit code. The program-level
 * analytics hooks fire automatically via the preAction/postAction mechanism.
 *
 * Privacy: [dir] is a positional argument, not an option, so it never appears
 * in specifiedFlagNames() and never reaches the analytics payload.
 *
 * Unknown flags are allowed via .allowUnknownOption() so that future harness
 * flags (e.g. --some-new-flag) pass through without a CLI update. We forward
 * everything after the "dev" token verbatim to the harness so the harness
 * performs its own full argument parsing.
 */
export function registerDevCommand(program: Command): void {
  program
    .command('dev [dir]')
    .description('Launch the Sapiom Harness — a local coding environment with MCP pre-wired.')
    .option('--port <port>', 'port for the harness server')
    .option('--no-open', 'skip opening the browser after the server starts')
    .option('--no-auth', 'skip authentication (for offline/dev use)')
    .option('--no-telemetry', 'disable harness telemetry collection')
    .option('--no-session', 'skip creating an initial terminal session on boot')
    // Allow flags not declared above; they pass through to the harness verbatim.
    .allowUnknownOption()
    .allowExcessArguments(true)
    .action(async (dir: string | undefined, opts: Record<string, unknown>) => {
      try {
        // Extract everything after the 'dev' token from the original argv and
        // pass it raw to the harness. This avoids the commander ambiguity where
        // unknown flags in front of [dir] get absorbed as the positional.
        const rawArgs = sliceAfterDev(process.argv);
        await runDev(dir, { rawArgs });
      } catch (err) {
        fail(err);
      }
    });
}

/**
 * Return all argv tokens that follow the first 'dev' token. This covers:
 *   node bin.js dev /mydir --port 4200 --future-flag
 *   sapiom dev --no-open /mydir
 * The harness receives the same sequence the user typed.
 */
function sliceAfterDev(argv: string[]): string[] {
  const idx = argv.indexOf('dev');
  return idx === -1 ? [] : argv.slice(idx + 1);
}
