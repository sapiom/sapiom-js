---
"@sapiom/tools": minor
---

Add `SAPIOM_SERVICES_BASE` — one env var that re-homes every capability gateway at once.

Each capability resolved its base URL independently (`SAPIOM_<CAP>_URL || "https://<subdomain>.services.sapiom.ai"`). Pointing the whole SDK at a non-prod stack meant setting a separate variable for every capability, and any capability you forgot silently fell back to prod. Now all capabilities resolve through `resolveServiceUrl(subdomain, override)`:

1. an explicit per-capability `SAPIOM_<CAP>_URL` still wins (unchanged, back-compat);
2. else `SAPIOM_SERVICES_BASE` re-homes every capability by swapping the host suffix and preserving the subdomain (e.g. `SAPIOM_SERVICES_BASE=http://services.localhost:3100` → `http://fal.services.localhost:3100`, `http://git.services.localhost:3100`, …);
3. else the production default `https://<subdomain>.services.sapiom.ai` (unchanged).

Accepts a full origin or a bare `host[:port]` (assumed https). Production behavior is unchanged when `SAPIOM_SERVICES_BASE` is unset.
