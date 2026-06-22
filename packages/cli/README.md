# @sapiom/cli

The Sapiom command-line interface.

```sh
npm install -g @sapiom/cli
# or run without installing:
npx @sapiom/cli <command>
```

## Orchestrations

```sh
sapiom orchestrations init my-app    # scaffold a new orchestration project
sapiom orchestrations check          # validate locally (bundle, manifest, graph)
sapiom orchestrations deploy         # build and ship
```

Run `sapiom orchestrations --help` for the full command set. Every command accepts
`--json` for machine-readable output.
