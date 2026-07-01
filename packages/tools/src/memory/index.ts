/**
 * Tenant-scoped long-term memory on the Sapiom memory gateway.
 *
 *   import { memory } from "@sapiom/tools";                 // ambient auth
 *   const { id } = await memory.append({ content: "User prefers dark mode.", scope: "user" });
 *   const { results } = await memory.recall({ query: "ui preferences", topK: 5 });
 *   const record = await memory.get(id);
 *   await memory.forget(id);
 *
 * Or via an explicit client: `createClient({ apiKey }).memory.append(...)`.
 *
 * The gateway speaks camelCase JSON, so this client keeps request and response
 * objects 1:1 with the wire contract.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, MemoryHttpError } from "./errors.js";

export { MemoryHttpError };

/**
 * Memory service ORIGIN. Resolves like every other @sapiom/tools capability: an
 * explicit `SAPIOM_MEMORY_URL` override wins, else the `SAPIOM_SERVICES_BASE` knob
 * re-homes it (subdomain preserved), else the production
 * `https://memory.services.sapiom.ai`. This is the bare origin; the `/v1/memory`
 * path prefix is appended per-method below (a local override is just the gateway
 * origin, e.g. `http://memory.services.localhost:3100`).
 */
const DEFAULT_BASE_URL = resolveServiceUrl(
  "memory",
  process.env.SAPIOM_MEMORY_URL,
);

// ----- SDK-facing types (identical to the wire; camelCase end to end) -----

/** Storage backend selector. Omit for the v0 default `"neon-pgvector"`. */
export const MEMORY_BACKENDS = ["neon-pgvector", "upstash-vector"] as const;
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];

/** Embedding model selector. Omit for the default OpenRouter text-embedding-3-small embedder. */
export interface MemoryEmbedder {
  /**
   * Embedding provider. The gateway is authoritative for provider support and
   * returns 400 for unknown providers; v0 currently supports `"openrouter"`.
   */
  provider: string;
  /**
   * Embedding model. A model is part of the store identity, so a write and all
   * later reads must use the same model. The gateway is authoritative for model
   * support and returns 400 for unknown models.
   */
  model: string;
}

/**
 * Optional store selector. Omit for the default Neon store.
 *
 * A memory is only visible from the store it was written to. If you set any of
 * these fields on append, pass the same `store` to recall/get/forget/sweep.
 */
export interface MemoryStore {
  /**
   * Storage backend. Default: `"neon-pgvector"`. `"upstash-vector"` is experimental
   * and does not support keyword recall or sweep.
   */
  backend?: MemoryBackend;
  /**
   * Embedding model. Default: OpenRouter `"openai/text-embedding-3-small"`.
   */
  embedder?: MemoryEmbedder;
  /**
   * Physical isolation namespace. Use to separate projects/tenants under one
   * owner. 1-100 chars, `[a-zA-Z0-9_-]`.
   */
  namespace?: string;
}

export interface AppendInput {
  /**
   * Text to store as a memory (1–32,000 chars). Must not contain secrets — the
   * gateway runs an admission gate and rejects API keys / tokens / passwords with
   * a 400 (`error: "SecretDetected"`, `decision: "REJECTED"`) before anything is
   * embedded or stored.
   */
  content: string;
  /**
   * Scope label grouping related memories (e.g. "session", "user", "project").
   * Alphanumeric plus hyphens/underscores, 1–100 chars. Defaults to "default".
   */
  scope?: string;
  /**
   * Arbitrary JSON stored alongside the memory and returned on read. Opaque to
   * ranking (not embedded), but usable as a hard `filter` on recall. Max 10 KB when
   * JSON-serialized.
   */
  metadata?: Record<string, unknown>;
  /**
   * Event-time this memory is *about* (ISO-8601), distinct from `createdAt` (the
   * server ingestion time). Drives temporal recall weighting. When omitted, the
   * gateway stores `null` and temporal recall falls back to `createdAt`.
   */
  occurredAt?: string;
  /** Optional store selector. Omit for the default store. See {@link MemoryStore}. */
  store?: MemoryStore;
}

