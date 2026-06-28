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
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Used when the registry is unreachable. Bump alongside notable SDK releases. */
const FALLBACK = {
  orchestration: "0.1.1",
  tools: "0.1.1",
};

/** The zod major the authoring SDK is built against. */
const ZOD_VERSION = "4.1.12";

export interface ResolvedVersions {
  orchestration: string;
  tools: string;
  zod: string;
}

/**
 * The npm registry to resolve `latest` from, honoring the same config a plain
 * `npm install` would: a scoped `@<scope>:registry` wins over the global
 * `npm_config_registry`, which wins over the public default. This lets the local
 * SDK dev loop (a Verdaccio on :4873) scaffold onto a locally-published patch.
 */
function registryFor(pkg: string): string {
  const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : null;
  const scoped = scope
    ? process.env[`npm_config_${scope}:registry`]
    : undefined;
  const registry =
    scoped || process.env.npm_config_registry || DEFAULT_REGISTRY;
  return registry.replace(/\/+$/, "");
}

async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${registryFor(pkg)}/${pkg.replace("/", "%2F")}/latest`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

export async function resolveVersions(): Promise<ResolvedVersions> {
  const [orchestration, tools] = await Promise.all([
    latestVersion("@sapiom/orchestration"),
    latestVersion("@sapiom/tools"),
  ]);
  return {
    orchestration: orchestration ?? FALLBACK.orchestration,
    tools: tools ?? FALLBACK.tools,
    zod: ZOD_VERSION,
  };
}
