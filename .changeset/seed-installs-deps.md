---
"@sapiom/harness": patch
---

Install the seeded sample project's dependencies on first creation, so the Canvas step-graph renders on first view instead of failing with "Could not resolve @sapiom/agent / zod". `seedExampleProject` now runs a best-effort `npm install` right after scaffolding (before the initial commit, keeping the gitignored `node_modules` out of history); it's non-fatal (missing/offline npm falls back to the existing "ask your agent to fix it" Canvas prompt) and skippable via the new `installDependencies` option (default true; tests pass false to stay offline). Adds `dependenciesInstalled` to `SeedExampleProjectResult`.