export interface AppendResult {
  /**
   * UUID of the memory. For `decision: "ADDED"` this is the newly created record;
   * for `decision: "NOOP"` it is the existing memory that was echoed (nothing was
   * written).
   */
  id: string;
  /** The stored content, echoed back. */
  content: string;
  /** The resolved scope label ("default" when you omitted it). */
  scope: string;
  /**
   * What the gateway did, made legible (never a silent write):
   * - `"ADDED"` — a new memory was written to the append-log.
   * - `"NOOP"`  — byte-identical content or a near-exact semantic duplicate in the
   *   same owner + scope; the existing memory is echoed and nothing is written.
   *
   * A secret caught by the admission gate is *not* a decision here — it surfaces as
   * a 400 {@link MemoryHttpError} whose body carries `decision: "REJECTED"`.
   */
  decision: "ADDED" | "NOOP";
  /** ISO-8601 timestamp when the memory was created (server ingestion time). */
  createdAt: string;
  /**
   * ISO-8601 event-time this memory is *about*, or `null` when none was supplied on
   * append (the gateway does not backfill it with `createdAt`).
   */
  occurredAt: string | null;
  /** The stored metadata (`{}` when none was provided). */
  metadata: Record<string, unknown>;
}

/**
 * Retrieval strategy for {@link recall}:
 * - `"cosine"`  — dense vector similarity (default; supported on every backend).
 * - `"keyword"` — full-text / BM25 ranking. Neon-only; requesting it on a backend
 *   that doesn't support it is a 400 {@link MemoryHttpError} (never degraded).
 */
export type RetrievalStrategy = "cosine" | "keyword";

/** Time-decay weighting for {@link RecallInput.weight}. Optional; omit for pure relevance. */
export interface TemporalWeight {
  /**
   * ISO-8601 anchor the decay is measured from. Defaults to "now" at recall time.
   * (A Unix-epoch integer is not accepted — pass an ISO-8601 string.)
   */
  center?: string;
  /**
   * Half-life in days (1–365, default 30): a memory whose `occurredAt` is this far
   * from `center` keeps half its relevance. Smaller = sharper recency preference.
   */
  halfLifeDays?: number;
}

/** Optional scoring weights for {@link recall}. Extensible; only `temporal` is supported today. */
export interface RecallWeight {
  /** Multiplicative time-decay applied to each match's base similarity. */
  temporal?: TemporalWeight;
}

export interface RecallInput {
  /** Natural-language search text (1–4,096 chars). Embedded and compared against stored memories. */
  query: string;
  /** Restrict the search to this scope label. Omit to search every scope for your owner. */
  scope?: string;
  /** Maximum number of results to return (1–50). Defaults to 5. */
  topK?: number;
  /** Minimum score [0–1]; matches below it are dropped. Defaults to 0. */
  minSimilarity?: number;
  /**
   * Retrieval strategy — `"cosine"` (default) or `"keyword"` (Neon-only). See
   * {@link RetrievalStrategy}.
   */
  strategy?: RetrievalStrategy;
  /**
   * Optional scoring weights. Today only `weight.temporal` is honored — it applies
   * a time-decay against each memory's `occurredAt`. Omit for pure relevance.
   */
  weight?: RecallWeight;
  /**
   * Hard metadata filter. Neon uses JSONB containment; Upstash supports scalar
   * equality filters. Applied before ranking; max 4 KB serialized.
   */
  filter?: Record<string, unknown>;
  /** Optional store selector. Pass the same store used at write time. See {@link MemoryStore}. */
  store?: MemoryStore;
}

