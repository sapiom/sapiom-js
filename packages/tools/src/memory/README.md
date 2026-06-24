# memory

Tenant-scoped long-term memory backed by the Sapiom memory gateway — a hybrid
vector + full-text store, one per owner. The same memory capability your agents
call over MCP, callable directly from your code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Write a memory. Optionally scope it and attach opaque metadata.
const { id, decision } = await sapiom.memory.append({
  content: "User prefers dark mode.",
  scope: "user", // defaults to "default"
  metadata: { source: "preference-survey" },
});

// Search by natural language (hybrid vector + full-text).
const { results } = await sapiom.memory.recall({
  query: "ui preferences",
  scope: "user", // omit to search every scope for your owner
  topK: 5, // 1–50, default 10
});

// Fetch one record by id (includes superseded records).
const record = await sapiom.memory.get(id);

// Forget (hard-delete) a memory — the row is erased (GDPR / right-to-be-forgotten).
await sapiom.memory.forget(id);
```

Ambient import works too: `import { memory } from "@sapiom/tools"`.

## Operations

| Method | What it does |
|---|---|
| `append(input)` | Embed and store `content`; returns the written (or echoed) record + a `decision`. |
| `recall(input)` | Hybrid vector + full-text search; returns the top-K active matches. |
| `get(id)` | Fetch a single record by id (active or superseded). |
| `forget(id)` | Hard-delete a record (the row is erased — GDPR / right-to-be-forgotten). |

## Supersession & the `decision` (dedup on append)

`append()` embeds the content and checks for a near-duplicate in the same scope,
then reports — never silently — one of three `decision` values:

| `decision` | When | Result |
|---|---|---|
| `"ADDED"` | No near-duplicate existed | A new memory is written; nothing superseded. |
| `"SUPERSEDED"` | Nearest prior is **cosine ≥ 0.80** similar | A new memory is written and the prior is superseded; `supersededId` points to it (with `similarityScore`). |
| `"NOOP"` | Byte-identical content (exact match or cosine ≈ 1.0), or an `idempotencyKey` re-submit | The existing memory is echoed (`id` is *its* id) and **nothing is written**. |

Pass an **`idempotencyKey`** (1–255 chars) to make a retry safe: re-submitting with
the same key within the same owner + scope returns `"NOOP"` with the existing
memory, so a duplicated call never writes twice.

> A secret caught by the admission gate is **not** a `decision` — it comes back as a
> `400` (`MemoryHttpError`) whose body carries `decision: "REJECTED"` (see Gotchas).

## Recall semantics

- Results are ranked by `combinedScore` (a weighted blend of `vectorScore` and
  `textScore`), highest first, and only **active** memories are returned.
- `minSimilarity` (0–1) drops matches below the threshold; `topK` (1–50, default
  10) caps the count.
- An empty list is a normal response — it means nothing matched, or no memory
  store has been provisioned for your owner yet (not an error).

## Scoping & tenancy

Every memory is scoped to your owner key (derived from the credential) and a
`scope` label (alphanumeric + hyphens/underscores, ≤ 100 chars, defaulting to
`"default"`). Cross-owner access is impossible — you only ever see your own
memories.

## Gotchas

- **`append` rejects secrets.** Content and metadata pass through an admission
  gate; a detected API key / token / password is rejected with a `400`
  (`MemoryHttpError`, `body.error === "SecretDetected"`, `body.decision === "REJECTED"`).
  Don't store credentials. `REJECTED` is *not* an `AppendResult.decision` — it only
  ever rides back on the error body.
- **`forget` is a hard delete, _not_ idempotent.** It erases the row outright
  (distinct from supersession, which only supersedes). A second forget of an
  already-deleted id — like an unknown or cross-owner id — throws `MemoryHttpError`
  with `status: 404` (there is no `409` "already superseded" state for forget).
- **`metadata` is opaque.** It's stored and returned verbatim but never indexed or
  searched. Max 10 KB JSON-serialized. `content` is capped at 32,000 chars,
  `query` at 4,096.
- **Non-2xx responses throw `MemoryHttpError`** (carries `status` + parsed
  `body`), exported from `@sapiom/tools`. `append` costs $0.002/call and `recall`
  $0.001/call against your tenant balance; `get`/`forget` are free for identified
  callers.
- **Base URL** defaults to the production gateway; override with the
  `SAPIOM_MEMORY_URL` env var (e.g. to target a staging gateway).
