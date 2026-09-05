# `@sapiom/opencode`

Proof of concept for a Studio-owned UI over an isolated, headless OpenCode
sidecar.

```text
Assistant UI
  -> same-origin /opencode proxy
  -> authenticated headless OpenCode
  -> Sapiom OpenAI-compatible model endpoint
  -> OpenCode SSE events
  -> Assistant UI
```

## Run from this workspace

```bash
pnpm --filter @sapiom/opencode build
SAPIOM_API_KEY=... node packages/opencode/dist/cli.js /path/to/project \
  --model smart
```

Open the printed localhost URL. Stop with `Ctrl-C`.

Published-package shape:

```bash
SAPIOM_API_KEY=... npx @sapiom/opencode /path/to/project --model smart
```

Useful POC options:

- `--no-mcp`: test the chat loop without Sapiom MCP tools.
- `--port <number>`: use a fixed UI port instead of an ephemeral one.
- `SAPIOM_LLM_URL`: override `https://llm.services.sapiom.ai`.
- `SAPIOM_MCP_URL`: override `https://api.sapiom.ai/v1/mcp`.
- `SAPIOM_OPENCODE_BIN`: explicitly test another OpenCode executable.

## Library use

Studio imports the same package; it does not shell out to `npx`.

```ts
import {
  createSapiomOpenCodeConfig,
  startOpenCodeStandalone,
} from "@sapiom/opencode";

const app = await startOpenCodeStandalone({
  cwd: projectDirectory,
  stateRoot,
  webRoot,
  config: createSapiomOpenCodeConfig({ routingLabel: "smart" }),
});
```

`startOpenCodeServer` is the lower-level sidecar API when Studio owns the UI
host itself.

## POC boundaries

Implemented:

- Pinned `opencode-ai` binary; no ambient global OpenCode dependency.
- Separate XDG config, data, cache, and state directories.
- Random Basic-auth credential hidden behind the same-origin proxy.
- External plugins, project config, and external skills disabled.
- Sapiom model label attached through `x-sapiom-model`.
- Sapiom MCP tools attached through the OpenCode config.
- Streaming responses and events forwarded without protocol translation.
- Idempotent shutdown with forced termination fallback.

Not production-ready:

- Local UI host has no Studio boot-token authentication yet.
- OpenCode receives `SAPIOM_API_KEY`; its tool subprocess inheritance must be
  audited or replaced by a Studio-owned credential-injecting model proxy.
- Permission/question UI needs destructive-tool and denial-path testing.
- Trusted project instructions need an explicit Studio-owned injection path;
  project `AGENTS.md` is intentionally disabled in this POC.
- Windows/Linux package and process-tree smoke tests remain required.
- `@assistant-ui/react-opencode` is experimental and version-pinned.
