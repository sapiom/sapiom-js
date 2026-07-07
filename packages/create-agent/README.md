# @sapiom/create-agent

Scaffold a new [Sapiom agent](https://www.npmjs.com/package/@sapiom/agent) project.

```sh
npm create @sapiom/agent my-agent
# or
npx @sapiom/create-agent my-agent
```

Creates a ready-to-edit project: `@sapiom/agent` + `@sapiom/tools` pinned to the current published versions, a `tsconfig.json` tuned for the SDK's subpath exports, and a stub `index.ts` defining a minimal agent.

## Options

```
create-agent <dir> [--template <name>]
```

- `-t, --template <name>` — template to scaffold from (default: `default`). More pre-supplied templates can be added without upgrading this tool.
- `-h, --help`

Non-interactive by design — everything comes from arguments, so it scripts cleanly (including from a coding agent).
