import path from 'node:path';

import { link, OrchestrationError } from '@sapiom/orchestration-core';

import { makeClient } from '../../lib/client.js';
import { writeConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations link [name]` — resolve a server-side orchestration by
 * name (or create it with --create) and cache its id in sapiom.json.
 */
export async function runLink(name: string | undefined, opts: { create?: boolean }): Promise<void> {
  try {
    const dir = process.cwd();
    const target = name ?? path.basename(dir);
    const client = makeClient();

    const result = await link({ name: target, create: opts.create }, client);

    writeConfig(dir, { definitionId: result.definitionId, name: result.name });
    ok({ definitionId: result.definitionId, name: result.name }, [`✓ Linked to ${result.name} (${result.definitionId})`]);
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }
}
