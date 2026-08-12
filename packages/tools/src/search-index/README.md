# `searchindex` — provisioned search indexes with auto-embedding

Create an index, upsert JSON documents, and query them with combined full-text
and semantic search. Documents are auto-embedded server-side, so there is no
embedding pipeline to run. The backing provider is an implementation detail;
the public contract is the `searchindex` namespace and its logical meters.

This is distinct from `search` (web search, page scrape, and email lookup):
`searchindex` is a data store you fill and query.

## Usage

```ts
import { searchindex } from "@sapiom/tools"; // ambient auth
// or: ctx.sapiom.searchindex inside a workflow step
// or: createClient({ apiKey }).searchindex

// Control plane — create/list/get/update/delete indexes.
const idx = await searchindex.create({ name: "docs-corpus" }); // no ttl: long-lived

// Data plane — the returned handle is bound to the index's own Sapiom URL.
await idx.upsert([
  {
    id: "getting-started",
    content: { title: "Get Started", body: "…" }, // auto-embedded
    metadata: { url: "https://docs.example.com/", contentHash: "…" },
  },
]);

const hits = await idx.query({ query: "how do I authenticate?", limit: 3 });
// hits: [{ id, content?, metadata?, score? }] — best first

// Reconciliation starts at cursor "0" with a bounded default page size of 100.
// Range/fetch payload fields are omitted unless their include flag is true.
let cursor: string | null = null;
do {
  const page = await idx.range({
    cursor: cursor ?? undefined,
    includeMetadata: true,
  });
  // page.documents[].metadata?.contentHash → diff against fresh hashes
  cursor = page.nextCursor;
} while (cursor);

await idx.deleteDocuments(["stale-doc"]);

// Resolve an existing index by name. The canonical wire envelope is
// `{ databases: [...] }`; the SDK unwraps it and returns bound handles.
const again = (await searchindex.list()).find((i) => i.name === "docs-corpus");
```

## Semantics worth knowing

- `content` is embedded; `metadata` is not. Put searchable text in `content`
  and bookkeeping such as URLs, hashes, and timestamps in `metadata`.
- `ttl` means reaping. It must be greater than zero and no more than 30 days.
  Omit it for long-lived indexes; `update(id, { expiresAt })` adjusts expiry.
- `region` can be `null` on a read when a legacy record has no region.
- `indexName` is a namespace within the index (default `"default"`).
- `query()` defaults to 5 results; public `limit` is sent as the data-plane
  `topK` field.
- `range()` defaults to `{ cursor: "0", limit: 100 }`; pass each non-null
  `nextCursor` to the next call.
- Range and fetch results always contain `id`. `content` and `metadata` remain
  absent unless requested, so omitted data cannot be mistaken for `{}`.
- `delete(id)` destroys an entire index. Use `deleteDocuments(ids)` for
  document-level deletion.
- HTTP failures throw `SearchIndexHttpError`. A successful HTTP response with a
  malformed list/query/range/fetch envelope throws `SearchIndexContractError`
  instead of masquerading as an empty index.
- List responses canonically use `{ databases: [...] }`. The SDK retains a bare
  array only as an explicitly documented pre-envelope compatibility shape; any
  other object envelope throws `SearchIndexContractError`.
- Query/fetch responses canonically use `{ result: [...] }`; legacy bare arrays
  remain supported. Range canonically uses
  `{ result: { nextCursor, vectors } }`; the documented Search SDK page
  `{ nextCursor, documents }` remains supported. Other shapes fail closed.

## Logical meters

The customer contract is provider-invisible. The effective plan/catalog is the
authority for allowance and price; each data-plane call consumes one request,
regardless of batch size.

| SDK operation                | Logical meter                  | Current catalog unit rate |
| ---------------------------- | ------------------------------ | ------------------------: |
| active index allocation      | `searchindex.index`            |           plan allocation |
| `upsert`                     | `searchindex.upsert`           |                 $0.000050 |
| `query`                      | `searchindex.query`            |                 $0.000050 |
| `query({ reranking: true })` | `searchindex.query_rerank`     |                 $0.001050 |
| `range`                      | `searchindex.range`            |                 $0.000050 |
| `fetchDocuments`             | `searchindex.fetch_documents`  |                 $0.000050 |
| `deleteDocuments`            | `searchindex.delete_documents` |                 $0.000050 |
