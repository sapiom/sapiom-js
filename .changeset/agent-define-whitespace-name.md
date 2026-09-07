---
"@sapiom/agent": patch
---

Reject whitespace-only agent names in `defineAgent`.

The authoring contract requires a non-empty name, but the check used truthiness (`if (!def.name)`), so `"   "` passed validation. Names are now rejected unless they contain non-whitespace characters after trim, matching how blank resource handles are treated in the same package.
