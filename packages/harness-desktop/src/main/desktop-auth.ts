import type { HarnessIdentity } from "@sapiom/harness";

export type DesktopAuthenticate = (options: {
  interactive: boolean;
}) => Promise<HarnessIdentity | null>;

export interface DesktopAuthResult {
  identity: HarnessIdentity | null;
  /** Kept for boot diagnostics; local-only startup remains available. */
  error: unknown | null;
}

/**
 * Resolve the desktop account without making cloud authentication a boot gate.
 *
 * A cached credential is silent. A normal clean launch tries browser auth once;
 * cancelling, timing out, or failing that flow leaves the local Studio usable so
 * the account menu can retry later. Smoke mode never opens a browser.
 */
export async function resolveDesktopIdentity(options: {
  authenticate: DesktopAuthenticate;
  smoke: boolean;
  beforeInteractive?: () => void;
}): Promise<DesktopAuthResult> {
  let cached: HarnessIdentity | null;
  try {
    cached = await options.authenticate({ interactive: false });
  } catch (error) {
    return { identity: null, error };
  }

  if (cached || options.smoke) return { identity: cached, error: null };

  options.beforeInteractive?.();
  try {
    return {
      identity: await options.authenticate({ interactive: true }),
      error: null,
    };
  } catch (error) {
    return { identity: null, error };
  }
}
