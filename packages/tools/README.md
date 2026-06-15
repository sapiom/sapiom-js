# @sapiom/tools

A typed TypeScript client for Sapiom capabilities — sandboxes, git repositories, and coding agents — authenticated to your tenant.

These are the same capabilities your Sapiom agents call as tools; this package makes them callable directly from your own code.

```bash
npm install @sapiom/tools
# or
pnpm add @sapiom/tools
```

## Quickstart

```typescript
import { createClient } from "@sapiom/tools";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Create a repo, have a coding agent build into it, then publish.
const repo = await sapiom.repositories.create("landing-page");
const run = await sapiom.agent.coding.run({
  task: "Build a one-page marketing site in index.html.",
  gitRepository: repo, // cloned into the run's sandbox at /workspace/landing-page
});

if (run.result?.success) {
  const { sha } = await repo.pushFromSandbox(run.sandbox, { message: "build: landing" });
  console.log("published", sha);
}
```

## Authentication

There are two ways to authenticate, both exposing the identical capability surface:

- **Explicit** — pass a key to `createClient`. This is the standalone entry point:
  ```typescript
  const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
  await sapiom.sandboxes.create({ name: "demo" });
  ```
- **Ambient** — import the namespaces directly and they resolve credentials from `SAPIOM_API_KEY` (or, inside a Sapiom workflow step, from the client the runtime provides):
  ```typescript
  import { sandboxes, repositories, agent } from "@sapiom/tools";
  await sandboxes.create({ name: "demo" });
  ```

## Attribution

Calls can be attributed to an agent and trace so they show up correctly in your transaction history. Attribution is set **once, on the client** — not per call:

```typescript
const sapiom = createClient({
  apiKey: process.env.SAPIOM_API_KEY,
  attribution: { agentName: "digest-bot", traceId },
});
// every call this client makes is now attributed to digest-bot / traceId
```

Inside a Sapiom workflow you don't set this at all — the runtime constructs the client with the running execution's attribution, so every tool call is attributed automatically.

If a single process makes calls on behalf of more than one agent or trace, derive a client per context with `sapiom.withAttribution({ ... })`.

## Capabilities

Each capability is a namespace, importable from the barrel or its own subpath (e.g. `@sapiom/tools/sandboxes`). Every capability has its own README with usage details, preconditions, and gotchas the type signatures can't express — read it before first use.

| Namespace | What it is | Docs |
|---|---|---|
| `sandboxes` | Isolated, ephemeral compute | [src/sandboxes](./src/sandboxes/README.md) |
| `repositories` | Private, in-network git repos | [src/repositories](./src/repositories/README.md) |
| `agent` | Coding agents (LLM execution) | [src/agent](./src/agent/README.md) |

## Composing capabilities

Capabilities are designed to work together. A coding `agent` run hands back the live `Sandbox` it executed in, and a `Repository` can publish a working tree straight from that sandbox:

```typescript
const run = await agent.coding.run({ task, gitRepository: repo });
await repo.pushFromSandbox(run.sandbox);
```

A useful pattern: let the agent do the open-ended work (writing files) and perform exact, repeatable actions — committing, pushing, deploying — in your own code rather than in the agent's prompt. The agent produces the changes; `pushFromSandbox` publishes them deterministically.

## License

MIT
