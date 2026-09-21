# Working in this agent project

This project defines exactly one Sapiom agent in `index.ts`, authored against `@sapiom/agent`.

## The loop

1. Edit `index.ts`. An agent is `defineAgent({ entry, steps })`; each step is `defineStep({ name, next, run })`. Inside `run`, Sapiom capabilities are available pre-auth'd on `ctx.sapiom`.
2. `npm run check` — validate locally (bundles, builds the manifest, checks the step graph). Fast and offline; run it after every edit.
3. `npm run deploy` — ship it.

## Notes for coding agents

- Use `npm run check` as the tight feedback loop — prefer it over reasoning about whether the graph is valid.
- For exact command options, run `sapiom agents --help`, and pass `--json` to any command for machine-readable output. Don't hardcode capability lists or schemas — query them at runtime.
- Keep exactly one `defineAgent(...)` export in `index.ts` — one agent per project. A multi-stage system is several small projects composed with `ctx.sapiom.agents.run` (the rule and its worked example: [Composing deployed agents](https://api.sapiom.ai/v1/agents/authoring-rules#agent-composition), summarized in the sapiom-agent-authoring skill).

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version — which capability
calls an LLM, database lifetime, trigger kinds, App Link webhooks, composing deployed agents —
are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the
`sapiom-agent-authoring` skill's platform chapters. This file was written against release 1.0 of
that text; `sapiom_dev_agents_check` warns when the served copy differs.

<!-- sapiom-authoring-rules release=1.0 digest=1f3e5cd9648f -->
