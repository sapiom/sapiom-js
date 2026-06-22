/**
 * Resolve the dependency versions stamped into a scaffolded project.
 *
 * We fetch the *current* published version of each Sapiom package from npm at
 * scaffold time (with a pinned fallback if offline / the registry is slow), so a
 * stale copy of this CLI still stamps up-to-date pins. This is the forward-compat
 * hook: the CLI never needs republishing just to track new SDK releases.
 *
 * Pins are stamped EXACT (no caret) so a project's local typecheck matches what
 * the build injects — see the SDK version drift-check in the build pipeline.
 */
const REGISTRY = 'https://registry.npmjs.org';

/** Used when the registry is unreachable. Bump alongside notable SDK releases. */
const FALLBACK = {
  orchestration: '0.1.1',
  tools: '0.1.1',
};

/** Pinned to the zod 3.25.x line the SDK's `zod/v4` subpath requires. */
const ZOD_VERSION = '3.25.76';

export interface ResolvedVersions {
  orchestration: string;
  tools: string;
  zod: string;
}

async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`${REGISTRY}/${pkg.replace('/', '%2F')}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

export async function resolveVersions(): Promise<ResolvedVersions> {
  const [orchestration, tools] = await Promise.all([
    latestVersion('@sapiom/orchestration'),
    latestVersion('@sapiom/tools'),
  ]);
  return {
    orchestration: orchestration ?? FALLBACK.orchestration,
    tools: tools ?? FALLBACK.tools,
    zod: ZOD_VERSION,
  };
}
