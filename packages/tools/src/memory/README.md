# memory

Tenant-scoped long-term memory over the Sapiom memory gateway.

```typescript
import { createClient } from "@sapiom/tools";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const { id, decision } = await sapiom.memory.append({
  content: "User prefers dark mode.",
  scope: "user",
  metadata: { source: "preference-survey" },
});

const { results } = await sapiom.memory.recall({
  query: "ui preferences",
  scope: "user",
  topK: 5,
});

const record = await sapiom.memory.get(id);
await sapiom.memory.forget(id);
```

Ambient import works too: `import { memory } from "@sapiom/tools"`.

## Operations

| Method                 | Notes                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `append(input)`        | Writes a memory or returns an existing near-duplicate. Success decisions are `"ADDED"` or `"NOOP"`.   |
| `recall(input)`        | Searches memories by `query`; supports `strategy`, temporal `weight`, metadata `filter`, and `store`. |
| `sweep(input?)`        | Neon-only compaction. `dryRun` defaults to `true`; pass `false` to delete selected rows.              |
| `get(id, options?)`    | Fetches one memory. Pass `options.store` when the write used a non-default store.                     |
| `forget(id, options?)` | Hard-deletes one memory. Idempotent: already-gone rows still resolve successfully.                    |

## Store Identity

`store` selects the physical store. Reads must pass the same selector used by the matching write.

```typescript
export interface MemoryStore {
  backend?: "neon-pgvector" | "upstash-vector";
  embedder?: {
    provider: string;
    model: string;
  };
  namespace?: string;
}
```

Pass the same `store` to reads/deletes that was used when writing. Omit `store` for the v0 default: Neon pgvector, your default namespace, and OpenRouter `openai/text-embedding-3-small`.

## Contract Notes

- `append` is append-log only. It never mutates or supersedes existing rows.
- Secret-like content or metadata is rejected before embedding with `MemoryHttpError` status `400` and body fields such as `error: "SecretDetected"` and `decision: "REJECTED"`.
- `occurredAt` is optional event time. When omitted, the backend stores `null`; temporal recall falls back to `createdAt`.
- `recall` defaults to `strategy: "cosine"`, `topK: 5`, and `minSimilarity: 0`.
- `strategy: "keyword"` is Neon-only; requesting it on `upstash-vector` returns `400`.
- `sweep` is Neon-only; for Upstash-backed stores, call `forget` on specific ids.
- `upstash-vector` is experimental in v0. Append, cosine recall, get, and forget work; native Upstash embedding, keyword recall, and sweep are not part of this SDK contract yet.
- The gateway is authoritative for embedder support. v0 currently supports OpenRouter-backed embedding providers/models and returns `400` for unsupported selectors.
- `filter` is a hard metadata filter. Neon uses JSONB containment; Upstash supports scalar equality filters.
- After the route gate succeeds, recall degrades child infra, billing, rate-limit, and timeout failures to `{ results: [], count: 0 }`. Bad requests, missing identity, and ownership failures still throw.
- Every route has the near-zero x402 minimum gate. Embedding and store operations are child costs billed to the run.
- Non-2xx responses throw `MemoryHttpError` with `status` and parsed `body`.

The base URL follows the shared service resolver: `SAPIOM_MEMORY_URL`, then `SAPIOM_SERVICES_BASE`, then `https://memory.services.sapiom.ai`.
