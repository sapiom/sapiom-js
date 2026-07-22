import { Command } from 'commander';

import { registerAuthCommands } from './commands/auth/index.js';
import { registerConfigCommands } from './commands/config/index.js';
import { registerAgentsCommands } from './commands/agents/index.js';
import { registerDevCommand } from './commands/dev-register.js';
import { registerCommandAnalytics } from './lib/analytics.js';
import { registerSandboxCommands } from './commands/sandbox/index.js';

/**
 * Build the root `sapiom` program. Account-level commands (login/logout) sit at
 * the top; each product area is mounted as its own command group via a
 * `register*Commands` call, so new nouns (db, sandbox, …) slot in here without
 * touching existing groups.
 */
export function buildProgram(): Command {
  const program = new Command('sapiom').description('The Sapiom command-line interface.');

  // Program-level hooks cover every command group registered below.
  registerCommandAnalytics(program);

  registerAuthCommands(program);
  registerConfigCommands(program);
  registerAgentsCommands(program);
  registerDevCommand(program);
  registerSandboxCommands(program);

  return program;
}
