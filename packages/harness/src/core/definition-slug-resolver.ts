/**
 * Serve-time enrichment of linked agents (slug + build status) from the
 * Agents API. `listVisible()`: one tenant-scoped list per pass; the engine
 * 404s foreign ids, so callers intersect instead of asking per id.
 * `resolveMetadata()`: per-id detail, for ids the list proved visible.
 * Slugs are cached (stable); failed lookups retain only a display bit.
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
type ConfirmedMetadata = Exclude<
  DefinitionMetadataResult,
  { status: "unavailable" }
>;

/** One list pass: the account's visible definitions, or the retained display
 *  bits when the list could not be read (signed out, outage, stale scope). */
export type DefinitionListResult =
  | { status: "available"; visible: ReadonlyMap<string, DefinitionMetadata> }
  | {
      status: "unavailable";
      lastConfirmedDeployed: ReadonlyMap<string, boolean>;
    };

export interface DefinitionSlugResolver {
  resolve(definitionId: string): Promise<string | null>;
  /** Fetch mutable definition metadata. Unlike the stable slug lookup, build
   *  state is deliberately not cached so a completed build becomes visible.
   *  Ask only for ids {@link listVisible} proved visible: anything else 404s. */
  resolveMetadata(definitionId: string): Promise<DefinitionMetadataResult>;
  /** One tenant-scoped list request. The engine returns the account's full
   *  set, unpaginated: absence = not visible. Single-flight per api key; a
   *  key change during the request yields "unavailable". */
  listVisible(): Promise<DefinitionListResult>;
  invalidate(): void;
}