export interface RecallMatch {
  /** UUID of the memory. */
  id: string;
  /** The stored content. */
  content: string;
  /** The scope label. */
  scope: string;
  /**
   * Canonical [0–1] relevance the matches are ranked and thresholded on (highest
   * first). Provider-neutral: an opaque backend reports only this single score.
   */
  score: number;
  /**
   * Optional backend-specific score legs. A backend may fill this with its own
   * components; most dense-only paths omit it entirely. This is an open map —
   * don't assume a fixed set of keys.
   */
  scoreBreakdown?: Record<string, number>;
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** ISO-8601 event-time this memory is *about*, or `null` when none was supplied. */
  occurredAt: string | null;
  /** ISO-8601 timestamp this memory was last read, or `null` if never recalled since creation. */
  lastAccessedAt: string | null;
  /** The stored metadata. */
  metadata: Record<string, unknown>;
}

export interface RecallResponse {
  /** Matches ranked by `score` (highest first). Empty when nothing matched or no store exists yet. */
  results: RecallMatch[];
  /** The query, echoed back. */
  query: string;
  /** The effective top-K used by the gateway. */
  topK: number;
  /** Number of results returned (≤ `topK`). */
  count: number;
}

export interface Memory {
  /** UUID of the memory. */
  id: string;
  /** The stored content. */
  content: string;
  /** The scope label. */
  scope: string;
  /** ISO-8601 timestamp when the memory was created (server ingestion time). */
  createdAt: string;
  /** ISO-8601 event-time this memory is *about*, or `null` when none was supplied. */
  occurredAt: string | null;
  /** ISO-8601 timestamp this memory was last read, or `null` if never recalled since creation. */
  lastAccessedAt: string | null;
  /** The stored metadata. */
  metadata: Record<string, unknown>;
}

/**
 * Eviction order for {@link sweep}:
 * - `"lru"`    — least-recently-accessed first (`lastAccessedAt` ascending). Default.
 * - `"oldest"` — oldest-inserted first (`createdAt` ascending).
 */
export type SweepStrategy = "lru" | "oldest";

export interface SweepInput {
  /**
   * Maximum number of memories to preview/delete (1–10,000). Omit to use the
   * gateway's default sweep batch (100 rows).
   */
  count?: number;
  /** Eviction order — `"lru"` (default) or `"oldest"`. See {@link SweepStrategy}. */
  strategy?: SweepStrategy;
  /**
   * Preview vs delete. **Defaults to `true`** (a safe preview): the gateway returns
   * the `candidates` it would evict without deleting anything (`evicted: 0`). Pass
   * `false` to actually evict.
   */
  dryRun?: boolean;
  /** Optional store selector. Sweep is Neon-only. See {@link MemoryStore}. */
  store?: MemoryStore;
}

/** A memory that a `sweep` would evict. */
export interface MemorySweepCandidate {
  /** UUID of the memory. */
  id: string;
  /** The stored content. */
  content: string;
  /** The scope label. */
  scope: string;
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** ISO-8601 timestamp this memory was last read, or `null` if never recalled since creation. */
  lastAccessedAt: string | null;
}

export interface MemorySweepResponse {
  /** Number of memories evicted (`0` on a `dryRun`). */
  evicted: number;
  /**
   * The memories that *would* be evicted — present on a `dryRun` (the default).
   * Review them, then {@link forget} specific ids or re-run `sweep` with
   * `dryRun: false`.
   */
  candidates?: MemorySweepCandidate[];
}

/** Per-call options for {@link get} and {@link forget}. */
export interface MemoryCallOptions {
  /** Optional store selector. Pass the same store used at write time. See {@link MemoryStore}. */
  store?: MemoryStore;
}

// ----- capability operations -----

/**
 * Append a memory to the store (an append-log — no prior memory is mutated). The
 * gateway runs a secret-detection gate first (a detected secret is rejected with a
 * 400 {@link MemoryHttpError}, body `decision: "REJECTED"`), then embeds the
 * content and writes it, returning `decision: "ADDED"`.
 *
 * Byte-identical content, or a near-exact semantic duplicate, in the same owner +
 * scope is a no-op that echoes the existing memory unchanged (`decision: "NOOP"`);
 * nothing new is written.
 *
 * On a full Neon store the gateway returns `507` ({@link MemoryHttpError}); call
 * {@link sweep} (or {@link forget}) to free space, then retry. On Upstash, first
 * provisioning can return `422` when the account/index limit is reached.
 */
