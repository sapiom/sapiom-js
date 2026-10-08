# Agent Map

Studio project identity for Sapiom Studio and local integrations: the project catalog, root bindings, the current-workspace preference, and the session principal. Requires Node 18 or later for Node consumers; the root export and `@sapiom/agent-map/project-id` are browser-safe.

```ts
import type { StudioProjectSummary } from "@sapiom/agent-map";
import { isStudioProjectId } from "@sapiom/agent-map/project-id";
```

The agent map itself is no longer stored. `sapiom_dev_map` in `@sapiom/mcp` computes it from code on every call, and Studio draws what that tool returns. The stored map (versions, proposals, implementation bindings, initialization records) was removed; existing `~/.sapiom/harness/agent-map/projects/` folders are ignored and can be deleted.

## Project catalog

Studio owns discovery and calls the catalog's `reconcile` with the complete root inventory. Explicit registration uses `create` / `addRootBinding` under the catalog lock; additional roots must be registered to reuse a project across worktrees.

`resolveIdentityForPath` throws `storage_unavailable` when a root cannot be read, so callers cannot treat uncertain ownership as unregistered. The browser-safe `@sapiom/agent-map/project-roots` matcher normalizes `.` and `..` lexically before containment and depth comparison; hosts must resolve symlinks before calling it directly.

## Exports and verification

Exports under `/node/*` provide the catalog, file locks, state paths and hashing for trusted host code. All other exports are browser-safe contracts and pure helpers.

Run `pnpm --filter @sapiom/agent-map test:package` after installing dependencies. It packs and installs the library outside the workspace, verifies every export and declaration, bundles all browser exports without tree shaking, and exercises the catalog without Studio or MCP installed. The check rejects Studio/MCP anywhere in the installed dependency graph.
