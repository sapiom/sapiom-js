# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Managed Loop with
MCP** — authored against `@sapiom/agent`. It answers a question with the managed
loop, using a remote MCP server as the model's tools:
`prepare` → `ask` → (pause) → `report`, with a `rejected` off-ramp for a bad
`mcpUrl`. Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom`
(here: `ctx.sapiom.models.launch`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing.
- **The managed loop takes its tools from `mcps`.** Each entry is
  `{ url, headers? }` for a Streamable HTTP MCP server. The loop runs in Sapiom's
  server, so the URL must be reachable from the internet, not from your machine.
- **Leave `model` out.** The platform routes the run. If you set it, use a model
  label (`"small"`, `"medium"`, `"large"`); a raw provider model id is never honored.
- **`ask` launches and pauses.** `models.launch` returns a handle;
  `pauseUntilSignal(handle, { resumeStep: "report" })` suspends the run until the
  platform fires `models.run.result`. `report`'s input is the run result
  (`ModelRunResultPayload`). Use `ctx.sapiom.models.run(...)` instead if you would
  rather wait inline in one step.
- **A failed or empty run fails the step.** `report` never substitutes an answer.
  Keep that guard if you edit it.
- **Credentials come from the environment.** `MCP_AUTH_TOKEN` is read from
  `process.env` and sent as `authorization: Bearer <token>`. It is optional; the
  default MCP server needs none.

## Test it

- `run_local` with `{}` runs every step. `models.launch` is stubbed, and the pause
  resumes `report` with the stub result. Stub `models.launch` in the `ask` step to
  control that result, e.g. `{ "status": "failed", "error": { "message": "x" } }`
  for the failure branch.
- Deployed, a run with `{}` asks DeepWiki's public MCP server about a public GitHub
  repository and returns the model's answer.

## Platform rules (served, not restated here)

The rules that are true of Sapiom regardless of this project's SDK version — which capability
calls an LLM, database lifetime, trigger kinds, App Link webhooks, composing deployed agents —
are served live at <https://api.sapiom.ai/v1/agents/authoring-rules> and summarized in the
`sapiom-agent-authoring` skill's platform chapters.
