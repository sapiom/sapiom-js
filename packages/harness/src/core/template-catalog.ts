/**
 * template-catalog — the Studio's template gallery, read from the Sapiom CORE
 * surface so it can never disagree with the dashboard's Template library.
 *
 * WHY this replaced a hardcoded list: the Studio used to ship a pinned copy of
 * two registry entries (`web/src/lib/templates.ts`, pinned at harness 0.1.4 /
 * f0e3406) because — as that module's header said — "no listing API, MCP tool,
 * or CLI command exposes the gallery to any client today". That is no longer
 * true: core serves `GET /v1/workflows/templates` and
 * `GET /v1/workflows/templates/:id`, which is exactly what the dashboard's
 * gallery renders. Reading the same endpoint is what keeps the two surfaces from
 * drifting; re-deriving the list from `registry.json` would just recreate the
 * drift with extra steps (core also merges each example's `template.json` and
 * derives the complexity band from the declared shape).
 *
 * Two non-obvious contract details, both verified against a local backend:
 *
 *  - **The core surface authenticates with `Authorization: Bearer`, NOT the
 *    `x-sapiom-api-key` header the AGENTS surface takes.** The same key sent as
 *    `x-sapiom-api-key` to `/v1/workflows/templates` returns 401. Don't copy the
 *    header from `run-state.ts` / `definition-slug-resolver.ts` — those talk to
 *    `tools.*`, this talks to `api.*`.
 *  - **The path is prefixed `/v1`** (the backend's `GLOBAL_API_PREFIX`); a bare
 *    `/workflows/templates` 404s.
 *
 * The key stays server-side and is never forwarded to the browser (same rule as
 * the runs router). A 401/403 triggers exactly one credential refresh + retry,
 * mirroring `run-state.ts`, so a rotated key recovers in place.
 */

import type {
  TemplateComplexity,
  TemplateDetailView,
  TemplateListResponse,
  TemplateStepView,
  TemplateSummary,
  TemplateTransitionView,
} from "../shared/types.js";
import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";
import { classifyStepKind } from "./canvas-graph.js";
import { resolveCoreBaseUrl } from "./definition-slug-resolver.js";

/** Upstream statuses meaning "the key was rejected" — worth one refresh + retry
 *  before giving up. Mirrors run-state.ts's `isAuthRejection`. */
function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** How long a successful list/detail response is reused. The registry is read by
 *  core from a pinned ref and changes on the order of releases, so a short TTL
 *  removes the per-open round-trip without pinning a stale gallery for a session
 *  that stays open for hours. */
const CACHE_TTL_MS = 5 * 60_000;

export interface TemplateCatalog {
  /** The gallery list. Never throws: falls back to `source: "fallback"` with an
   *  empty list when signed out or core is unreachable, so the dialog can say
   *  what happened instead of rendering silence. */
  list(): Promise<TemplateListResponse>;
  /** One template's detail, or null when the id is unknown / unreachable. */
  detail(id: string): Promise<TemplateDetailView | null>;
}

/** Unknown-shaped JSON from upstream, narrowed field by field below. */
type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** A basis count. Absent or nonsense reads as 0 — the basis only ever explains a
 *  band, so a missing count should drop out of the explanation, not sink it. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Narrow a complexity band, or null when the payload did not carry a usable one.
 *
 * Core types this field required and can compute it for every template, so
 * against a current backend the null branch is dead. It is not dead against
 * every backend: this is a published package that can be pointed at a stack
 * predating the field (see `TemplateSummary.complexity`). Returning null lets one
 * card render an em dash; dereferencing an absent band would throw inside the row
 * renderer and lose the whole gallery.
 *
 * `label` is the gate because it is what the card actually renders — a band whose
 * label we cannot read is not one we can show, whatever else came with it.
 */
function toComplexity(value: unknown): TemplateComplexity | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Json;
  const label = nullableStr(raw.label);
  if (!label) return null;
  const basis =
    typeof raw.basis === "object" && raw.basis !== null
      ? (raw.basis as Json)
      : {};
  return {
    label,
    score: count(raw.score),
    basis: {
      llmSteps: count(basis.llmSteps),
      chainedLlmSteps: count(basis.chainedLlmSteps),
      mediaCapabilities: count(basis.mediaCapabilities),
      capabilityCount: count(basis.capabilityCount),
      stepCount: count(basis.stepCount),
      maxFanOut: count(basis.maxFanOut),
    },
  };
}

/**
 * Narrow one summary. Defensive rather than trusting: the taxonomy and manifest
 * are owned upstream in a public repo, so a template with a field we don't know
 * about must still render as a card instead of throwing the whole list away.
 */
