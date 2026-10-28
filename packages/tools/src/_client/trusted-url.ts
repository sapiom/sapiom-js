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

/** `hostname` minus its first label, or `undefined` when that leaves a bare TLD. */
function parentDomain(hostname: string): string | undefined {
  const dot = hostname.indexOf(".");
  if (dot < 0) return undefined;
  const parent = hostname.slice(dot + 1);
  return parent.includes(".") ? parent : undefined;
}

/**
 * Refuse a server-supplied `url` unless its host is the configured base's host, a
 * subdomain of the base host's parent domain (sibling Sapiom services share one),
 * or both are loopback hosts. The error names origins only.
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
  const parent = parentDomain(base.hostname);
  if (parent && target.hostname.endsWith(`.${parent}`)) return;
  if (isLoopbackHostname(base.hostname) && isLoopbackHostname(target.hostname))
    return;
  throw new CredentialChannelError(
    `${label}: ${target.origin} is outside the configured service origin ${base.origin}; refusing to send the credential`,
  );
}
