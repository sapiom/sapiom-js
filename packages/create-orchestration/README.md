# @sapiom/create-orchestration

Scaffold a new [Sapiom orchestration](https://www.npmjs.com/package/@sapiom/orchestration) project.

```sh
npm create @sapiom/orchestration my-agent
# or
npx @sapiom/create-orchestration my-agent
```

Creates a ready-to-edit project: `@sapiom/orchestration` + `@sapiom/tools` pinned to the current published versions, a `tsconfig.json` tuned for the SDK's subpath exports, and a stub `index.ts` defining a minimal orchestration.

## Options

```
create-orchestration <dir> [--template <name>]
```

- `-t, --template <name>` — template to scaffold from (default: `default`). More pre-supplied templates can be added without upgrading this tool.
- `-h, --help`

Non-interactive by design — everything comes from arguments, so it scripts cleanly (including from a coding agent).
