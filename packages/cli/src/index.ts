import { Command } from 'commander';

import { registerAuthCommands } from './commands/auth/index.js';
import { registerConfigCommands } from './commands/config/index.js';
import { registerOrchestrationsCommands } from './commands/orchestrations/index.js';

/**
 * Build the root `sapiom` program. Account-level commands (login/logout) sit at
 * the top; each product area is mounted as its own command group via a
 * `register*Commands` call, so new nouns (db, sandbox, …) slot in here without
 * touching existing groups.
 */
export function buildProgram(): Command {
  const program = new Command('sapiom').description('The Sapiom command-line interface.');

  registerAuthCommands(program);
  registerConfigCommands(program);
  registerOrchestrationsCommands(program);

  return program;
}
