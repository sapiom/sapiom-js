---
"@sapiom/cli": patch
"@sapiom/agent-core": patch
---

The CLI no longer reads `host` from a project's `sapiom.json`. The API host now
comes only from `SAPIOM_HOST`, `--host`, `--target` or `sapiom config set-target`,
and otherwise defaults to production. A `host` still present in `sapiom.json`
prints a one-line warning on stderr naming the host actually used.
`SapiomConfig.host` is kept as a deprecated, ignored field so existing files
still parse.
