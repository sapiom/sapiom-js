---
"@sapiom/harness": minor
---

Detect literal direct agent `run` and `launch` relationships in Agent Studio Project graphs, distinguish blocking and asynchronous modes, and report dynamic targets without drawing misleading connectors.

The syntax-only detector recognizes the exact `ctx.sapiom.agents` form plus proven named `agents` aliases and legacy `orchestrations.launch` imports from `@sapiom/tools`. Unlike the previous text match, unrelated local objects, custom context names, destructured namespaces, namespace imports, and optional chains are not inferred. The existing per-agent Canvas remains launch-only, so blocking `agents.run` calls retain their existing capability chip there until that Canvas supports blocking relationship nodes.

TypeScript is now a Harness runtime dependency, constrained to the tested 5.9 compiler-API band, because published Harness and desktop servers execute the syntax parser locally.
