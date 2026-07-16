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
  return process.env.SAPIOM_AGENTS_URL ?? process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";
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

  return {
    async resolve(definitionId: string): Promise<string | null> {
      if (!apiKey) return null;

      const cached = cache.get(definitionId);
      if (cached !== undefined) return cached;

      try {
        const url = `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definitionId)}`;
        const response = await fetchImpl(url, {
          headers: { "x-sapiom-api-key": apiKey },
        });

        if (!response.ok) return null;

        const body = (await response.json()) as Record<string, unknown>;
        const slug = typeof body.slug === "string" ? body.slug : null;
        if (slug !== null) {
          cache.set(definitionId, slug);
        }
        return slug;
      } catch {
        return null;
      }
    },
  };
}
