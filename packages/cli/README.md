# @sapiom/cli

The Sapiom command-line interface.

```sh
npm install -g @sapiom/cli
# or run without installing:
npx @sapiom/cli <command>
```

## Agents

```sh
sapiom agents init my-app    # scaffold a new agent project
sapiom agents check          # validate locally (bundle, manifest, graph)
sapiom agents deploy         # build and ship
```

### Schedules

Run a deployed agent on a schedule — recurring (cron) or once at a set time:

```sh
sapiom agents schedule preview "0 9 * * 1-5"            # check a cron before using it
sapiom agents schedule create my-app --cron "0 9 * * 1-5" --timezone America/New_York
sapiom agents schedule create my-app --at 2026-07-01T17:00:00Z   # one-off
sapiom agents schedule list my-app                     # list an agent's schedules
sapiom agents schedule inspect <scheduleId>            # config, next fire, recent fires
sapiom agents schedule cancel <scheduleId>
```

Run `sapiom agents --help` for the full command set. Every command accepts
`--json` for machine-readable output.

## Usage analytics

The CLI can emit anonymous usage events through
[`@sapiom/analytics-core`](https://github.com/sapiom/sapiom-js/tree/main/packages/analytics-core):
one `command.run` event per executed command, carrying the command name, the
names of the flags used (never their values or arguments), the duration, and
the exit status. Nothing is sent unless a collector endpoint is explicitly
configured, and delivery is best-effort in the background — analytics can
never slow down or fail a command. Opt out at any time with
`SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
