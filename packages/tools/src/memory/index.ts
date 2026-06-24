/**
 * `memory` capability — tenant-scoped long-term memory on the Sapiom memory
 * gateway (hybrid semantic + full-text memory store, one per owner).
 *
 *   import { memory } from "@sapiom/tools";                 // ambient auth
 *   const { id } = await memory.append({ content: "User prefers dark mode.", scope: "user" });
 *   const { results } = await memory.recall({ query: "ui preferences", topK: 5 });
 *   const record = await memory.get(id);
 *   await memory.forget(id);
 *
 * Or via an explicit client: `createClient({ apiKey }).memory.append(...)`.
 *
 * Thin client: the gateway already speaks camelCase JSON, so request inputs and
 * response objects map 1:1 to the wire — there is no snake_case translation layer
 * here (unlike the file-storage capability, whose gateway is snake_case). The only
 * work this module does is assembling the request body (omitting unset optionals)
 * and surfacing non-2xx responses as {@link MemoryHttpError}.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, MemoryHttpError } from "./errors.js";

export { MemoryHttpError };

/**
 * Memory service ORIGIN — override via SAPIOM_MEMORY_URL. Like every other
 * @sapiom/tools capability (sandbox/agents/git/file-storage), this is the bare
 * origin; the `/v1/memory` path prefix is appended per-method below. So a local
 * override is just the gateway origin, e.g. `http://memory.services.localhost:3100`.
 */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_MEMORY_URL || "https://memory.services.sapiom.ai";

// ----- SDK-facing types (identical to the wire; camelCase end to end) -----

/**
 * EXPERIMENTAL storage backend for a memory call. This folds into the store
 * identity: a memory written under one backend is a SEPARATE store, only visible
 * when read with the same backend (store-fixed per backend, like the embedder
 * lock). Intended for A/B testing alternate backends; omit it for the default,
 * production `"neon-pgvector"`.
 */
export type ExperimentalBackend = "neon-pgvector" | "upstash-vector";

/**
 * EXPERIMENTAL embedder override for a memory call. Choosing a non-default embedder
 * folds into the store identity — a different embedder is a SEPARATE store (a
 * re-embed), so write and read must use the same embedder. Example:
 * `{ provider: "openrouter", model: "openai/text-embedding-3-large" }`. Omit for
 * the standard OpenRouter embedder.
 */
export interface ExperimentalEmbedder {
  /** Embedding provider, e.g. `"openrouter"`. */
  provider: string;
  /** Embedding model, e.g. `"openai/text-embedding-3-large"`. */
  model: string;
}

export interface AppendInput {
  /**
   * Text to store as a memory (1–32,000 chars). Must not contain secrets — the
   * gateway runs an admission gate and rejects API keys / tokens / passwords with
   * a 400.
   */
  content: string;
  /**
   * Scope label grouping related memories (e.g. "session", "user", "project").
   * Alphanumeric plus hyphens/underscores, 1–100 chars. Defaults to "default".
   */
  scope?: string;
  /**
   * Arbitrary JSON stored alongside the memory and returned on read. Opaque to
   * search (not indexed). Max 10 KB when JSON-serialized.
   */
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key (1–255 chars; alphanumeric plus `. _ : -`). Re-submitting an
   * append with the same key within the same owner + scope returns the existing
   * memory unchanged with `decision: "NOOP"` — nothing new is written.
   */
  idempotencyKey?: string;
  /**
   * EXPERIMENTAL: select the storage backend for this write. Folds into the store
   * identity — a memory written under one backend is a SEPARATE store, only visible
   * when read (recall/get/forget) with the SAME backend (store-fixed per backend).
   * Omit for the default, production `"neon-pgvector"`.
   */
  experimentalBackend?: ExperimentalBackend;
  /**
   * EXPERIMENTAL: choose the embedding model (e.g. provider `"openrouter"`, model
   * `"openai/text-embedding-3-large"`). Folds into the store identity (different
   * embedder = a separate store). the default standard OpenRouter embedder.
   */
  experimentalEmbedder?: ExperimentalEmbedder;
  /**
   * Optional physical-isolation selector: a different namespace resolves a SEPARATE
   * physical store (its own database/index). Lets you isolate your own tenants'
   * memory. Folds into the store identity — write and read must use the same
   * namespace. Default = your default store. 1–100 chars, `[a-zA-Z0-9_-]`.
   */
  namespace?: string;
}

