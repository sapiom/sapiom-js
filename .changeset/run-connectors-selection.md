---
"@sapiom/tools": minor
---

Coding runs and model runs take an optional `connectors` list: the slugs of the connections the run may use, sent on the wire as `connectors`. This is how you decide which agent gets which connection. Leaving it unset is unchanged behavior — the key never reaches the wire and every ready connection attaches. `[]` attaches none. A slug that isn't a ready connection gets the run refused with HTTP 400 `connectors_unavailable`. A platform release that predates per-run selection ignores the field and attaches every connection, as before.
