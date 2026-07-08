# Sapiom SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)

> ⚠️ **Beta Status:** Currently in v0.x (beta). API may change before v1.0.0.
> Production-ready and actively maintained.

TypeScript SDK for **building, running, and operating AI agents on Sapiom**.
Author agents as typed step graphs, call Sapiom paid tools (sandboxes, git
repos, coding models, search, file storage, …) directly from your code, and ship
them to the Sapiom engine from the CLI or your coding agent's MCP.

## 📦 Packages

This is a monorepo of focused packages. Install only what you need.

### Build & run agents

| Package                           | Version                                                                                           | Description                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [@sapiom/agent](./packages/agent) | [![npm](https://img.shields.io/npm/v/@sapiom/agent)](https://www.npmjs.com/package/@sapiom/agent) | The authoring contract: `defineAgent`, `defineStep`, directives (`goto`/`terminate`), and types |
| [@sapiom/tools](./packages/tools) | [![npm](https://img.shields.io/npm/v/@sapiom/tools)](https://www.npmjs.com/package/@sapiom/tools) | Typed client for Sapiom capabilities — the same tools your agents call, callable from your code |
| [@sapiom/cli](./packages/cli)     | [![npm](https://img.shields.io/npm/v/@sapiom/cli)](https://www.npmjs.com/package/@sapiom/cli)     | Command line: scaffold, validate, deploy, and schedule agents                                   |
| [@sapiom/mcp](./packages/mcp)     | [![npm](https://img.shields.io/npm/v/@sapiom/mcp)](https://www.npmjs.com/package/@sapiom/mcp)     | Local developer MCP server (`sapiom-dev`) — build & operate agents from your coding agent       |

### Runtime internals

Lower-level packages that power the stack above. Most users never import these
directly, but they're published for advanced/host integrations.

| Package                                           | Version                                                                                                           | Description                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [@sapiom/agent-core](./packages/agent-core)       | [![npm](https://img.shields.io/npm/v/@sapiom/agent-core)](https://www.npmjs.com/package/@sapiom/agent-core)       | Pure, stateless functions for scaffolding, validating, and operating agents — shared by the CLI and MCP |
| [@sapiom/agent-runtime](./packages/agent-runtime) | [![npm](https://img.shields.io/npm/v/@sapiom/agent-runtime)](https://www.npmjs.com/package/@sapiom/agent-runtime) | Host-agnostic graph-walker runtime — one runtime, two hosts (server engine + local runner)              |

## 🚀 Quick Start

**New to Sapiom?** The fastest path is the CLI or the developer MCP — both
scaffold a working agent for you. See the [examples folder](./examples) for
complete, runnable projects.

### Scaffold an agent with the CLI

```bash
npx @sapiom/cli agents init my-app   # scaffold a project
cd my-app
npx @sapiom/cli agents check         # validate locally (bundle, manifest, graph)
npx @sapiom/cli agents deploy        # build and ship
```

### Author an agent

An agent is a typed graph of steps. Each step does work and returns a directive
telling the runtime where to go next.

```typescript
import { defineAgent, defineStep, goto, terminate } from "@sapiom/agent";

const start = defineStep({
  name: "start",
  next: ["finish"],
  async run(input, ctx) {
    return goto("finish", { greeting: `hello ${input.name}` });
  },
});

const finish = defineStep({
  name: "finish",
  next: [],
  terminal: true,
  async run(input) {
    return terminate({ done: true, ...input });
  },
});

export const hello = defineAgent({
  name: "hello",
  entry: "start",
  steps: { start, finish },
});
```

### Call Sapiom capabilities from your code

`@sapiom/tools` exposes the same capabilities your agents call as tools, typed
and authenticated to your tenant.

```typescript
import { createClient } from "@sapiom/tools";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Create a repo, have a coding model build into it, then publish.
const repo = await sapiom.repositories.create("landing-page");
const run = await sapiom.models.coding.run({
  task: "Build a one-page marketing site in index.html.",
  gitRepository: repo,
});

if (run.result?.success) {
  const { sha } = await repo.pushFromSandbox(run.sandbox, {
    message: "build: landing",
  });
  console.log("published", sha);
}
```

### Build agents from your coding agent (MCP)

Add the local developer MCP so your coding agent can scaffold, test, deploy, and
inspect Sapiom agents. In Claude Code:

```sh
claude mcp add sapiom-dev -- npx -y @sapiom/mcp
```

> `@sapiom/mcp` is the **local developer** surface (`sapiom_dev_*`). It is
> distinct from the remote Sapiom capability MCP that services paid tool calls —
> see [docs/mcp-servers.md](./docs/mcp-servers.md) for which to use when.

## 📚 Documentation

- **[Examples](./examples/README.md)** — runnable example projects
- **[The two Sapiom MCP servers](./docs/mcp-servers.md)** — local dev vs. remote capabilities
- **[@sapiom/agent](./packages/agent/README.md)** — authoring contract
- **[@sapiom/tools](./packages/tools/README.md)** — capability client
- **[@sapiom/cli](./packages/cli/README.md)** — command line
- **[@sapiom/mcp](./packages/mcp/README.md)** — developer MCP

## 🏗️ Package Architecture

```
@sapiom/agent            Authoring contract (defineAgent, directives, types)
    ↑
    ├── @sapiom/agent-runtime   Host-agnostic graph-walker runtime
    └── @sapiom/agent-core      Scaffold / validate / operate (pure functions)
            ↑
            ├── @sapiom/cli     Command line
            └── @sapiom/mcp     Local developer MCP (sapiom-dev)

@sapiom/tools            Typed capability client (sandboxes, repos, models, …)
```

## 🛠️ Development

This is a pnpm workspace monorepo.

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm format
```

### Package Scripts

```bash
# Build / test a specific package
pnpm --filter @sapiom/agent build
pnpm --filter @sapiom/tools test

# Watch mode
pnpm --filter @sapiom/agent dev
```

### Publishing

We use [Changesets](https://github.com/changesets/changesets) for version management:

```bash
pnpm changeset          # create a changeset
pnpm version-packages   # apply version bumps
pnpm release            # build and publish to npm
```

## 🤝 Contributing

Contributions welcome! Please read our [Contributing Guide](./CONTRIBUTING.md) first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT © [Sapiom](LICENSE)

## 🔗 Links

- [Website](https://sapiom.ai)
- [Documentation](https://docs.sapiom.ai)
- [NPM Organization](https://www.npmjs.com/org/sapiom)
- [GitHub Issues](https://github.com/sapiom/sapiom-js/issues)
  </content>
