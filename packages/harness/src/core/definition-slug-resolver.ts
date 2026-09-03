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

export interface DefinitionSlugResolver {
  resolve(definitionId: string): Promise<string | null>;
  /** Fetch mutable definition metadata. Unlike the stable slug lookup, build
   *  state is deliberately not cached so a completed build becomes visible. */
  resolveMetadata(definitionId: string): Promise<DefinitionMetadata | null>;
}

/**
 * Creates a resolver that fetches `GET /agents/v1/definitions/<id>` with the
 * caller's API key and returns the `slug` field from the response.
 *
 * Safe to call from any request handler: never throws, returns null on any
 * failure (network, 4xx, missing field, unparseable body).
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

  /** Shape the two surfaces agree on, so either response reads the same. */
  const readMetadata = (
    definitionId: string,
    body: Record<string, unknown>,
    warnOnMissingSlug: boolean,
  ): DefinitionMetadata => {
    const slug = typeof body.slug === "string" ? body.slug : null;
    const activeBuildRunId =
      typeof body.activeBuildRunId === "string" ? body.activeBuildRunId : null;
    const activeBuildRunStatus =
      typeof body.activeBuildRunStatus === "string"
        ? body.activeBuildRunStatus
        : null;
    if (slug !== null) {
      cache.set(definitionId, slug);
    } else if (warnOnMissingSlug) {
      warnOnce(definitionId, "response had no string `slug` field");
    }
    return { slug, activeBuildRunId, activeBuildRunStatus };
  };

  /**
   * Core serves the same definition projection at a different path, with a
   * different auth header.
   *
   * The gateway's `agents/v1` surface is the primary and stays so: in prod it is
   * what answers. But it is a SEPARATE service from Core, and a local stack runs
   * Core without it — every `agents/v1` route 404s there while
   * `tools.localhost/health` is happily 200. The visible symptom was ugly and
   * misleading: an agent that is genuinely deployed (`activeBuildRunStatus:
   * "ready"` in Core) shows no runnable build in Studio, so Run stays dark and
   * the agent reads as "never deployed".
   *
   * Returns null (not a throw) on anything unexpected: this is a fallback, and a
   * fallback that throws is worse than no fallback.
   */
  const resolveViaCore = async (
    definitionId: string,
    currentApiKey: string,
  ): Promise<DefinitionMetadata | null> => {
    try {
      const url = `${resolveCoreBaseUrl()}/v1/workflows/definitions/${encodeURIComponent(definitionId)}`;
      // Core authenticates `x-api-key`; it rejects `x-sapiom-api-key` with 401.
      const response = await fetchImpl(url, {
        headers: { "x-api-key": currentApiKey },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      return readMetadata(definitionId, body, false);
    } catch {
      return null;
    }
  };

  const resolveMetadata = async (
    definitionId: string,
  ): Promise<DefinitionMetadata | null> => {
    const currentApiKey = getApiKey();
    // Not signed in is expected, not a failure worth logging. Because this is
    // a getter, a later sign-in is picked up without restarting Studio.
    if (!currentApiKey) return null;

    try {
      const url = `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definitionId)}`;
      const response = await fetchImpl(url, {
        headers: { "x-sapiom-api-key": currentApiKey },
      });

      if (!response.ok) {
        // The gateway may simply not be part of this deployment (local stacks
        // run Core alone). Ask Core before giving up.
        const viaCore = await resolveViaCore(definitionId, currentApiKey);
        if (viaCore) return viaCore;
        warnOnce(definitionId, `HTTP ${response.status}`);
        return null;
      }

      const body = (await response.json()) as Record<string, unknown>;
      return readMetadata(definitionId, body, true);
    } catch (err) {
      const viaCore = await resolveViaCore(definitionId, currentApiKey);
      if (viaCore) return viaCore;
      warnOnce(definitionId, err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  return {
    resolveMetadata,
    async resolve(definitionId: string): Promise<string | null> {
      // Keep the old stable-slug cache contract for existing callers.
      if (!getApiKey()) return null;
      const cached = cache.get(definitionId);
      if (cached !== undefined) return cached;
      return (await resolveMetadata(definitionId))?.slug ?? null;
    },
  };
}
