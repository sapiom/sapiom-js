import path from 'node:path';

import { link, AgentOperationError } from '@sapiom/agent-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { writeConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom agents link [name]` — resolve a server-side agent by
 * name (or create it with --create) and cache its id in sapiom.json.
 *
 * Note: the `--create` path (POST /definitions) depends on backend tenant
 * deploy routes that are being added in a parallel effort and are not yet
 * merged. Linking to an existing definition works today.
 */
export async function runLink(
  name: string | undefined,
  opts: { create?: boolean; host?: string; target?: CliTarget },
): Promise<void> {
  try {
    const dir = process.cwd();
    const linkTarget = name ?? path.basename(dir);
    const client = makeClient({ flagHost: opts.host, flagTarget: opts.target });

    const result = await link({ name: linkTarget, create: opts.create }, client);

    writeConfig(dir, { definitionId: result.definitionId, name: result.name });
    ok({ definitionId: result.definitionId, name: result.name }, [`✓ Linked to ${result.name} (${result.definitionId})`]);
  } catch (err) {
    if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
    throw err;
  }
}
