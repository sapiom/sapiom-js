/**
 * link — resolve a server-side agent by name (or create it) and return
 * the definition id + name for the caller to cache in sapiom.json.
 *
 * Networked operation: requires a GatewayClient. Does NOT write sapiom.json
 * itself — that is the CLI command's responsibility, keeping I/O at the edges.
 */
import { GatewayClient } from './client.js';
import { AgentOperationError } from './errors.js';

export interface DefinitionSummary {
  id: string;
  name: string;
  slug?: string;
}

export interface LinkOptions {
  /** Name (or slug) of the agent to link to. */
  name: string;
  /** If true, create the agent when it is not found. */
  create?: boolean;
}

export interface LinkResult {
  definitionId: string;
  name: string;
}

/**
 * Resolve (or create) a server-side agent definition by name.
 *
 * Throws `AgentOperationError` (code `NOT_FOUND` | `HTTP_*` | `NETWORK`) on
 * failures.
 */
export async function link(opts: LinkOptions, client: GatewayClient): Promise<LinkResult> {
  const list = await client.get<DefinitionSummary[]>('/definitions');
  let def = list.find((d) => d.name === opts.name || d.slug === opts.name);

  if (!def) {
    if (!opts.create) {
      throw new AgentOperationError({
        code: 'NOT_FOUND',
        message: `No agent named '${opts.name}'.`,
        hint: 'Create it with { create: true }, or pass the name of an existing one.',
      });
    }
    def = await client.post<DefinitionSummary>('/definitions', { name: opts.name });
  }

  return { definitionId: def.id, name: def.name };
}
