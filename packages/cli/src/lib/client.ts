/**
 * CLI-level client factory. Resolves host and API key from the environment and
 * stored session, then delegates to @sapiom/orchestration-core's GatewayClient.
 *
 * Auth resolution stays here (in the CLI) because it reads process.env and the
 * local session store — both are CLI concerns. The core client itself is stateless.
 */
import { createClient, DEFAULT_WORKFLOWS_HOST, GatewayClient } from '@sapiom/orchestration-core';

import { CliError } from './output.js';
import { readCredential } from './session.js';

/** Host precedence: explicit env override → linked project's host → default. */
export function resolveHost(configHost?: string): string {
  return process.env.SAPIOM_WORKFLOWS_HOST ?? configHost ?? DEFAULT_WORKFLOWS_HOST;
}

/**
 * Credential precedence: the environment always wins (CI / ephemeral /
 * agents), then the stored session from `sapiom login`. Stateful by default,
 * but every stateful path has a stateless override.
 */
function resolveApiKey(): string {
  const env = process.env.SAPIOM_API_KEY;
  if (env) return env;

  const stored = readCredential();
  const token = stored?.accessToken ?? stored?.apiKey;
  if (token) return token;

  throw new CliError({
    code: 'NO_CREDENTIAL',
    message: 'Not authenticated.',
    hint: 'Run: sapiom login  (or set SAPIOM_API_KEY).',
  });
}

/**
 * Build a GatewayClient for a CLI command. Reads host and API key from the
 * environment / session; callers pass the optional project host override.
 */
export function makeClient(configHost?: string): GatewayClient {
  return createClient({ host: resolveHost(configHost), apiKey: resolveApiKey() });
}
