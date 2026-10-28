/**
 * Auth resolution lives in the CLI because the environment and the session store
 * are CLI concerns; the core client stays stateless.
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

export function makeClient(opts?: { flagHost?: string; flagTarget?: CliTarget }): GatewayClient {
  const host = resolveHost({
    flagHost: opts?.flagHost,
    flagTarget: opts?.flagTarget,
  });
  return createClient({ host, apiKey: resolveApiKey() });
}
