/**
 * Tenant-scoped long-term memory backed by the Sapiom memory service.
 *
 *   import { memory } from "@sapiom/tools";                 // ambient auth
 *   const { id } = await memory.append({ content: "User prefers dark mode.", namespace: "user-42" });
 *   const { results } = await memory.recall({ query: "ui preferences", namespace: "user-42", topK: 5 });
 *   await memory.forget({ ids: [id], namespace: "user-42" });
 *   await memory.drop("user-42");
 *
 * Or via an explicit client: `createClient({ apiKey }).memory.append(...)`.
 *
 * Memory is durable knowledge, not chat history: `recall` ranks by relevance to
 * the query, never by recency — keep last-N-turns context in your own store.
 *
 * The memory service speaks camelCase JSON, so this client keeps request and
 * response objects 1:1 with the wire contract.
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
 * path prefix is appended per-method below (a local override is just the service
 * origin, e.g. `http://memory.services.localhost:3100`).
 */
const DEFAULT_BASE_URL = resolveServiceUrl(
  "memory",
  process.env.SAPIOM_MEMORY_URL,
);

// ----- SDK-facing types (identical to the wire; camelCase end to end) -----

/** A metadata leaf value. Strings, numbers, and booleans only — no arrays, no nulls. */
export type MemoryMetadataValue = string | number | boolean;

/**
 * Metadata stored alongside a memory: a FLAT map of identifier keys (letter
 * first; `.` is reserved and rejected) to string/number/boolean values.
 * No nesting, no arrays, no nulls — violations are a 400 `invalid_metadata`.
 * Express hierarchy through key naming conventions (e.g. `env_prod`,
 * `user_theme`). Bounds (enforced server-side): up to 20 keys per memory, each
 * key at most 64 bytes, and string values at most 512 characters.
 *
 * A key's value TYPE is pinned per namespace at its first write and is
 * immutable after — a later write with a conflicting type is a 400
 * `invalid_metadata` naming the key, so keep each key's type consistent
 * within a namespace. Numbers are stored as floats (integers and fractional
 * values mix freely on one key).
 *
 * Metadata keys are usable as hard {@link RecallInput.filter} keys. For
 * better performance, use `namespace` for a key you'd filter on every
 * recall — metadata suits optionally-filtered dimensions.
 */
export type MemoryMetadata = Record<string, MemoryMetadataValue>;

/** Metadata as it comes back on reads — the same flat shape as {@link MemoryMetadata}. */
export type StoredMemoryMetadata = MemoryMetadata;

export interface AppendInput {
  /**
   * Text to store as a memory. Must not contain secrets — API keys / tokens /
   * passwords are rejected server-side with a 400 (`secret_detected`) before
   * anything is embedded or stored. At most 32,000 characters; oversized
   * content is rejected with a 400.
   */
  content: string;
  /**
   * Isolation namespace this memory lives in. Reads only ever see one namespace,
   * and {@link drop} deletes one namespace wholesale.
   *
   * Default to a namespace per agent, per user, or per project. A namespace has
   * bounded capacity, so prefer many small namespaces over one large one; put
   * subsets in a single namespace (distinguished by `metadata` + recall `filter`)
   * only when one recall must span them. Omit for your owner's default namespace.
   * 1–100 characters, limited to letters, digits, `-`, and `_`.
   */
  namespace?: string;
  /**
   * Flat metadata stored with the memory and returned on recall — see
   * {@link MemoryMetadata}. Opaque to ranking (not embedded); keys are usable
   * as a hard `filter` on recall.
   */
  metadata?: MemoryMetadata;
  /**
   * Event-time this memory is *about* (ISO-8601), distinct from `createdAt` (the
   * server ingestion time). Drives temporal recall weighting. When omitted, the
   * service stores `null` and temporal recall falls back to `createdAt`.
   */
  occurredAt?: string;
}

export interface AppendResult {
  /** Id of the stored memory. Keep it to `forget` the memory later. */
  id: string;
  /** The stored content, echoed back. */
  content: string;
  /** ISO-8601 acknowledgement timestamp (the authoritative record timestamps return on recall). */
  createdAt: string;
  /** The stored metadata. Omitted when none was provided (never `{}`). */
  metadata?: StoredMemoryMetadata;
  /** ISO-8601 event-time this memory is *about*. Omitted when none was supplied. */
  occurredAt?: string;
}

/**
 * Retrieval strategy for {@link recall}:
 * - `"semantic"` — ranks by meaning; the default.
 * - `"keyword"`  — matches exact terms and identifiers.
 * - `"hybrid"`   — fuses semantic and keyword ranking (opt-in).
 */
export type RetrievalStrategy = "semantic" | "keyword" | "hybrid";

/** Time-decay weighting for {@link RecallInput.weight}. Optional; omit for pure relevance. */
export interface TemporalWeight {
  /**
   * ISO-8601 anchor the decay is measured from. Defaults to "now" at recall time.
   * (A Unix-epoch integer is not accepted — pass an ISO-8601 string.)
   */
  center?: string;
  /**
   * Half-life in days: a memory whose `occurredAt` is this far from `center`
   * keeps half its relevance. Smaller = sharper recency preference. Defaults to
   * 30 when omitted (bounds: 1–365).
   */
  halfLifeDays?: number;
}

