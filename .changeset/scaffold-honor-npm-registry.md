---
"@sapiom/orchestration-core": minor
"@sapiom/create-orchestration": minor
---

Scaffold honors `npm_config_registry` / `@scope:registry` when resolving the
`@sapiom/*` versions to pin

Version resolution previously hardcoded the public npm registry, so a scaffold
always pinned public-npm `latest` even when the environment pointed at a
different registry. It now resolves `latest` from the same registry a plain
`npm install` would (a scoped `@<scope>:registry` wins over the global
`npm_config_registry`, which wins over the public default). When that registry
is non-default, the scaffolded project also gets a matching `.npmrc` so its
pinned versions are installable. This makes a local registry dev loop work
end-to-end with no manual pin edits; default scaffolds are unchanged.
