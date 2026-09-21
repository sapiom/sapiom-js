# Agent Map

Shared Agent Map contracts for Sapiom Studio and local integrations. Requires Node 18 or later for Node consumers; the root export and `@sapiom/agent-map/project-id` are browser-safe.

```ts
import type { AgentMapGraph } from "@sapiom/agent-map";
import { isStudioProjectId } from "@sapiom/agent-map/project-id";
```

Studio installs this package as a dependency. Saved project identity, state paths, and current Studio tools remain unchanged.

Before merging this package's introduction, configure its npm Trusted Publisher for `sapiom/sapiom-js` and `.github/workflows/publish.yml`. The workflow publishes unpublished package versions on pushes to `main`, including the first version of a new package.

## Project lookup

Resolve a registered repository or authenticated Studio project against the same catalog:

```ts
import { resolveAgentMapProject } from "@sapiom/agent-map/node/project-resolution";

const scope = await resolveAgentMapProject({
  kind: "repository",
  cwd: process.cwd(),
  // stateRoot: "~/.sapiom/harness", // override for a custom Studio state root
});
```

Results are `resolved`, `unregistered`, `ambiguous`, or `unavailable`. A resolved result includes private filesystem paths for the host; do not include those paths in public map payloads. A repository selector (`projectId`) disambiguates registered root bindings. Trusted hosts can instead pass `{ kind: "host", projectId, stateRoot }` after authenticating scope.

Lookup is side-effect-free: it never registers a project or creates a map. Storage remains `<stateRoot>/agent-map/projects/<projectId>/workspace.json`; the default state root is `~/.sapiom/harness`.

Repository lookups refresh working-directory identity asynchronously on every call. Each catalog instance caches root probes for at most one second, including failed probes, so repeated session/restore lookups avoid scanning every root again. Root symlink changes are visible after that interval; standalone resolution creates a fresh catalog. The browser-safe `@sapiom/agent-map/project-roots` matcher normalizes `.` and `..` lexically before containment and depth comparison; hosts must resolve symlinks before calling it directly.

Missing descendants can resolve through their nearest existing ancestor. Permission failures, symlink loops, and other filesystem errors produce `unavailable` for the working directory or a root whose lexical or last-known canonical path contains it. Unreadable unrelated roots are skipped. The Studio compatibility method `resolveIdentityForPath` throws `storage_unavailable` for these failures so callers cannot treat uncertain ownership as unregistered.

Studio owns discovery and calls the shared catalog's `reconcile` with the complete root inventory. A standalone lookup must never call `reconcile([cwd])`, which would mark other roots missing. Explicit registration uses catalog `create`/`addRootBinding` methods under the existing catalog lock; additional roots must be registered to reuse a project across worktrees.

## Exports and verification

Exports under `/node/*` provide storage, authoring, catalog lookup, hashing, and version services for trusted host code. All other exports are browser-safe contracts, schemas, validation, codecs, or pure helpers. Use explicit subpaths rather than importing unpublished internal files.

Map writes preserve the complete planning aggregate (including plans, briefs, receipts, and tombstones); initialization records and implementation bindings remain separate sidecars. Hosts supply authenticated actor/project scope to the authoring service.

Run `pnpm --filter @sapiom/agent-map test:package` after installing dependencies. It packs and installs the library outside the workspace, verifies every export and declaration, bundles all browser exports without tree shaking, and exercises authoring, restart, replay, and project lookup without Studio or MCP installed. Runtime regression suites remain in Harness and import this package.

The check rejects Studio/MCP anywhere in the installed dependency graph, including aliases and optional dependencies, and in both workspace and installed browser bundle paths. Negative fixtures exercise these checks before the tarball smoke test.

Package tests run on Node 18; the repository and Studio CI matrix covers Node 20/22, browser journeys, and Linux packaged Desktop smoke. New MCP tool activation is handled separately from this library.
