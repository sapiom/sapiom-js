---
"@sapiom/tools": patch
---

Reject whitespace-only inputs in search email client guards (`findEmail`, `verifyEmail`, `domainSearch`).

These guards already blocked empty strings so invalid lookups failed before any network call. Truthiness checks still treated `"   "` as present, so whitespace-only domain/email/name values reached the capability endpoint. Presence now requires a non-empty trimmed string, matching speech and content-generation guards in the same package.
