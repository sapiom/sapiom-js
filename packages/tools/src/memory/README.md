# memory

Tenant-scoped long-term memory backed by the Sapiom memory service.

```typescript
import { createClient } from "@sapiom/tools";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const { id } = await sapiom.memory.append({
  content: "User prefers dark mode.",
  namespace: "user-42",
  metadata: { source: "preference-survey", user_theme: "dark" },
});

const { results } = await sapiom.memory.recall({
  query: "ui preferences",
  namespace: "user-42",
  topK: 5,
});

await sapiom.memory.forget({ ids: [id], namespace: "user-42" });
await sapiom.memory.drop("user-42");
```

Ambient import works too: `import { memory } from "@sapiom/tools"`.

## Operations

| Method            | Notes                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `append(input)`   | Writes one memory into a namespace. Metered.                                                                |
| `recall(input)`   | Searches one namespace by `query`; supports `strategy`, temporal `weight`, and metadata `filter`. Metered.  |
| `forget(input)`   | Hard-deletes memories by id. Blind-idempotent: already-gone ids still resolve successfully. Free.           |
| `drop(namespace)` | Deletes an entire namespace. Idempotent. Free.                                                              |

## Namespaces

`namespace` is the isolation boundary: reads only ever see one namespace, and
`drop` deletes one namespace wholesale.

**Default to a namespace per agent, per user, or per project.** A namespace has
bounded capacity, so prefer many small namespaces over one large one. Put
subsets into a single shared namespace — distinguished by `metadata` and
narrowed with a recall `filter` — only when a single recall must span those
subsets. For better performance, use a namespace instead if you'd always
filter to one value.

```typescript
// Preferred: one namespace per user
await sapiom.memory.append({ content, namespace: `user-${userId}` });

// Only when one recall must span subsets: shared namespace + metadata + filter
await sapiom.memory.append({
  content,
  namespace: "support-team",
  metadata: { user_id: userId },
});
await sapiom.memory.recall({
  query,
  namespace: "support-team",
  filter: { user_id: userId },
});
```

## Metadata

Metadata you WRITE is flat: a map of identifier keys to string, number, or
boolean values (arrays and nulls are rejected with `invalid_metadata`). Express
hierarchy through key naming conventions (e.g. `env_prod`, `user_theme`) rather
than nesting. Keys start with a letter and must not contain `.`. Key count and
sizes are bounded (enforced server-side).

Every metadata leaf is a scalar. Filter values match exactly, or against a set
with `{ in: [...] }`. For better performance, use `namespace` for a key you'd
filter on every recall — metadata suits optionally-filtered dimensions.

## Limits

| Field                     | Limit                                         |
| ------------------------- | --------------------------------------------- |
| `content`                 | ≤ 32,000 characters                           |
| `namespace`               | 1–100 characters; letters, digits, `-`, `_`   |
| `query`                   | ≤ 4,096 characters                            |
| `topK`                    | 1–50 (default 5)                              |
| `metadata` keys           | ≤ 20 per memory                               |
| `metadata` key            | ≤ 64 bytes; matches `^[a-zA-Z]\w*$`           |
| `metadata` string value   | ≤ 512 characters                              |
| `filter` keys             | ≤ 20                                          |
| `filter` `{ in: [...] }`  | ≤ 64 values                                   |
| `forget` ids              | ≤ 100 per call                                |
| `weight.halfLifeDays`     | 1–365 (default 30)                            |

## Contract Notes

- Memory is durable knowledge, not chat history: `recall` ranks by relevance,
  never by recency — it is not a way to page through recent turns. Keep last-N
  context in your own store.
- `append` is append-log only; it never mutates existing memories.
- Secret-like content is rejected before anything is stored:
  `MemoryHttpError` status `400`, body `code: "secret_detected"`.
- `occurredAt` is optional event time, distinct from `createdAt` (ingestion
  time); it drives `weight.temporal` recall decay.
- `recall` defaults to `strategy: "semantic"` and `topK: 5`; `"keyword"` and
  `"hybrid"` are also supported. Scores are a relevance ranking weight — higher
  is more relevant; compare only within one result set.
- Caller-safe validation failures surface as `400` with a stable `body.code`
  (`invalid_metadata`, `invalid_filter`, `secret_detected`). Other request-shape
  violations (e.g. oversized content) surface as a plain `400` without a stable
  code. Infrastructure failures surface as generic `502`/`503`/`504` — details
  are logged server-side, never returned to the caller.
- Non-2xx responses throw `MemoryHttpError` with `status` and parsed `body`.

The base URL follows the shared service resolver: `SAPIOM_MEMORY_URL`, then
`SAPIOM_SERVICES_BASE`, then `https://memory.services.sapiom.ai`.
