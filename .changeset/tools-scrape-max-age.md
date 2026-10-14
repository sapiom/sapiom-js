---
"@sapiom/tools": minor
---

`search.scrape()` accepts an optional `maxAge` (milliseconds): the oldest cached copy of the page to accept. `maxAge: 0` reads the page fresh instead of returning a cached copy up to 2 days old. Calls without `maxAge` send the same request as before.

Requires deployed SAP-4042 backend (Sapiom #5752). Against an older backend the field is ignored and the cached copy is returned.