export interface AppendResult {
  /**
   * UUID of the memory. For `decision: "ADDED"` / `"SUPERSEDED"` this is the newly
   * created record; for `decision: "NOOP"` it is the existing memory that was
   * echoed (nothing was written).
   */
  id: string;
  /** The stored content, echoed back. */
  content: string;
  /** The resolved scope label ("default" when you omitted it). */
  scope: string;
  /** Always "active" for the returned memory. */
  status: "active";
  /**
   * What the gateway did, made legible (never a silent write):
   * - `"ADDED"`      — a new memory was written; nothing was superseded.
   * - `"SUPERSEDED"` — a new memory was written and the nearest prior
   *   (cosine ≥ 0.80) was superseded; `supersededId` points to it.
   * - `"NOOP"`       — byte-identical content (exact match or cosine ≈ 1.0) or an
   *   `idempotencyKey` re-submit; the existing memory is echoed and nothing is
   *   written.
   *
   * A secret caught by the admission gate is *not* a decision here — it surfaces as
   * a 400 {@link MemoryHttpError} whose body carries `decision: "REJECTED"`.
   */
  decision: "ADDED" | "SUPERSEDED" | "NOOP";
  /** UUID of the prior memory superseded by this write — non-null only when `decision` is `"SUPERSEDED"`, else `null`. */
  supersededId: string | null;
  /** Cosine similarity to the nearest prior memory (0–1), or `null` when no neighbor existed. */
  similarityScore: number | null;
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** The stored metadata (`{}` when none was provided). */
  metadata: Record<string, unknown>;
}

export interface RecallInput {
  /** Natural-language search text (1–4,096 chars). Embedded and compared against stored memories. */
  query: string;
  /** Restrict the search to this scope label. Omit to search every scope for your owner. */
  scope?: string;
  /** Maximum number of results to return (1–50). Defaults to 10. */
  topK?: number;
  /** Minimum combined score [0–1]; matches below it are dropped. Defaults to 0. */
  minSimilarity?: number;
  /**
   * EXPERIMENTAL: select the storage backend to search. Folds into the store
   * identity — recall only sees memories appended under the SAME backend
   * (store-fixed per backend). Omit for the default, production `"neon-pgvector"`.
   */
  experimentalBackend?: ExperimentalBackend;
  /**
   * EXPERIMENTAL: choose the embedding model (e.g. provider `"openrouter"`, model
   * `"openai/text-embedding-3-large"`). Folds into the store identity — recall only
   * sees memories appended under the SAME embedder. the default standard OpenRouter
   * embedder.
   */
  experimentalEmbedder?: ExperimentalEmbedder;
  /**
   * Optional physical-isolation selector: a different namespace reads a SEPARATE
   * physical store (its own database/index). Must match the namespace the memory was
   * written under. Default = your default store.
   */
  namespace?: string;
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
   * Optional backend-specific score legs. The hybrid backend fills this with its
   * `{ vector, text, combined }` components; an opaque backend omits it entirely.
   * An open map — don't assume a fixed set of keys.
   */
  scoreBreakdown?: Record<string, number>;
  /** Lifecycle status — always `"active"` (superseded memories are excluded from recall). */
  status: "active";
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** The stored metadata. */
  metadata: Record<string, unknown>;
}

export interface RecallResponse {
  /** Matches ranked by `score` (highest first). Empty when nothing matched or no store exists yet. */
  results: RecallMatch[];
  /** The query, echoed back. */
  query: string;
  /** The effective top-K used (after clamping to the 1–50 range). */
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
  /** Lifecycle status: `"active"` or `"superseded"`. */
  status: "active" | "superseded";
  /** UUID of the newer memory that superseded this one, or `null`. */
  supersededBy: string | null;
  /** Reason this memory was superseded, or `null`. */
  supersededReason: string | null;
  /** ISO-8601 timestamp when the memory was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the memory was last updated (e.g. superseded). */
  updatedAt: string;
  /** The stored metadata. */
  metadata: Record<string, unknown>;
}

/**
 * Per-call options for the bodyless reads {@link get} and {@link forget}. The
 * append/recall counterpart rides on {@link AppendInput}/{@link RecallInput}; the
 * bodyless routes take these as query params instead — including the embedder, which
 * is flattened to bracket notation (`experimentalEmbedder[provider]`,
 * `experimentalEmbedder[model]`) to match the gateway's query DTO.
 */
