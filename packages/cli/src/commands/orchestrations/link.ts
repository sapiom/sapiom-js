import path from 'node:path';

import { GatewayClient } from '../../lib/client.js';
import { writeConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

interface DefinitionSummary {
  id: string;
  name: string;
  slug?: string;
}

/**
 * `sapiom orchestrations link [name]` — resolve a server-side orchestration by
 * name (or create it with --create) and cache its id in sapiom.json.
 */
export async function runLink(name: string | undefined, opts: { create?: boolean }): Promise<void> {
  const dir = process.cwd();
  const target = name ?? path.basename(dir);
  const client = new GatewayClient();

  const list = await client.get<DefinitionSummary[]>('/definitions');
  let def = list.find((d) => d.name === target || d.slug === target);

  if (!def) {
    if (!opts.create) {
      throw new CliError({
        code: 'NOT_FOUND',
        message: `No orchestration named '${target}'.`,
        hint: 'Create it with --create, or pass the name of an existing one.',
      });
    }
    def = await client.post<DefinitionSummary>('/definitions', { name: target });
  }

  writeConfig(dir, { definitionId: def.id, name: def.name });
  ok({ definitionId: def.id, name: def.name }, [`✓ Linked to ${def.name} (${def.id})`]);
}
