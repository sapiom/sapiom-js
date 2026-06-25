/**
 * Resolve a capability's gateway base URL from a single, uniform source.
 *
 * Every capability is hosted at `https://<subdomain>.services.sapiom.ai` in
 * production — only the subdomain differs (fal, git, agents, file-storage, …).
 * Resolution order:
 *
 *   1. an explicit per-capability override (`SAPIOM_<CAP>_URL`) — wins, so any
 *      single capability can still be pointed somewhere bespoke;
 *   2. `SAPIOM_SERVICES_BASE` — ONE knob that re-homes EVERY capability at once
 *      by swapping the host suffix (the subdomain is preserved). Set it to e.g.
 *      `http://services.localhost:3100` for a local stack and every capability
 *      follows — no per-capability env to remember, nothing silently escapes;
 *   3. the production default `https://<subdomain>.services.sapiom.ai`.
 *
 * `SAPIOM_SERVICES_BASE` accepts a full origin (`http://services.localhost:3100`)
 * or a bare `host[:port]` (`services.localhost:3100`, assumed https). Only its
 * scheme + host[:port] are used; any path is ignored.
 */
export function resolveServiceUrl(
  subdomain: string,
  override?: string,
): string {
  if (override) return override;

  const base = process.env.SAPIOM_SERVICES_BASE;
  if (base) {
    const url = new URL(base.includes("://") ? base : `https://${base}`);
    return `${url.protocol}//${subdomain}.${url.host}`;
  }

  return `https://${subdomain}.services.sapiom.ai`;
}
