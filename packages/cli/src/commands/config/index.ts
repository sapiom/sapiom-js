import { Command } from 'commander';

import { action, json } from '../shared.js';
import { runSetTarget } from './set-target.js';

/**
 * Mount the `sapiom config …` command group for machine-level CLI configuration.
 * Project identity (`sapiom.json`) is handled separately by `agents link`.
 */
export function registerConfigCommands(program: Command): void {
  const group = program
    .command('config')
    .description('Manage machine-level CLI configuration.');

  json(
    group
      .command('set-target <target>')
      .description("Persist the default API target: 'prod' (default) or 'local'."),
  ).action(action(runSetTarget));
}
