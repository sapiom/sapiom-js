---
"@sapiom/agent": minor
---

Add `resolveResourceHandle(input, { fallback, key? })` — the single seam a step reads its chosen resource handle from.

A template declares which managed resource it opens (its `resources[].handle` in `template.json`) and Sapiom provisions it at deploy, but that declaration is a build-time artifact that never reaches step code. Templates therefore hardcoded the handle (`const DEFAULT_DB_HANDLE = "…"`) and re-read it in every step, so the declared handle and the opened handle were two independent literals that could drift, and nothing let a run open a different one.

`resolveResourceHandle` reads the handle injected into the run's entry input — the seam the setup panel's settings (and, later, its "use my own" resource picker) drive — falling back to the code-side default that keeps a zero-setup run working. It is read-only and never throws, so it is safe to call from an entry step. This is the mechanism a declared / provisioned / picked handle flows through to become the one the run actually opens.
