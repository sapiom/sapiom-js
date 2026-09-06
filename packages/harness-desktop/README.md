# Agent Studio desktop

The Electron host for `@sapiom/harness`. See [CLAUDE.md](CLAUDE.md) for packaging.

## Coding-agent updates

On each normal launch, Studio checks installed Claude Code and Codex against npm
`latest` before starting sessions. If neither is available, setup installs Claude.

Updates use isolated per-user `agent-versions/` directories and pass a version
check before activation. Global installations stay untouched; newer or unknown
versions on PATH are preserved. Previous directories remain for running processes.

Registry requests time out after five seconds; installers are stopped after
90 seconds, with bounded child-process cleanup. Failed/offline updates keep the
working CLI. Closing Studio cancels active updates.

Quit and reopen Studio to check again. New and resumed processes use the selected
CLI; running sessions keep their executable. Authentication, configuration, model
caches, selected models, and history stay intact. Model access also depends on
your provider account.

Studio manages updates for its Claude copies and disables Codex's startup update
check. JavaScript launchers use the bundled runtime, including on Node-less Windows.

`--dev`, `--smoke`, and `SAPIOM_DISABLE_AGENT_UPDATES=1` skip registry/install calls
but can reuse selected copies. Progress appears during setup and in `main.log`
under `[boot] agent-update`. Desktop app updates and MCP refreshes run separately.
