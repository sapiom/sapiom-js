---
"@sapiom/core": patch
---

Fix `setHeader` and `removeHeader` coercing unrelated `undefined`-valued
headers into empty strings

Both helpers accept `Record<string, string | string[] | undefined>`, where
`undefined` represents an omitted header in Node/HTTP-style maps. When copying
unrelated headers, the previous `val || ""` fallback turned any `undefined`
value into `""`, so an absent header (e.g. `Authorization: undefined`) came
back as a present-but-empty header. Downstream HTTP clients could then send an
empty header instead of omitting it.

Unrelated headers with an `undefined` value are now skipped while copying, so
they stay omitted in the returned header map, matching the documented type.
