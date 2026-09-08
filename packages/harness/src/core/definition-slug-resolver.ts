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

/**
 * Resolve the CORE surface base URL (`api.<env>`), distinct from the agents
 * host (`tools.<env>`) resolved above. A run lives in the agents env, and any
 * core-surface call for that run must target the MATCHING core env — otherwise
 * a prod run queried against dev 401s. So we DERIVE the core host from the
 * agents host (`tools.<env>` → `api.<env>`) rather than reading
 * `SAPIOM_API_URL`, which in some setups points at a different env than the
 * agents surface. An explicit `SAPIOM_CORE_URL` still wins for full control.
 *
 * Co-located with {@link resolveAgentsBaseUrl} (its sole dependency) so the two
 * env-precedence helpers live together.
 */
export function resolveCoreBaseUrl(): string {
  const override = process.env.SAPIOM_CORE_URL;
  if (override) return override;
  const agents = resolveAgentsBaseUrl();
  try {
    const url = new URL(agents);
    if (url.hostname.startsWith("tools.")) {
      url.hostname = `api.${url.hostname.slice("tools.".length)}`;
      return url.origin;
    }
  } catch {
    // Unparseable agents URL — fall through to the prod default.
  }
  return "https://api.sapiom.ai";
}

export interface DefinitionMetadata {
  slug: string | null;
  activeBuildRunId: string | null;
  activeBuildRunStatus: string | null;
}

export type DefinitionMetadataResult =
  | { status: "available"; metadata: DefinitionMetadata }
  | { status: "not-found" }
  | { status: "unavailable"; lastConfirmedDeployed: boolean | null };

export interface DefinitionSlugResolver {
  resolve(definitionId: string): Promise<string | null>;
  /** Fetch mutable definition metadata. Unlike the stable slug lookup, build
   *  state is deliberately not cached so a completed build becomes visible. */
  resolveMetadata(definitionId: string): Promise<DefinitionMetadataResult>;
  invalidate(): void;
}

/**
 * Creates a resolver that fetches `GET /agents/v1/definitions/<id>` with the
 * caller's API key and returns the `slug` field from the response.
 *
 * Never throws. Failed metadata checks retain only a scoped display bit;
 * they never return cached runnable build fields.
 */
export function createDefinitionSlugResolver(opts: {
  /** A getter keeps enrichment working when the user signs in after boot. */
  apiKey: string | null | (() => string | null);
  baseUrl?: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}): DefinitionSlugResolver {
  const { apiKey, baseUrl = resolveAgentsBaseUrl(), fetchImpl = fetch } = opts;
  const getApiKey = typeof apiKey === "function" ? apiKey : () => apiKey;
  const cache = new Map<string, string>();
  const confirmed = new Map<string, { request: number; deployed: boolean }>();
  const loggedFailures = new Set<string>();
  let key = getApiKey();
  let generation = 0;
  let sequence = 0;
  const invalidate = (): void => {
    generation += 1;
    key = getApiKey();
    cache.clear();
    confirmed.clear();
    loggedFailures.clear();
  };
  const syncKey = (): void => {
    if (key !== getApiKey()) invalidate();
  };
  const warnOnce = (definitionId: string): void => {
    if (loggedFailures.has(definitionId)) return;
    loggedFailures.add(definitionId);
    console.error(
      `[harness] definition metadata unavailable for definitionId=${definitionId}`,
    );
  };

  const resolveMetadata = async (
    definitionId: string,
  ): Promise<DefinitionMetadataResult> => {
    syncKey();
    const scope = generation;
    const request = ++sequence;
    const unavailable = (): DefinitionMetadataResult => ({
      status: "unavailable",
      lastConfirmedDeployed:
        scope === generation
          ? (confirmed.get(definitionId)?.deployed ?? null)
          : null,
    });
    const isCurrent = (): boolean => {
      syncKey();
      return (
        scope === generation &&
        request >= (confirmed.get(definitionId)?.request ?? 0)
      );
    };
    if (!key) return unavailable();
    try {
      const response = await fetchImpl(
        `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definitionId)}`,
        {
          headers: { "x-sapiom-api-key": key },
          signal: AbortSignal.timeout(5_000),
        },
      );
      const body: unknown = await response.json();
      if (!isCurrent()) return unavailable();
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid metadata");
      const fields = body as Record<string, unknown>;
      if (
        response.status === 404 &&
        fields.statusCode === 404 &&
        fields.message === `Agent definition not found: ${definitionId}`
      ) {
        cache.delete(definitionId);
        confirmed.set(definitionId, { request, deployed: false });
        return { status: "not-found" };
      }
      if (!response.ok) throw new Error("Metadata request failed");
      // Slugs are stable and remain usable for legacy slug-only responses.
      const slug = typeof fields.slug === "string" ? fields.slug : null;
      if (slug !== null) cache.set(definitionId, slug);
      const nullableString = (value: unknown): value is string | null =>
        value === null ||
        (typeof value === "string" && value.trim().length > 0);
      const { activeBuildRunId, activeBuildRunStatus } = fields;
      if (
        !Object.prototype.hasOwnProperty.call(fields, "activeBuildRunId") ||
        !Object.prototype.hasOwnProperty.call(fields, "activeBuildRunStatus") ||
        !nullableString(activeBuildRunId) ||
        !nullableString(activeBuildRunStatus) ||
        (activeBuildRunStatus === "ready" && activeBuildRunId === null)
      )
        throw new Error("Invalid build metadata");
      confirmed.set(definitionId, {
        request,
        deployed: activeBuildRunStatus === "ready",
      });
      return {
        status: "available",
        metadata: { slug, activeBuildRunId, activeBuildRunStatus },
      };
    } catch {
      if (isCurrent()) warnOnce(definitionId);
      return unavailable();
    }
  };

  return {
    resolveMetadata,
    invalidate,
    async resolve(definitionId: string): Promise<string | null> {
      syncKey();
      if (!key) return null;
      const scope = generation;
      if (!cache.has(definitionId)) await resolveMetadata(definitionId);
      return scope === generation ? (cache.get(definitionId) ?? null) : null;
    },
  };
}
