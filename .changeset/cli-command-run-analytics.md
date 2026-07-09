---
"@sapiom/cli": minor
---

Emit anonymous `command.run` usage analytics via `@sapiom/analytics-core`.

- One `command.run` event per executed command (commander `preAction`/`postAction`
  hooks), carrying the command path (e.g. `agents deploy`), the names of the
  flags used — never their values or positional arguments — the duration, and
  the exit status. Tokens and emails never reach event payloads; a signed-in
  credential (from `SAPIOM_API_KEY` or the stored session) is only attached as
  a delivery header for server-side identity enrichment.
- Ships dark: without an explicitly configured collector endpoint the emitter
  is a silent no-op — zero network calls, zero disk writes, no notice. When
  enabled, analytics-core's one-time first-run notice explains the collection
  and the opt-outs (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`).
- Zero behavior change: enqueue-only delivery (best-effort flush on process
  exit), identical command output and exit codes, and no new required
  configuration.