function toSummary(raw: Json): TemplateSummary {
  return {
    id: str(raw.id),
    name: str(raw.name) || str(raw.id),
    description: str(raw.description),
    tags: strArray(raw.tags),
    category: nullableStr(raw.category),
    cadence: nullableStr(raw.cadence),
    stepCount: typeof raw.stepCount === "number" ? raw.stepCount : 0,
    capabilities: strArray(raw.capabilities),
    complexity: toComplexity(raw.complexity),
  };
}

/**
 * Core relays the ENGINE's graph projection (`DefinitionStepDto` /
 * `DefinitionTransitionDto`), whose shape is not the registry's:
 *
 *  - a step is `{ id, stepName, ordinal, kind, capabilityId }` — `stepName`, a
 *    SINGULAR nullable `capabilityId`, and **no `terminal` flag**;
 *  - an edge is `{ fromStepDefinitionId, toStepDefinitionId, kind, signal }`,
 *    referencing steps by their namespaced `id` (`<templateId>::<stepName>`),
 *    not by name, and `toStepDefinitionId` is **null** for a `terminate`/`fail`
 *    sink.
 *
 * So terminality is an EDGE property here, and ids must be resolved to names
 * before the view can use them. Getting this wrong renders a step list with no
 * connectors and nothing marked as an exit.
 */
