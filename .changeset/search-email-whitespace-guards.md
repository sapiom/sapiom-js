---
"@sapiom/tools": patch
---

`search.emailSearch`'s client-side "no network on invalid" guards (`findEmail`, `verifyEmail`, `domainSearch`) used truthiness checks (`Boolean(...)` / `if (!input.email)`), so a whitespace-only string like `"   "` looked "present" and reached the network. Sibling capabilities (speech, domains) already reject via `typeof s === "string" && s.trim() !== ""`; the email search guards now match that contract.