/**
 * Resolver over `GET /agents/v1/definitions` (list) and `/definitions/<id>`
 * (detail). Never throws. Failed checks retain only a scoped display bit;
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
  const confirmed = new Map<
    string,
    {
      request: number;
      deployed: boolean | null;
      pending: number;
      result?: ConfirmedMetadata;
    }
  >();
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
  const isCurrent = (scope: number): boolean => {
    syncKey();
    return scope === generation;
  };
  const warnOnce = (definitionId: string, reason: string): void => {
    // Throttle repeated polls without hiding a changed failure reason.
    const diagnostic = `${definitionId}:${reason}`;
    if (loggedFailures.has(diagnostic)) return;
    loggedFailures.add(diagnostic);
    console.error(
      `[harness] definition metadata unavailable for definitionId=${definitionId}: ${reason}`,
    );
  };
  const warnListOnce = (reason: string): void => {
    const diagnostic = `list:${reason}`;
    if (loggedFailures.has(diagnostic)) return;
    loggedFailures.add(diagnostic);
    console.error(`[harness] definition list unavailable: ${reason}`);
  };
  const remember = (definitionId: string, deployed: boolean): void => {
    const entry = confirmed.get(definitionId) ?? {
      request: 0,
      deployed: null,
      pending: 0,
    };
    entry.deployed = deployed;
    confirmed.set(definitionId, entry);
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
    if (!key) return unavailable();
    const latest = confirmed.get(definitionId) ?? {
      request: 0,
      deployed: null,
      pending: 0,
    };
    confirmed.set(definitionId, latest);
    latest.pending += 1;
    const confirm = (result: ConfirmedMetadata): DefinitionMetadataResult => {
      if (request < latest.request) return latest.result ?? unavailable();
      latest.request = request;
      latest.deployed =
        result.status === "available" &&
        result.metadata.activeBuildRunStatus === "ready";
      latest.result = result;
      if (result.status === "not-found") cache.delete(definitionId);
      return result;
    };
    let failure = "network error or timeout";
    try {
      const response = await fetchImpl(
        `${baseUrl}/agents/v1/definitions/${encodeURIComponent(definitionId)}`,
        {
          headers: { "x-sapiom-api-key": key },
          signal: AbortSignal.timeout(5_000),
        },
      );
      failure = response.ok ? "invalid response" : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403)
        failure +=
          "; check Studio is signed into the account that owns this agent";
      const body: unknown = await response.json();
      if (!isCurrent(scope)) return unavailable();
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid metadata");
      const fields = body as Record<string, unknown>;
      // Nest route misses also return JSON statusCode: 404 / code: not_found.
      // Only the definition endpoint's scoped not-found response proves absence.
      if (
        response.status === 404 &&
        fields.statusCode === 404 &&
        fields.message === `Agent definition not found: ${definitionId}`
      )
        return confirm({ status: "not-found" });
      if (!response.ok) throw new Error("Metadata request failed");
      // Slugs are stable and remain usable for legacy slug-only responses.
      const slug = typeof fields.slug === "string" ? fields.slug : null;
      if (slug !== null && request >= latest.request)
        cache.set(definitionId, slug);
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
      return confirm({
        status: "available",
        metadata: { slug, activeBuildRunId, activeBuildRunStatus },
      });
    } catch {
      if (isCurrent(scope)) warnOnce(definitionId, failure);
      return unavailable();
    } finally {
      // Share validated results only across overlapping successful reads. Every
      // refresh fetches anew; failures retain only the display bit, never builds.
      if (--latest.pending === 0) delete latest.result;
    }
  };

  const fetchList = async (
    scope: number,
    currentKey: string,
  ): Promise<DefinitionListResult> => {
    const listUnavailable = (): DefinitionListResult => {
      const bits = new Map<string, boolean>();
      if (scope === generation)
        for (const [definitionId, entry] of confirmed)
          if (entry.deployed !== null) bits.set(definitionId, entry.deployed);
      return { status: "unavailable", lastConfirmedDeployed: bits };
    };
    let failure = "network error or timeout";
    try {
      const response = await fetchImpl(`${baseUrl}/agents/v1/definitions`, {
        headers: { "x-sapiom-api-key": currentKey },
        signal: AbortSignal.timeout(5_000),
      });
      failure = response.ok ? "invalid response" : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403)
        failure +=
          "; check Studio is signed into the account that owns these agents";
      const body: unknown = await response.json();
      if (!isCurrent(scope)) return listUnavailable();
      if (!response.ok || !Array.isArray(body)) throw new Error("Invalid list");
      const visible = new Map<string, DefinitionMetadata>();
      for (const row of body) {
        if (row === null || typeof row !== "object") continue;
        const fields = row as Record<string, unknown>;
        // bigint id serializes as a string; tolerate a number.
        if (typeof fields.id !== "string" && typeof fields.id !== "number")
          continue;
        const definitionId = String(fields.id);
        const metadata: DefinitionMetadata = {
          slug: typeof fields.slug === "string" ? fields.slug : null,
          activeBuildRunId:
            typeof fields.activeBuildRunId === "string"
              ? fields.activeBuildRunId
              : null,
          activeBuildRunStatus:
            typeof fields.activeBuildRunStatus === "string"
              ? fields.activeBuildRunStatus
              : null,
        };
        visible.set(definitionId, metadata);
        if (metadata.slug !== null) cache.set(definitionId, metadata.slug);
        remember(definitionId, metadata.activeBuildRunStatus === "ready");
      }
      // A definition this account confirmed before and cannot see now is not
      // deployed for it.
      for (const [definitionId, entry] of confirmed)
        if (!visible.has(definitionId)) {
          entry.deployed = false;
          cache.delete(definitionId);
        }
      return { status: "available", visible };
    } catch {
      if (isCurrent(scope)) warnListOnce(failure);
      return listUnavailable();
    }
  };

  // Single-flight per scope (the scope changes with the api key): concurrent
  // polls share one request, a key change never does. Nothing kept once
  // settled (build status is mutable).
  let inflightList: {
    scope: number;
    promise: Promise<DefinitionListResult>;
  } | null = null;
  const listVisible = async (): Promise<DefinitionListResult> => {
    syncKey();
    const scope = generation;
    if (!key)
      return { status: "unavailable", lastConfirmedDeployed: new Map() };
    if (inflightList?.scope === scope) return inflightList.promise;
    const promise = fetchList(scope, key).finally(() => {
      if (inflightList?.promise === promise) inflightList = null;
    });
    inflightList = { scope, promise };
    return promise;
  };

  return {
    resolveMetadata,
    listVisible,
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
