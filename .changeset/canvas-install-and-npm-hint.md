---
"@sapiom/agent-core": patch
"@sapiom/mcp": patch
"@sapiom/harness": patch
---

Install a new agent's dependencies on scaffold, and turn the Canvas's "Could not resolve …" render error into an actionable "run npm install" hint

The Canvas step-graph extraction (`check` / `loadDefinition`) esbuild-bundles a project's `index.ts` resolving its imports — `@sapiom/agent`, `zod`, … — from the project's own `node_modules`. A newly-scaffolded (or freshly-cloned) agent whose deps were never installed therefore failed its very first, unprompted Canvas render with a raw esbuild wall (`Could not resolve "@sapiom/agent" … Could not resolve "zod"`), which the failure panel relayed verbatim.

Two fixes:

- `scaffold()` gains an opt-in `installDependencies` flag (returned as `dependenciesInstalled`), and the `sapiom_dev_agents_scaffold` MCP tool — the Studio's create path — now passes it, so a new agent opens with a working Canvas. Best-effort and non-fatal: a missing/offline npm still yields a successful scaffold. The `installProjectDependencies` helper (previously demo-only inside the harness's example seed) now lives in `@sapiom/agent-core` and is shared by both.
- `check` and `loadDefinition` now route bundle failures through `describeBundleFailure`, which detects the "no `node_modules` + unresolved import" case and returns `Dependencies are not installed. Run \`npm install\` in <dir>, then try again.` (preserving the raw esbuild detail). Every other bundle failure's message is unchanged.
