/**
 * `searchindex` capability — provisioned search indexes with auto-embedding:
 * full-text + semantic search over JSON documents, with no embedding pipeline to
 * run. Distinct from the `search` namespace (web search / scrape); this one is a
 * data store you fill and query.
 *
 *   import { searchindex } from "@sapiom/tools";            // ambient auth
 *   const idx = await searchindex.create({ name: "docs-corpus" });
 *   await idx.upsert([
 *     { id: "getting-started", content: { title: "Get Started", body: "…" },
 *       metadata: { url: "https://docs.example.com/", contentHash: "…" } },
 *   ]);
 *   const hits = await idx.query({ query: "how do I authenticate?", limit: 3 });
 *   hits[0]?.id;                                            // best-matching document
 *
 *   const again = await searchindex.get(idx.id);            // re-bind by id
 *   const all = await searchindex.list();                   // every index you own
 *   const page = await again.range({ limit: 100 });         // enumerate documents
 *
 * Or via an explicit client / a workflow step: `ctx.sapiom.searchindex.create(...)`.
 *
 * Two planes, one handle. The control plane (create/get/list/update/delete)
 * lives on the management gateway; `create`/`get`/`list` return a
 * {@link SearchIndex} handle whose data-plane operations
 * (upsert/query/range/fetchDocuments/deleteDocuments) are bound to that index's
 * own data-plane URL (`https://<id>.search.data.sapiom.ai`). Documents are
 * auto-embedded from `content` server-side; `metadata` is stored verbatim and
 * NOT embedded — put bookkeeping there (URLs, content hashes), never in
 * `content`.
 *
 * Lifetime: indexes created with a `ttl` expire and are REAPED (max ttl 30d).
 * Omit `ttl` for a long-lived index (e.g. a docs corpus); `update(id,
 * { expiresAt })` can extend or set expiry later.
 *
 * Customer usage is expressed through provider-invisible logical meters:
 * `searchindex.index` for active allocations and one of `searchindex.upsert`,
 * `searchindex.query`, `searchindex.query_rerank`, `searchindex.range`,
 * `searchindex.fetch_documents`, or `searchindex.delete_documents` per
 * data-plane request. Batch upserts — one call with 50 documents uses the same
 * request count as one call with 1.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import {
  ensureOk,
  SearchIndexContractError,
  SearchIndexHttpError,
} from "./errors.js";
import {
  DEFAULT_SEARCH_INDEX_QUERY_LIMIT,
  DEFAULT_SEARCH_INDEX_RANGE_CURSOR,
  DEFAULT_SEARCH_INDEX_RANGE_LIMIT,
  normalizeSearchIndexRangeInput,
  resolveSearchIndexName,
  validateCreateSearchIndexInput,
  validateSearchDocumentIds,
  validateSearchDocumentInputs,
  validateSearchIndexId,
  validateSearchIndexIncludeOptions,
  validateSearchQueryInput,
  validateUpdateSearchIndexInput,
} from "./validation.js";

export {
  DEFAULT_SEARCH_INDEX_RANGE_CURSOR,
  DEFAULT_SEARCH_INDEX_RANGE_LIMIT,
  SearchIndexContractError,
  SearchIndexHttpError,
};

const DEFAULT_BASE_URL = resolveServiceUrl(
  "upstash",
  process.env.SAPIOM_SEARCHINDEX_URL,
);

// ----- Types -----

/** Lifecycle state of a search index. */
export type SearchIndexStatus =
  | "provisioning"
  | "active"
  | "expired"
  | "deleting"
  | "deleted";

export interface CreateSearchIndexInput {
  /** Index name (1–128 chars). Not unique server-side — prefer distinctive names. */
  name: string;
  /** Optional region (default: us-central1; eu-west-1 also available). */
  region?: string;
  /**
   * Optional time-to-live, e.g. `"1h"`, `"24h"`, `"7d"` (max 30 days). An
   * expired index is deleted by a reaper — OMIT for a long-lived index.
   */
  ttl?: string;
}

