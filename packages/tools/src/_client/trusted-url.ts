/**
 * URLs the SDK receives from a Sapiom service and then calls with the tenant
 * credential (grant links, media poll URLs). Each must stay inside the deployment
 * the caller configured, or the credential would follow whatever host a response
 * names.
 */
import {
  CredentialChannelError,
  isLoopbackHostname,
} from "@sapiom/analytics-core/credential";

/**
 * Domains Sapiom owns outright. Sibling trust stops here: under any other domain
 * (a shared host such as `workers.dev`, or a public suffix such as `co.uk`) a
 * sibling host can belong to someone else.
 */
const SAPIOM_DOMAINS = ["sapiom.ai", "sapiom.dev"];

function isUnderSapiomDomain(hostname: string): boolean {
  return SAPIOM_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

/** `hostname` minus its first label, when that is still inside a Sapiom domain. */
function sapiomParentDomain(hostname: string): string | undefined {
  const dot = hostname.indexOf(".");
  if (dot < 0) return undefined;
  const parent = hostname.slice(dot + 1);
  return isUnderSapiomDomain(parent) ? parent : undefined;
}

/**
 * Refuse a server-supplied `url` unless its host is the configured base's host, a
 * subdomain of the base host's parent domain when that parent is a Sapiom domain
 * (sibling Sapiom services share one), or both are loopback hosts. The error
 * names origins only.
 */
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
