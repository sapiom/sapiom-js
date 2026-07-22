/**
 * CLI-level client factory. Resolves host and API key from the environment,
 * stored CLI config, and the optional project-level host — then delegates to
 * @sapiom/agent-core's GatewayClient.
 *
 * Auth resolution stays here (in the CLI) because it reads process.env and the
 * local session store — both are CLI concerns. The core client itself is stateless.
 */
import { createClient, GatewayClient } from '@sapiom/agent-core';

import { type CliTarget, resolveHost } from './cli-config.js';
import { CliError } from './output.js';
import { readCredential } from './session.js';

export { resolveHost };
export type { CliTarget };

/**
 * Credential precedence: the environment always wins (CI / ephemeral /
 * agents), then the stored session from `sapiom login`. Stateful by default,
 * but every stateful path has a stateless override.
 */
export function resolveApiKey(): string {
  const env = process.env.SAPIOM_API_KEY;
  if (env) return env;

  const stored = readCredential();
  // accessToken from the device flow or a raw API key both work — the backend
  // accepts either via `x-api-key` or `Authorization: Bearer` for `sk_` tokens.
  const token = stored?.accessToken ?? stored?.apiKey;
  if (token) return token;

  throw new CliError({
    code: 'NO_CREDENTIAL',
    message: 'Not authenticated.',
    hint: 'Run: sapiom login  (or set SAPIOM_API_KEY).',
  });
}

/**
 * Build a GatewayClient for a CLI command. Resolves host from env / CLI config /
 * project override; resolves credentials from env or stored session.
 *
 * @param projectHost  Optional host stored in the project's `sapiom.json`.
 * @param flagHost     Optional `--host <url>` flag value.
 * @param flagTarget   Optional `--target local|prod` flag value.
 */
export function makeClient(opts?: {
  projectHost?: string;
  flagHost?: string;
  flagTarget?: CliTarget;
}): GatewayClient {
  const host = resolveHost({
    flagHost: opts?.flagHost,
    flagTarget: opts?.flagTarget,
    projectHost: opts?.projectHost,
  });
  return createClient({ host, apiKey: resolveApiKey() });
}
