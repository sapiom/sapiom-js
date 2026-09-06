# Agent Studio desktop

The Electron app hosts `@sapiom/harness` in a native window. See
[CLAUDE.md](CLAUDE.md) for packaging and platform development instructions.

## Coding-agent updates

On a normal launch, Studio checks the installed Claude Code and Codex versions
against their npm `latest` releases before starting agent sessions. It updates
each installed provider independently. If neither provider is available, the
existing setup flow installs Claude Code.

New versions install into isolated directories under the app's per-user
`agent-versions/` directory. Studio runs the new CLI's version check before
selecting it. Your Homebrew, npm-global, or native installation is not modified;
Studio can use its own newer copy. A newer version detected on PATH takes precedence,
and an unknown external version is left alone.

Registry checks time out after five seconds. Each installation is stopped after
90 seconds, with bounded cleanup for its child processes. Offline, failed, or interrupted updates
keep the previous working CLI available. Selected installations are reused
offline. Old installation directories are retained because an existing process
may still be using them.

Updates take effect in new processes, including resumed conversations. They do
not replace a running session. Quit and reopen Studio to check for a newly
released CLI. Authentication, provider configuration, model caches, and
conversation history stay in their existing locations. Studio does not change
your selected model. A model must also be available to your provider account;
updating the CLI does not grant access to a model.

Studio disables Claude's self-updater for its managed copies and Codex's own
startup update check, since Studio handles their updates before sessions start.
JavaScript CLI launchers use Studio's bundled runtime, including on Windows
machines without Node installed.

`--dev` and `--smoke` skip update traffic and installation. Setting
`SAPIOM_DISABLE_AGENT_UPDATES=1` does the same for a packaged launch; an already
selected managed installation is still usable. Update progress appears during
startup and in `main.log` under `[boot] agent-update`.

The desktop app's own GitHub updater and the Sapiom MCP package's periodic
refresh are separate from these coding-agent updates.