export interface UpdateSearchIndexInput {
  /** New display name (1–128 chars). */
  name?: string;
  /** New ISO-8601 expiry (must be in the future), e.g. to extend a ttl. */
  expiresAt?: string;
}

/** Read-only metadata for a search index. */
export interface SearchIndexInfo {
  /** Unique index id (`res_…`) — also the subdomain of the data-plane URL. */
  id: string;
  /** Display name. */
  name: string;
  /** Lifecycle state. */
  status: SearchIndexStatus;
  /** The index's own data-plane base URL (`https://<id>.search.data.sapiom.ai`). */
  url: string;
  /** Region the index is provisioned in, or `null` for legacy/unknown records. */
  region: string | null;
  /** ISO-8601 expiry, or `null` when the index does not expire. */
  expiresAt: string | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** One document to store: `content` is auto-embedded, `metadata` is not. */
export interface SearchDocumentInput {
  /** Unique document id within the index. */
  id: string;
  /** The searchable fields (auto-embedded server-side), e.g. `{ title, body }`. */
  content: Record<string, unknown>;
  /** Stored verbatim, never embedded — URLs, content hashes, timestamps, … */
  metadata?: Record<string, unknown>;
}

/**
 * One document returned by range/fetch. Payload fields are absent unless the
 * corresponding include flag was requested; absence is never fabricated as an
 * empty object.
 */
export interface SearchDocument {
  id: string;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** One search result. `score` is higher-is-better relevance when present. */
export interface SearchHit {
  id: string;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface SearchQueryInput {
  /** The search query (semantic + full-text). */
  query: string;
  /** Max results to return (defaults to 5; valid range 1–1000). */
  limit?: number;
  /** Re-rank results server-side; selects the `searchindex.query_rerank` meter. */
  reranking?: boolean;
  /** Optional metadata filter expression. */
  filter?: string;
}

/** Payload-inclusion flags for enumeration reads (both default false upstream). */
export interface SearchIndexIncludeOptions {
  /** Include each document's `metadata` (e.g. contentHash) — the reconciliation flag. */
  includeMetadata?: boolean;
  /** Include each document's `content` payload. */
  includeData?: boolean;
}

export interface SearchIndexRangeInput extends SearchIndexIncludeOptions {
  /** Numeric pagination cursor from a previous page (defaults to `"0"`). */
  cursor?: string;
  /** Page size (defaults to 100; valid range 1–1000). */
  limit?: number;
}

/** One page of documents. Keep calling with `nextCursor` until it is null/empty. */
export interface SearchIndexRangeResult {
  nextCursor: string | null;
  documents: SearchDocument[];
}

/** Options accepted by every data-plane operation. */
export interface DataPlaneOptions {
  /**
   * The namespace inside the index to operate on (alphanumeric, `-`, `_`).
   * Defaults to `"default"` — most callers never set this.
   */
  indexName?: string;
}

/**
 * A bound search-index handle: the index's metadata plus its logically-metered
 * data-plane operations.
 */
export interface SearchIndex extends SearchIndexInfo {
  /** Insert or replace documents — ONE priced request regardless of count. */
  upsert(
    documents: SearchDocumentInput[],
    opts?: DataPlaneOptions,
  ): Promise<void>;
  /** Search the index. Returns ranked hits (best first). */
  query(input: SearchQueryInput, opts?: DataPlaneOptions): Promise<SearchHit[]>;
  /**
   * Enumerate documents page by page — the reconciliation primitive. Items
   * carry only `id` unless you set the include flags (verified live:
   * `{ includeMetadata: true }` is what a hash-diff reconciler wants).
   */
  range(
    input?: SearchIndexRangeInput,
    opts?: DataPlaneOptions,
  ): Promise<SearchIndexRangeResult>;
  /**
   * Fetch specific documents by id (`null` for ids that don't exist). Items
   * carry only `id` unless you set the include flags.
   */
  fetchDocuments(
    ids: string[],
    opts?: DataPlaneOptions & SearchIndexIncludeOptions,
  ): Promise<Array<SearchDocument | null>>;
  /** Delete specific documents by id. */
  deleteDocuments(ids: string[], opts?: DataPlaneOptions): Promise<void>;
}

// ----- Internal wire shapes -----

/** The gateway's `SearchDatabaseResponse` DTO. */
const SEARCH_INDEX_STATUSES = new Set<SearchIndexStatus>([
  "provisioning",
  "active",
  "expired",
  "deleting",
  "deleted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contractError(
  operation: string,
  message: string,
  body: unknown,
): never {
  throw new SearchIndexContractError(operation, message, body);
}

function parseInfo(raw: unknown, operation: string): SearchIndexInfo {
  if (!isRecord(raw)) contractError(operation, "expected an index object", raw);
  if (raw.type !== "search") {
    contractError(operation, "expected resource type 'search'", raw);
  }
  const requiredStrings = ["id", "name", "status", "url", "createdAt"] as const;
  for (const field of requiredStrings) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      contractError(
        operation,
        `expected non-empty string field '${field}'`,
        raw,
      );
    }
  }
  if (!SEARCH_INDEX_STATUSES.has(raw.status as SearchIndexStatus)) {
    contractError(
      operation,
      `unknown lifecycle status '${String(raw.status)}'`,
      raw,
    );
  }
  if (raw.region !== null && typeof raw.region !== "string") {
    contractError(operation, "expected 'region' to be a string or null", raw);
  }
  if (raw.expiresAt !== null && typeof raw.expiresAt !== "string") {
    contractError(
      operation,
      "expected 'expiresAt' to be a string or null",
      raw,
    );
  }
  return {
    id: raw.id as string,
    name: raw.name as string,
    status: raw.status as SearchIndexStatus,
    url: raw.url as string,
    region: raw.region as string | null,
    expiresAt: raw.expiresAt as string | null,
    createdAt: raw.createdAt as string,
  };
}

function parseDocument(
  raw: unknown,
  operation: string,
  position: number,
): SearchDocument {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    contractError(
      operation,
      `document at index ${position} requires a non-empty id`,
      raw,
    );
  }
  if (raw.content !== undefined && !isRecord(raw.content)) {
    contractError(operation, `document '${raw.id}' has malformed content`, raw);
  }
  if (raw.metadata !== undefined && !isRecord(raw.metadata)) {
    contractError(
      operation,
      `document '${raw.id}' has malformed metadata`,
      raw,
    );
  }
  return {
    id: raw.id,
    ...(raw.content !== undefined && { content: raw.content }),
    ...(raw.metadata !== undefined && { metadata: raw.metadata }),
  };
}

function parseQueryResponse(raw: unknown): SearchHit[] {
  // Canonical provider envelope is `{ result: [...] }`. A bare array is the
  // explicitly retained pre-envelope compatibility shape.
  const results = isRecord(raw) && "result" in raw ? raw.result : raw;
  if (!Array.isArray(results)) {
    contractError("query", "expected { result: [...] }", raw);
  }
  return results.map((item, index) => {
    const document = parseDocument(item, "query", index);
    const score = (item as Record<string, unknown>).score;
    if (score !== undefined && typeof score !== "number") {
      contractError(
        "query",
        `document '${document.id}' has malformed score`,
        item,
      );
    }
    return {
      ...document,
      ...(score !== undefined && { score }),
    };
  });
}

function parseRangeResponse(raw: unknown): SearchIndexRangeResult {
  let page: Record<string, unknown>;
  let items: unknown[];
  if (isRecord(raw) && "result" in raw) {
    // Canonical raw data-plane envelope.
    if (!isRecord(raw.result) || !Array.isArray(raw.result.vectors)) {
      contractError(
        "range",
        "expected { result: { nextCursor, vectors: [...] } }",
        raw,
      );
    }
    page = raw.result;
    items = raw.result.vectors;
  } else {
    // Explicit compatibility with the documented Search SDK page.
    if (!isRecord(raw) || !Array.isArray(raw.documents)) {
      contractError("range", "expected { nextCursor, documents: [...] }", raw);
    }
    page = raw;
    items = raw.documents;
  }
  if (typeof page.nextCursor !== "string") {
    contractError("range", "expected a string nextCursor", raw);
  }
  return {
    nextCursor: page.nextCursor === "" ? null : page.nextCursor,
    documents: items.map((item, index) => parseDocument(item, "range", index)),
  };
}

function parseFetchResponse(
  raw: unknown,
  expectedIds: readonly string[],
): Array<SearchDocument | null> {
  const results = isRecord(raw) && "result" in raw ? raw.result : raw;
  if (!Array.isArray(results)) {
    contractError("fetchDocuments", "expected { result: [...] }", raw);
  }
  if (results.length !== expectedIds.length) {
    contractError(
      "fetchDocuments",
      `expected ${expectedIds.length} positional results, received ${results.length}`,
      raw,
    );
  }
  return results.map((item, index) => {
    if (item === null) return null;
    const document = parseDocument(item, "fetchDocuments", index);
    if (document.id !== expectedIds[index]) {
      contractError(
        "fetchDocuments",
        `expected document id '${expectedIds[index]}' at index ${index}, received '${document.id}'`,
        item,
      );
    }
    return document;
  });
}

function parseListResponse(raw: unknown): SearchIndexInfo[] {
  // Canonical Unified contract: `{ databases: SearchDatabaseResponse[] }`.
  // Retain the original bare-array response only as an explicit compatibility
  // shape; every other envelope fails closed.
  const databases = isRecord(raw) && "databases" in raw ? raw.databases : raw;
  if (!Array.isArray(databases)) {
    contractError("list", "expected { databases: [...] }", raw);
  }
  return databases.map((item, index) => parseInfo(item, `list[${index}]`));
}

async function readRequiredJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) contractError(operation, "expected a JSON body", undefined);
  try {
    return JSON.parse(text);
  } catch {
    contractError(operation, "response body is not valid JSON", text);
  }
}