export interface MemoryCallOptions {
  /**
   * EXPERIMENTAL: select the storage backend to read from. Must match the backend
   * the memory was appended under — the id folds into the store identity, so a
   * get/forget under a different backend won't find it. Sent as a query param;
   * omit for the default, production `"neon-pgvector"`.
   */
  experimentalBackend?: ExperimentalBackend;
  /**
   * EXPERIMENTAL: choose the embedding model. Must match the embedder the memory was
   * appended under (it folds into the store identity). Sent as bracket-notation query
   * params; omit for the standard OpenRouter embedder.
   */
  experimentalEmbedder?: ExperimentalEmbedder;
  /**
   * Optional physical-isolation selector. Must match the namespace the memory was
   * written under (it selects a SEPARATE physical store). Sent as a query param;
   * omit for your default store.
   */
  namespace?: string;
}

// ----- capability operations -----

/**
 * Append a memory. The gateway embeds the content and runs a supersede check: if a
 * near-duplicate (cosine ≥ 0.80) already exists in the same scope, this memory
 * supersedes it — the prior is marked `superseded` (`decision: "SUPERSEDED"`,
 * `supersededId` set).
 * Byte-identical content — or a re-submit carrying the same `idempotencyKey` — is a
 * no-op that echoes the existing memory (`decision: "NOOP"`); any other write
 * returns `decision: "ADDED"`. Content/metadata pass through a secret-detection
 * gate — a detected secret is rejected with a 400 ({@link MemoryHttpError}, body
 * `decision: "REJECTED"`).
 */
export async function append(
  input: AppendInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<AppendResult> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  if (input.idempotencyKey !== undefined) {
    body.idempotencyKey = input.idempotencyKey;
  }
  if (input.experimentalBackend !== undefined) {
    body.experimentalBackend = input.experimentalBackend;
  }
  if (input.experimentalEmbedder !== undefined) {
    body.experimentalEmbedder = input.experimentalEmbedder;
  }
  if (input.namespace !== undefined) {
    body.namespace = input.namespace;
  }

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
 * Recall memories by natural-language query (hybrid vector + full-text search).
 * Returns the top-K active matches ranked by combined score; an empty list when
 * nothing matches or no memory store has been provisioned yet (not an error).
 */
export async function recall(
  input: RecallInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<RecallResponse> {
  const body: Record<string, unknown> = { query: input.query };
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.topK !== undefined) body.topK = input.topK;
  if (input.minSimilarity !== undefined) body.minSimilarity = input.minSimilarity;
  if (input.experimentalBackend !== undefined) {
    body.experimentalBackend = input.experimentalBackend;
  }
  if (input.experimentalEmbedder !== undefined) {
    body.experimentalEmbedder = input.experimentalEmbedder;
  }
  if (input.namespace !== undefined) {
    body.namespace = input.namespace;
  }

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
 * Build the `/v1/memory/:id` URL for the bodyless get/forget routes, appending the
 * store-identity selectors the caller supplied as query params (an omitted selector
 * falls through to the gateway default). The embedder object is flattened to bracket
 * notation (`experimentalEmbedder[provider]=...&experimentalEmbedder[model]=...`) to
 * match the gateway's query DTO.
 */
function memoryItemUrl(
  baseUrl: string,
  id: string,
  options?: MemoryCallOptions,
): string {
  const path = `${baseUrl}/v1/memory/${encodeURIComponent(id)}`;
  const params = new URLSearchParams();
  if (options?.experimentalBackend !== undefined) {
    params.set("experimentalBackend", options.experimentalBackend);
  }
  if (options?.namespace !== undefined) {
    params.set("namespace", options.namespace);
  }
  if (options?.experimentalEmbedder !== undefined) {
    params.set(
      "experimentalEmbedder[provider]",
      options.experimentalEmbedder.provider,
    );
    params.set(
      "experimentalEmbedder[model]",
      options.experimentalEmbedder.model,
    );
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Fetch a single memory by id, including superseded records (so you can
 * follow a supersession chain via `supersededBy`). Throws {@link MemoryHttpError}
 * with `status: 404` when the memory doesn't exist or belongs to another owner.
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
 * Forget (hard-delete) a memory by id — a true `DELETE` of the row (GDPR /
 * right-to-be-forgotten). The content is erased: its audit rows cascade away and
 * any `supersededBy` pointers to it are cleared. This is distinct from
 * supersession, which only *supersedes* a prior memory (recoverable via {@link get});
 * `forget` is destructive.
 *
 * Idempotent: forget always resolves (the gateway returns `204 No Content`).
 * Deleting an already-gone id — or one that never existed — is success, not an
 * error; there is no 404 for a missing id and no "already superseded" 409 state
 * for forget. (Real transport/auth failures still surface as {@link MemoryHttpError}.)
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
