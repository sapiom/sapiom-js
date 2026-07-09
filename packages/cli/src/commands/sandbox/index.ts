import { Command } from 'commander';

import { action, json } from '../shared.js';
import { runPreview } from './preview.js';

/**
 * Mount the `sapiom sandbox …` command group. `preview` deploys local web-app code
 * to a sandbox and exposes a live URL. Distinct from `agents` (the composition
 * product) and from the future production `applications` product.
 */
export function registerSandboxCommands(program: Command): void {
  const group = program.command('sandbox').alias('sbx').description('Run and preview code on Sapiom sandboxes.');

  json(group.command('preview [name]').description('Provision, upload, build, start, and expose a live preview URL.'))
    // Sandboxes run on the compute host, not the API host — so this is a precise
    // services-base override, not the agents' --host/--target (API host).
    .option('--services-url <url>', 'override the compute/sandbox service base URL')
    .action(action(runPreview));
}