function toGraph(
  rawSteps: unknown,
  rawTransitions: unknown,
): {
  steps: TemplateStepView[];
  transitions: TemplateTransitionView[];
} {
  const steps = Array.isArray(rawSteps)
    ? rawSteps.filter((s): s is Json => typeof s === "object" && s !== null)
    : [];
  const edges = Array.isArray(rawTransitions)
    ? rawTransitions.filter(
        (t): t is Json => typeof t === "object" && t !== null,
      )
    : [];

  // `<templateId>::<stepName>` → `stepName`. Fall back to `name` so a future
  // registry-shaped payload still resolves.
  const nameOf = new Map<string, string>();
  for (const step of steps) {
    const name = str(step.stepName) || str(step.name);
    if (step.id !== undefined) nameOf.set(str(step.id), name);
    if (name) nameOf.set(name, name);
  }
  const resolve = (ref: unknown): string => {
    const key = str(ref);
    return nameOf.get(key) ?? key;
  };

  // Group each step's outgoing transitions so the shared classifier sees exactly
  // what it sees for a local manifest. All FOUR kinds matter — `terminate` and
  // `fail` are sinks with a null target (never drawn edges, but they decide the
  // node's kind), and a step that can `continue` AND terminate is a mid-flow
  // step, not an exit.
  const outgoing = new Map<
    string,
    Array<{ kind: string; signal: string | null }>
  >();
  for (const edge of edges) {
    const from = resolve(edge.fromStepDefinitionId ?? edge.from);
    const list = outgoing.get(from) ?? [];
    list.push({ kind: str(edge.kind), signal: nullableStr(edge.signal) });
    outgoing.set(from, list);
  }

  // Entry is the lowest `ordinal` — core documents that on DefinitionStepDto.
  const entry =
    steps
      .map((step) => ({
        name: str(step.stepName) || str(step.name),
        ordinal:
          typeof step.ordinal === "number"
            ? step.ordinal
            : Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.ordinal - b.ordinal)[0]?.name ?? "";

  const DRAWN_KINDS = new Set(["continue", "pause"]);

  return {
    steps: steps.map((step) => {
      const name = str(step.stepName) || str(step.name);
      const capability = nullableStr(step.capabilityId);
      const { kind, sublabel } = classifyStepKind({
        name,
        entry,
        transitions: outgoing.get(name) ?? [],
      });
      return {
        name,
        description: nullableStr(step.description),
        // Singular `capabilityId` upstream; the view carries a list because a
        // future step could bind more than one, and the older registry shape did.
        capabilities: capability ? [capability] : strArray(step.capabilities),
        kind,
        sublabel,
      };
    }),
    // Only `continue` and `pause` have a target, so only they become edges.
    transitions: edges
      .filter((edge) => DRAWN_KINDS.has(str(edge.kind)))
      .map((edge) => ({
        from: resolve(edge.fromStepDefinitionId ?? edge.from),
        to: resolve(edge.toStepDefinitionId ?? edge.to),
        // A pause edge names the signal it waits for; that IS its label. Nothing
        // else in the DTO is a label, so nothing else is invented.
        label: nullableStr(edge.signal),
        kind:
          str(edge.kind) === "pause"
            ? ("pause" as const)
            : ("continue" as const),
      }))
      .filter((edge) => edge.from !== "" && edge.to !== ""),
  };
}

/**
 * The rich fields live under `manifest` in core's detail DTO (the co-located
 * `template.json`), while the graph is expanded at the top level. Read both
 * shapes so the detail pane works whether or not a template ships a manifest.
 */
function toDetail(raw: Json): TemplateDetailView {
  const manifest: Json =
    typeof raw.manifest === "object" && raw.manifest !== null
      ? (raw.manifest as Json)
      : {};
  const author: Json | null =
    typeof manifest.author === "object" && manifest.author !== null
      ? (manifest.author as Json)
      : null;
  const graph = toGraph(raw.steps, raw.transitions);
  return {
    ...toSummary(raw),
    whatItDoes: nullableStr(raw.whatItDoes ?? manifest.whatItDoes),
    sourcePath: nullableStr(raw.sourcePath),
    steps: graph.steps,
    transitions: graph.transitions,
    author: author
      ? { name: str(author.name), url: nullableStr(author.url) }
      : null,
    useCases: strArray(manifest.useCases),
    notes: nullableStr(manifest.notes),
    examples: Array.isArray(manifest.examples)
      ? manifest.examples
          .filter((e): e is Json => typeof e === "object" && e !== null)
          .map((example) => ({
            title: nullableStr(example.title),
            input: example.input ?? null,
            output: example.output ?? null,
          }))
      : [],
    requiredSecrets: Array.isArray(manifest.requiredSecrets)
      ? manifest.requiredSecrets
          .filter((s): s is Json => typeof s === "object" && s !== null)
          .map((secret) => ({
            key: str(secret.key),
            label: str(secret.label) || str(secret.key),
            description: nullableStr(secret.description),
          }))
      : [],
  };
}

export function createTemplateCatalog(opts: {
  /** Accepts a provider (preferred — enables refresh-on-401) or a bare key. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam, mirroring the resolver suite. */
  fetchImpl?: typeof fetch;
}): TemplateCatalog {
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const baseUrl = opts.baseUrl ?? resolveCoreBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;

  let listCache: { at: number; value: TemplateListResponse } | null = null;
  const detailCache = new Map<
    string,
    { at: number; value: TemplateDetailView }
  >();
  // One line per distinct failure reason, not per poll — the dialog may reopen
  // repeatedly and a persistent misconfiguration shouldn't flood the log.
  const logged = new Set<string>();
  const warnOnce = (reason: string): void => {
    if (logged.has(reason)) return;
    logged.add(reason);
    console.error(
      `[harness] template gallery unavailable from ${baseUrl} (${reason}); ` +
        "showing the bundled starters only — check the harness is signed in " +
        "and SAPIOM_CORE_URL points at a reachable Sapiom API",
    );
  };

  /**
   * GET `path` from the core surface with the held key, refreshing + retrying
   * once on an auth rejection. Returns the parsed body, or null on any failure.
   */
  const getJson = async (path: string): Promise<unknown | null> => {
    let apiKey = provider.getKey();
    if (!apiKey) return null;

    const attempt = async (key: string): Promise<Response | null> => {
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          // Core (`api.*`) takes a Bearer token; the agents surface (`tools.*`)
          // takes `x-sapiom-api-key`. Sending the latter here 401s — verified.
          headers: { Authorization: `Bearer ${key}` },
        });
      } catch (err) {
        warnOnce(err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    let response = await attempt(apiKey);
    if (!response) return null;

    if (isAuthRejection(response.status)) {
      const refreshed = await provider.refresh();
      if (refreshed && refreshed !== apiKey) {
        apiKey = refreshed;
        response = await attempt(refreshed);
        if (!response) return null;
      }
    }

    if (!response.ok) {
      warnOnce(`HTTP ${response.status}`);
      return null;
    }
    try {
      return await response.json();
    } catch {
      warnOnce("response body was not JSON");
      return null;
    }
  };

  return {
    async list(): Promise<TemplateListResponse> {
      const fresh = listCache && Date.now() - listCache.at < CACHE_TTL_MS;
      if (fresh && listCache) return listCache.value;

      // Signed out is an expected state (a harness launched without auth), not a
      // fault — distinguish it so the dialog can offer sign-in rather than
      // implying the gallery is broken.
      if (!provider.getKey()) {
        return { templates: [], source: "fallback", reason: "signed-out" };
      }

      const body = await getJson("/v1/workflows/templates");
      if (!Array.isArray(body)) {
        return { templates: [], source: "fallback", reason: "unreachable" };
      }
      const templates = body
        .filter((t): t is Json => typeof t === "object" && t !== null)
        .map(toSummary)
        .filter((t) => t.id !== "");
      const value: TemplateListResponse = { templates, source: "live" };
      listCache = { at: Date.now(), value };
      return value;
    },

    async detail(id: string): Promise<TemplateDetailView | null> {
      const cached = detailCache.get(id);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

      const body = await getJson(
        `/v1/workflows/templates/${encodeURIComponent(id)}`,
      );
      if (typeof body !== "object" || body === null) return null;
      const value = toDetail(body as Json);
      if (value.id === "") return null;
      detailCache.set(id, { at: Date.now(), value });
      return value;
    },
  };
}