export async function append(
  input: AppendInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<AppendResult> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  if (input.occurredAt !== undefined) body.occurredAt = input.occurredAt;
  if (input.store !== undefined) body.store = input.store;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/memory/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to append memory",
  );
  return (await res.json()) as AppendResult;
}

/**
 * Recall memories by natural-language query. Returns the top-K matches ranked by
 * score; an empty list when nothing matches or no memory store has been provisioned
 * yet (not an error).
 *
 * After the route gate succeeds, infra, child billing, rate-limit, and timeout
 * failures degrade to an empty result set. Bad requests, missing identity, and
 * ownership failures (`400`/`401`/`403`) surface as {@link MemoryHttpError}.
 */
export async function recall(
  input: RecallInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RecallResponse> {
  const body: Record<string, unknown> = { query: input.query };
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.topK !== undefined) body.topK = input.topK;
  if (input.minSimilarity !== undefined)
    body.minSimilarity = input.minSimilarity;
  if (input.strategy !== undefined) body.strategy = input.strategy;
  if (input.weight !== undefined) body.weight = input.weight;
  if (input.filter !== undefined) body.filter = input.filter;
  if (input.store !== undefined) body.store = input.store;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/memory/recall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to recall memories",
  );
  return (await res.json()) as RecallResponse;
}

/**
 * Sweep (evict) memories to reclaim space — consumer-triggered, never automatic.
 * Call it after a `507` on {@link append}, or proactively to compact the store.
 * Eviction is Neon-only today; a store with nothing to sweep returns `{ evicted: 0 }`.
 *
 * `dryRun` **defaults to `true`**: the gateway returns the `candidates` it would
 * evict without deleting anything — review them, then {@link forget} specific ids
 * or re-run with `dryRun: false` to actually evict.
 */
export async function sweep(
  input: SweepInput = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<MemorySweepResponse> {
  const body: Record<string, unknown> = {};
  if (input.count !== undefined) body.count = input.count;
  if (input.strategy !== undefined) body.strategy = input.strategy;
  if (input.dryRun !== undefined) body.dryRun = input.dryRun;
  if (input.store !== undefined) body.store = input.store;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/memory/sweep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to sweep memories",
  );
  return (await res.json()) as MemorySweepResponse;
}

/**
 * Build the `/v1/memory/:id` URL for get/forget, including any store selector.
 */
function memoryItemUrl(
  baseUrl: string,
  id: string,
  options?: MemoryCallOptions,
): string {
  const path = `${baseUrl}/v1/memory/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  const store = options?.store;
  if (store) {
    if (store.backend !== undefined) {
      params.set("storeBackend", store.backend);
    }
    if (store.namespace !== undefined) {
      params.set("storeNamespace", store.namespace);
    }
    if (store.embedder !== undefined) {
      params.set("storeEmbedderProvider", store.embedder.provider);
      params.set("storeEmbedderModel", store.embedder.model);
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Fetch a single memory by id. Throws {@link MemoryHttpError} with `status: 404`
 * when the memory doesn't exist or belongs to another owner (existence is not
 * leaked across owners).
 */
export async function get(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
  options?: MemoryCallOptions,
): Promise<Memory> {
  const res = await ensureOk(
    await transport.fetch(memoryItemUrl(baseUrl, id, options)),
    `Failed to get memory '${id}'`,
  );
  return (await res.json()) as Memory;
}

/**
 * Forget (hard-delete) a memory by id. Idempotent: a missing or already-deleted
 * id is treated as success by the gateway.
 */
export async function forget(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
  options?: MemoryCallOptions,
): Promise<void> {
  const res = await transport.fetch(memoryItemUrl(baseUrl, id, options), {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    throw new MemoryHttpError(
      `Failed to forget memory '${id}': ${res.status} ${text}`,
      res.status,
      parsed,
    );
  }
  // 204 No Content — nothing to parse.
}
