---
"@sapiom/agent-core": patch
---

Archive shared code instead of falling back to git for it.

An agent importing from outside its own directory now uploads like any other: the
archive is rooted at the lowest directory containing everything the entry
imports, and the entry is declared relative to that root so the relative import
still resolves after the server extracts it. Only the files the entry actually
reaches are packed, so a higher root makes paths longer, never archives bigger.

A flat agent is unaffected — no manifest is written when the entry is already
`index.ts` at the root, keeping existing archives byte-identical and their
digests stable, so redeploying unchanged code still stores nothing.

`UNSUPPORTED_LAYOUT` now means only that the imports have no common parent short
of the filesystem root; the git fallback remains for that case.
