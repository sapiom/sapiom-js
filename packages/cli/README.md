# @sapiom/cli

The Sapiom command-line interface.

```sh
npm install -g @sapiom/cli
# or run without installing:
npx @sapiom/cli <command>
```

## Harness

Launch a local coding environment with MCP pre-wired and your agent running in
an embedded terminal:

```sh
sapiom dev [dir]          # open the harness in the current (or given) directory
sapiom dev --port 4200    # use a custom port
sapiom dev --no-open      # skip opening the browser automatically
```

`sapiom dev` requires `@sapiom/harness` to be installed. Install it once with:

```sh
npm install -g @sapiom/harness
```

## Agents

```sh
sapiom agents init my-app    # scaffold a new agent project
sapiom agents check          # validate locally (bundle, manifest, graph)
sapiom agents deploy         # build and ship
```

### Events and signals

Two verbs, two jobs: an **event starts** runs, a **signal resumes** one that is
already paused. Neither reaches the other's namespace.

```sh
# Start: fans out to every active event trigger on this type (0..N new runs).
sapiom agents emit lead.created --payload '{"leadId":"l_42"}' --event-id crm-evt-8f2a

# Resume: wakes the run(s) paused on this exact (name, correlation id) pair.
sapiom agents signal <executionId> --name approval.decision \
  --correlation-id <executionId> --payload '{"approved":true}'
```

`--event-id` is your id for the delivery: reposting it returns the original
receipt and starts nothing new, which is what makes a retry safe. Omit it and
every call is a distinct event. An emit with no matching trigger is still a
success (`outcome: "unmatched"`) — the event is recorded, nothing subscribed.

`signal` takes an execution id to address the run, but delivery is matched on
`(name, correlationId)`, so one call can resume several waiting runs. Read
`message` in the result whenever it is present: it qualifies a `matched` count
that under-reports a partial fanout.

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
the exit status. Nothing is currently sent anywhere. When delivery is
enabled, it is best-effort and can never fail a command: it never slows
command execution, and on exit a final flush is bounded by the emitter's
5-second request timeout — retries never hold the process open. Opt out at
any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
