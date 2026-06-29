---
"@sapiom/tools": patch
---

Add `sandboxes.get` and `sandboxes.list` — read-only access to a sandbox's metadata and current status.

```ts
import { sandboxes } from "@sapiom/tools";

const info = await sandboxes.get("build-01"); // { status, url, tier, expiresAt, … }
const all = await sandboxes.list();
```

Both return plain `SandboxInfo` metadata (status, URL, tier, TTL), not a live handle — use `attach(name)` to operate on a sandbox. Handy for checking readiness, or whether a sandbox already exists before creating one. `get` throws if the named sandbox does not exist.
