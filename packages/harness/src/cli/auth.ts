import {
  resolveEnvironment,
  readCredentials,
  writeCredentials,
  performBrowserAuth,
} from "@sapiom/mcp/auth";

export interface HarnessIdentity {
  userId: string;
  tenantId: string;
  organizationName: string;
  apiKey: string;
}

export interface EnsureAuthenticatedOptions {
  /** Prompt a browser login when no cached credential exists. */
  interactive: boolean;
  /** Skip auth entirely (the `--no-auth` flag) — no fs/network access. */
  noAuth?: boolean;
  /** Overrides SAPIOM_ENVIRONMENT for this call. */
  environment?: string;
}

/**
 * Reuses `@sapiom/mcp`'s browser OAuth flow and `~/.sapiom/credentials.json`
 * cache so the harness and the sapiom-dev MCP share one identity. Returns
 * `null` when `noAuth` is set, or when not interactive and no credential is
 * cached yet.
 */
export async function ensureAuthenticated(
  options: EnsureAuthenticatedOptions,
): Promise<HarnessIdentity | null> {
  if (options.noAuth) return null;

  const env = await resolveEnvironment(options.environment ?? process.env.SAPIOM_ENVIRONMENT);

  const existing = await readCredentials(env.name);
  if (existing) {
    return {
      userId: existing.tenantId,
      tenantId: existing.tenantId,
      organizationName: existing.organizationName,
      apiKey: existing.apiKey,
    };
  }

  if (!options.interactive) return null;

  const result = await performBrowserAuth(env.appURL, env.apiURL);
  await writeCredentials(env.name, env.appURL, env.apiURL, {
    apiKey: result.apiKey,
    tenantId: result.tenantId,
    organizationName: result.organizationName,
    apiKeyId: result.apiKeyId,
  });

  return {
    userId: result.tenantId,
    tenantId: result.tenantId,
    organizationName: result.organizationName,
    apiKey: result.apiKey,
  };
}
