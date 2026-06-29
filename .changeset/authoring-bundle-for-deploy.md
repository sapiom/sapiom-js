---
"@sapiom/orchestration-core": patch
---

Improve the initial git + deploy experience for workflow authoring. Adds `bundleForDeploy` — a local, no-network bundler that inlines local/shared source and externalizes npm dependencies — and smooths first-time git init / deploy so a fresh workflow project deploys cleanly.

```ts
import { bundleForDeploy } from "@sapiom/orchestration-core";

const bundle = await bundleForDeploy(/* … */);
```
