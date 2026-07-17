/**
 * Serve-time enrichment: resolves a deployed agent's `definitionSlug` from the
 * Sapiom Agents API by its `definitionId`. The registry only knows the id (from
 * `sapiom.json`'s `{ "definitionId": "188" }`) — the slug lives server-side,
 * keyed by id.
 *
 * Resolution is cached in-memory (id→slug is stable once deployed; a slug
 * never changes for a given id) so repeat calls across requests are free.
 * Null resolutions are NOT cached: a transient network failure should be
 * retryable without a server restart.
 *
 * Mirrors `@sapiom/tools`'s DEFAULT_BASE_URL for the base URL resolution.
 */

/** Returns the agents API base URL, honouring the same env-var precedence as
 *  @sapiom/tools's DEFAULT_BASE_URL. */
export function resolveAgentsBaseUrl(): string {
  return (
    process.env.SAPIOM_AGENTS_URL ??
    process.env.SAPIOM_TOOLS_BASE ??
    "https://tools.sapiom.ai"
  );
}

export interface DefinitionSlugResolver {
  resolve(definitionId: string): Promise<string | null>;
}

/**
 * Creates a resolver that fetches `GET /agents/v1/definitions/<id>` with the
 * caller's API key and returns the `slug` field from the response.
 *
 * Safe to call from any request handler: never throws, returns null on any
 * failure (network, 4xx, missing field, unparseable body).
 */
export function createDefinitionSlugResolver(opts: {
  apiKey: string | null;
  baseUrl?: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}): DefinitionSlugResolver {
  const { apiKey, baseUrl = resolveAgentsBaseUrl(), fetchImpl = fetch } = opts;
  const cache = new Map<string, string>();
  // Each id's resolution failure is logged at most once. resolve() runs on
  // every /api/state and /api/workflows poll and null results are deliberately
  // not cached (so a transient failure stays retryable), so without this a
  // persistent failure — e.g. the harness signed into an account that can't
  // see this agent — would reprint on every poll. One line per id is enough to
  // diagnose why the snippet panel fell back to the project name.
  const loggedFailures = new Set<string>();
  const warnOnce = (definitionId: string, reason: string): void => {
    if (loggedFailures.has(definitionId)) return;
    loggedFailures.add(definitionId);
    console.error(
      `[harness] could not resolve deployed-agent slug for definitionId=${definitionId} ` +
        `at ${baseUrl} (${reason}); the snippet panel will fall back to the project name — ` +
        `check the harness is signed into the account that owns this agent`,
    );
  };

  return {
    async resolve(definitionId: string): Promise<string | null> {
      // Not signed in: expected (a harness launched without auth), not a
      // failure worth logging — the panel's project-name fallback covers it.
      if (!apiKey) return null;

      const cached = cache.get(definitionId);
      if (cached !== undefined) return cached;

      try {
        const url = `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definitionId)}`;
        const response = await fetchImpl(url, {
          headers: { "x-sapiom-api-key": apiKey },
        });

        if (!response.ok) {
          warnOnce(definitionId, `HTTP ${response.status}`);
          return null;
        }

        const body = (await response.json()) as Record<string, unknown>;
        const slug = typeof body.slug === "string" ? body.slug : null;
        if (slug !== null) {
          cache.set(definitionId, slug);
        } else {
          warnOnce(definitionId, "response had no string `slug` field");
        }
        return slug;
      } catch (err) {
        warnOnce(
          definitionId,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    },
  };
}
