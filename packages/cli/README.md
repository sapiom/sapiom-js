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

### Schedules

Run a deployed orchestration on a schedule — recurring (cron) or once at a set time:

```sh
sapiom orchestrations schedule preview "0 9 * * 1-5"            # check a cron before using it
sapiom orchestrations schedule create my-app --cron "0 9 * * 1-5" --timezone America/New_York
sapiom orchestrations schedule create my-app --at 2026-07-01T17:00:00Z   # one-off
sapiom orchestrations schedule list my-app                     # list an orchestration's schedules
sapiom orchestrations schedule inspect <scheduleId>            # config, next fire, recent fires
sapiom orchestrations schedule cancel <scheduleId>
```

Run `sapiom orchestrations --help` for the full command set. Every command accepts
`--json` for machine-readable output.
