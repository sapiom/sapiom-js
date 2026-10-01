---
"@sapiom/agent-core": patch
"@sapiom/cli": patch
"@sapiom/tools": patch
---

The platform-rules stamp is now written into a project's `AGENTS.md` when it is scaffolded, from the release constants in `@sapiom/agent-core`, instead of being hard-coded in every template and gallery example. Scaffold output is unchanged: a new project still carries a concrete `<!-- sapiom-authoring-rules release=… digest=… -->` and `sapiom_dev_agents_check` still warns when it differs from the served copy. Gallery examples, `examples/AUTHORING.md` and the `@sapiom/tools` JSDoc keep the pointer to the served rules but no longer record a release, so a content release touches the two constants and the four skill copies only.
