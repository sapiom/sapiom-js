/**
 * Parsing for the `sapiom://` custom URL scheme — the dashboard's "Open in
 * Studio" deep link. Kept ELECTRON-FREE on purpose: vitest only loads modules
 * that don't import electron, so the parser is unit-testable here the way
 * `single-instance.ts` / `update-policy.ts` are, while the wiring that consumes
 * it lives in `index.ts`.
 */
import type { DeepLinkTarget } from "./ipc.js";

export type { DeepLinkTarget };

/** The scheme we register (electron-builder.yml `protocols:` + setAsDefaultProtocolClient). */
export const DEEP_LINK_SCHEME = "sapiom";

/**
 * Parse `sapiom://agent/<definitionId>` into a target. Tolerates the `agents`
 * alias, a trailing slash, and mixed case in the scheme/host. Returns null for
 * anything that isn't a well-formed agent deep link, so the caller can safely
 * hand it any string (argv token, OS-delivered URL).
 */
export function parseDeepLink(rawUrl: string): DeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // `sapiom://agent/<id>` parses with host="agent", pathname="/<id>". URL only
  // lower-cases the host for special schemes, so normalise it ourselves.
  const host = url.hostname.toLowerCase();
  if (host !== "agent" && host !== "agents") return null;
  const definitionId = decodeURIComponent(url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!definitionId) return null;
  const slug = url.searchParams.get("slug") ?? undefined;
  const org = url.searchParams.get("org") ?? undefined;
  return { definitionId, ...(slug ? { slug } : {}), ...(org ? { org } : {}) };
}

/**
 * Pull the first `sapiom://` argument out of a process argv array — how Windows
 * and Linux deliver a deep link (as an argv token to a second instance, or on
 * cold-start argv). Scans rather than indexing the tail, since flags may follow.
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
