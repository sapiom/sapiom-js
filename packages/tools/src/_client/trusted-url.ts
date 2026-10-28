/** Follow-up calls to server-supplied URLs carry the tenant credential, so those URLs
 * need a trust boundary. */
import {
  CredentialChannelError,
  isLoopbackHostname,
} from "@sapiom/analytics-core/credential";

/** Sibling trust stops at Sapiom-owned domains: under a shared host or a public
 * suffix, a sibling can belong to another tenant. */
const SAPIOM_DOMAINS = ["sapiom.ai", "sapiom.dev"];

function isUnderSapiomDomain(hostname: string): boolean {
  return SAPIOM_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function sapiomParentDomain(hostname: string): string | undefined {
  const dot = hostname.indexOf(".");
  if (dot < 0) return undefined;
  const parent = hostname.slice(dot + 1);
  return isUnderSapiomDomain(parent) ? parent : undefined;
}

/** A credential-bearing follow-up call must stay inside the configured deployment;
 * the error names origins only, since a path or query can hold a secret. */
export function assertTrustedServiceUrl(
  url: string,
  configuredBase: string,
  label: string,
): void {
  const base = new URL(configuredBase);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CredentialChannelError(
      `${label}: the service returned a URL that does not parse; refusing to send the credential`,
    );
  }
  if (target.host === base.host) return;
  const parent = sapiomParentDomain(base.hostname);
  if (parent && target.hostname.endsWith(`.${parent}`)) return;
  if (isLoopbackHostname(base.hostname) && isLoopbackHostname(target.hostname))
    return;
  throw new CredentialChannelError(
    `${label}: ${target.origin} is outside the configured service origin ${base.origin}; refusing to send the credential`,
  );
}
