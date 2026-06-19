import { Command } from 'commander';

import { action, json } from '../shared.js';
import { runLogin } from './login.js';
import { runLogout } from './logout.js';

/** Mount the top-level, account-level auth commands. */
export function registerAuthCommands(program: Command): void {
  json(program.command('login').description('Sign in and store a credential for this machine.')).action(action(runLogin));
  json(program.command('logout').description('Clear the locally stored credential.')).action(action(runLogout));
}
