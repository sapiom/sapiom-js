# Agent Map

Shared Agent Map contracts for Sapiom Studio and local integrations. Requires Node 18 or later for Node consumers; the root export and `@sapiom/agent-map/project-id` are browser-safe.

```ts
import type { AgentMapGraph } from "@sapiom/agent-map";
import { isStudioProjectId } from "@sapiom/agent-map/project-id";
```

Studio installs this package as a dependency. Saved project identity, state paths, and current Studio tools remain unchanged.

Before merging this package's introduction, configure its npm Trusted Publisher for `sapiom/sapiom-js` and `.github/workflows/publish.yml`. The workflow publishes unpublished package versions on pushes to `main`, including the first version of a new package.
