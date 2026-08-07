---
"@sapiom/tools": minor
---

Add the `searchindex` namespace (`ctx.sapiom.searchindex`) and `search.map()`
(SAP-2255).

`searchindex` covers the complete provisioned-search surface behind the Sapiom
gateway — control plane `create`/`get`/`list`/`update`/`delete`, with
`create`/`get`/`list` returning a bound `SearchIndex` handle carrying the
data-plane operations (`upsert`/`query`/`range`/`fetchDocuments`/
`deleteDocuments`) against the index's own Sapiom data-plane URL. Write inputs
require `{ id, content, metadata? }`; read results preserve omitted content and
metadata. `range` defaults to a valid first page (`cursor: "0"`, `limit: 100`).
Malformed successful envelopes fail closed with `SearchIndexContractError`.

The public contract names provider-invisible meters: `searchindex.index`,
`searchindex.upsert`, `searchindex.query`, `searchindex.query_rerank`,
`searchindex.range`, `searchindex.fetch_documents`, and
`searchindex.delete_documents`.

`search.map({ url })` exposes gateway-direct site mapping with structured
`{ links: [{ url, title?, description? }] }` output. Malformed successful map
responses fail closed with `SearchContractError`.

Both are wired into the `Sapiom` client interface, `bind()`, the barrel, the
`./search-index` subpath export, and a stateful, validation-faithful stub client
so `run_local` exercises upsert → query/range/fetch/delete flows.