/** Optional scoring weights for {@link recall}. Extensible; only `temporal` is supported today. */
export interface RecallWeight {
  /** Multiplicative time-decay applied to each match's base similarity. */
  temporal?: TemporalWeight;
}

/** A filter value: a scalar to match exactly, or `{ in: [...] }` to match any of a set. */
export type MemoryFilterValue =
  | MemoryMetadataValue
  | { in: MemoryMetadataValue[] };

/**
 * Hard metadata filter for {@link recall}: keys are your metadata keys, values
 * match exactly (scalar) or against a set (`{ in: [...] }`). Applied before
 * ranking. A malformed key or value shape is a 400 (`invalid_filter`).
 */
export type MemoryFilter = Record<string, MemoryFilterValue>;

export interface RecallInput {
  /**
   * Natural-language search text. Embedded and compared against stored memories.
   * At most 4,096 characters.
   */
  query: string;
  /**
   * Namespace to search. A recall never spans namespaces — see
   * {@link AppendInput.namespace} for how to partition. Omit for your owner's
   * default namespace.
   */
  namespace?: string;
  /** Maximum number of results to return. Defaults to 5; at most 50. */
  topK?: number;
  /**
   * Retrieval strategy — `"semantic"` (default), `"keyword"`, or `"hybrid"`. See
   * {@link RetrievalStrategy}.
   */
  strategy?: RetrievalStrategy;
  /**
   * Optional scoring weights. Today only `weight.temporal` is honored — it applies
   * a time-decay against each memory's `occurredAt`. Omit for pure relevance.
   */
  weight?: RecallWeight;
  /**
   * Hard metadata filter — see {@link MemoryFilter}. For better performance,
   * use `namespace` for a dimension you'd filter on every recall — `filter`
   * suits optionally-filtered subsets. Up to 20 keys; an `{ in: [...] }` set
   * holds at most 64 values.
   */
  filter?: MemoryFilter;
}

export interface RecallMatch {
  /** Id of the memory. */
  id: string;
  /** The stored content. */
  content: string;
  /**
   * Relevance the matches are ranked on (highest first). Strategy-relative: scores
   * are comparable within one response, not across strategies or queries.
   */
  score: number;
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** ISO-8601 event-time this memory is *about*, or `null` when none was supplied. */
  occurredAt: string | null;
  /** The stored metadata, or `null` when the record carries none. */
  metadata: StoredMemoryMetadata | null;
}

export interface RecallResponse {
  /** Matches ranked by `score` (highest first). Empty when nothing matched. */
  results: RecallMatch[];
  /** The query, echoed back. */
  query: string;
  /** The effective top-K applied server-side. */
  topK: number;
  /** Number of results returned (≤ `topK`). */
  count: number;
}

export interface ForgetInput {
  /** Ids of the memories to forget. Up to 100 per call. */
  ids: string[];
  /** Namespace the memories live in. Omit for your owner's default namespace. */
  namespace?: string;
}

// ----- capability operations -----

/**
 * Append one memory (an append-log — no prior memory is mutated). A
 * secret-detection gate runs first server-side (a detected secret is a 400
 * {@link MemoryHttpError}, `secret_detected`), then the content is embedded and
 * written.
 */
export async function append(
  input: AppendInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<AppendResult> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.namespace !== undefined) body.namespace = input.namespace;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  if (input.occurredAt !== undefined) body.occurredAt = input.occurredAt;

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
 * score; an empty list when nothing matches (not an error).
 *
 * Recall is relevance search over one namespace, not a recency view — it is not
 * a way to page through chat history. Bad requests (`invalid_filter`), missing
 * identity, and ownership failures surface as {@link MemoryHttpError};
 * infrastructure failures surface as 502/504.
 */
export async function recall(
  input: RecallInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RecallResponse> {
  const body: Record<string, unknown> = { query: input.query };
  if (input.namespace !== undefined) body.namespace = input.namespace;
  if (input.topK !== undefined) body.topK = input.topK;
  if (input.strategy !== undefined) body.strategy = input.strategy;
  if (input.weight !== undefined) body.weight = input.weight;
  if (input.filter !== undefined) body.filter = input.filter;

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
 * Forget (hard-delete) memories by id. Idempotent and blind: missing or
 * already-deleted ids are treated as success.
 */
export async function forget(
  input: ForgetInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const body: Record<string, unknown> = { ids: input.ids };
  if (input.namespace !== undefined) body.namespace = input.namespace;

  const res = await transport.fetch(`${baseUrl}/v1/memory`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
      `Failed to forget memories: ${res.status} ${text}`,
      res.status,
      parsed,
    );
  }
  // 204 No Content — nothing to parse.
}

/**
 * Drop an entire namespace: every memory in it is deleted and a later append to
 * the same name starts a fresh namespace. Idempotent: dropping a namespace that
 * doesn't exist is success.
 */
export async function drop(
  namespace: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const res = await transport.fetch(
    `${baseUrl}/v1/memory/namespaces/${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    throw new MemoryHttpError(
      `Failed to drop namespace '${namespace}': ${res.status} ${text}`,
      res.status,
      parsed,
    );
  }
  // 204 No Content — nothing to parse.
}