async function dataPlaneRequest(
  transport: Transport,
  url: string,
  init: RequestInit,
  errorPrefix: string,
): Promise<Response> {
  return ensureOk(await transport.fetch(url, init), errorPrefix);
}

// ----- The handle -----

/** Bind an index's data-plane operations to its own URL. */
function bindIndex(info: SearchIndexInfo, transport: Transport): SearchIndex {
  return {
    ...info,

    async upsert(documents, opts) {
      validateSearchDocumentInputs(documents);
      const indexName = resolveSearchIndexName(opts);
      // The gateway forwards the array body verbatim to the current provider.
      // Logical usage is per request, so callers should batch documents.
      await dataPlaneRequest(
        transport,
        `${info.url}/upsert/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(documents),
        },
        `Failed to upsert into search index '${info.id}'`,
      );
    },

    async query(input, opts) {
      validateSearchQueryInput(input);
      const indexName = resolveSearchIndexName(opts);
      // Public `limit` maps to the provider's raw `topK`; query reads request
      // their payloads explicitly instead of relying on provider defaults.
      const body: Record<string, unknown> = {
        query: input.query,
        topK: input.limit ?? DEFAULT_SEARCH_INDEX_QUERY_LIMIT,
        includeData: true,
        includeMetadata: true,
      };
      if (input.reranking != null) body.reranking = input.reranking;
      if (input.filter != null) body.filter = input.filter;

      const response = await dataPlaneRequest(
        transport,
        `${info.url}/search/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `Failed to query search index '${info.id}'`,
      );
      return parseQueryResponse(await readRequiredJson(response, "query"));
    },

    async range(input, opts) {
      const indexName = resolveSearchIndexName(opts);
      const body = normalizeSearchIndexRangeInput(input);

      const response = await dataPlaneRequest(
        transport,
        `${info.url}/range/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `Failed to range search index '${info.id}'`,
      );
      return parseRangeResponse(await readRequiredJson(response, "range"));
    },

    async fetchDocuments(ids, opts) {
      validateSearchDocumentIds(ids, "fetchDocuments");
      validateSearchIndexIncludeOptions(opts);
      const indexName = resolveSearchIndexName(opts);
      const body: Record<string, unknown> = { ids };
      if (opts?.includeMetadata != null)
        body.includeMetadata = opts.includeMetadata;
      if (opts?.includeData != null) body.includeData = opts.includeData;
      const response = await dataPlaneRequest(
        transport,
        `${info.url}/fetch/${indexName}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `Failed to fetch documents from search index '${info.id}'`,
      );
      return parseFetchResponse(
        await readRequiredJson(response, "fetchDocuments"),
        ids,
      );
    },

    async deleteDocuments(ids, opts) {
      validateSearchDocumentIds(ids, "deleteDocuments");
      const indexName = resolveSearchIndexName(opts);
      await dataPlaneRequest(
        transport,
        `${info.url}/delete/${indexName}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        },
        `Failed to delete documents from search index '${info.id}'`,
      );
    },
  };
}

// ----- Control-plane operations -----

/**
 * Create a search index and return its bound handle. Omit `ttl` for a
 * long-lived index — expired indexes are reaped. Failed requests throw
 * {@link SearchIndexHttpError} (422 when the per-account index limit is hit).
 */
export async function create(
  input: CreateSearchIndexInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  validateCreateSearchIndexInput(input);
  const body: Record<string, unknown> = { name: input.name };
  if (input.region !== undefined) body.region = input.region;
  if (input.ttl !== undefined) body.ttl = input.ttl;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/search/indexes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to create search index",
  );
  return bindIndex(
    parseInfo(await readRequiredJson(res, "create"), "create"),
    transport,
  );
}

/** Retrieve a search index by id and return its bound handle. */
export async function get(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  validateSearchIndexId(id);
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
    ),
    `Failed to get search index '${id}'`,
  );
  return bindIndex(
    parseInfo(await readRequiredJson(res, "get"), "get"),
    transport,
  );
}

/**
 * List your active search indexes as bound handles. Read-only — useful for
 * resolving an index by name before operating on it:
 *
 *   const idx = (await searchindex.list()).find((i) => i.name === "docs-corpus");
 */
export async function list(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex[]> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/search/indexes`),
    "Failed to list search indexes",
  );
  return parseListResponse(await readRequiredJson(res, "list")).map((info) =>
    bindIndex(info, transport),
  );
}

/** Update an index's `name` and/or `expiresAt`; returns the updated handle. */
export async function update(
  id: string,
  input: UpdateSearchIndexInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SearchIndex> {
  validateSearchIndexId(id);
  validateUpdateSearchIndexInput(input);
  const body: Record<string, unknown> = {};
  if (input?.name !== undefined) body.name = input.name;
  if (input?.expiresAt !== undefined) body.expiresAt = input.expiresAt;

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    `Failed to update search index '${id}'`,
  );
  return bindIndex(
    parseInfo(await readRequiredJson(res, "update"), "update"),
    transport,
  );
}

/**
 * Delete a whole index and ALL its data. For deleting individual documents use
 * the handle's `deleteDocuments`. Exported as `delete`:
 * `await searchindex.delete(id)`.
 */
async function deleteIndex(
  id: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  validateSearchIndexId(id);
  await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/search/indexes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
    `Failed to delete search index '${id}'`,
  );
}

export { deleteIndex as delete };
