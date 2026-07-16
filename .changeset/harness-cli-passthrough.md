---
"@sapiom/harness": minor
---

New CLI passthrough mode: `sapiom-harness -- claude [args...]` (or `claude-code` / `codex`) runs the coding agent directly in your terminal — no web UI — while the harness still handles auth, telemetry consent, per-session config injection, and analytics.

- Grammar (the `--` separator is mandatory, one form): `sapiom-harness [--no-auth|--no-telemetry] -- <agent> [child-args...]`. Everything after the agent goes verbatim to the child — later `--` tokens and agent flags included. Web-only flags (`--port`, `--no-open`, `--no-session`, `--dev`), unknown flags, or positionals before the `--` are a clear error, as is a `--` not followed by a known agent (claude, claude-code, codex). Without a `--` the argv falls through to the existing web-UI mode unchanged — `sapiom-harness claude` is a dir positional there, and when that directory doesn't exist the error points at the `--` form (`did you mean: sapiom-harness -- claude [args...]?`).
- Injected per session, same as web sessions: hooks settings (`--settings`), MCP config (`--mcp-config`, authenticated when signed in), the bundled skills plugin, and a CLI-tailored system prompt (`CLI_SYSTEM_PROMPT` — the agent-general core without the web app's canvas sections; the web prompt is unchanged).
- Analytics parity: a headless local `/ingest` listener feeds the same normalize → enrich → store → emit pipeline; events always land in `~/.sapiom/harness/events.ndjson` and, with telemetry opted in, the collector (flushed before exit). Codex sessions are tailed from their rollout file, with a synthesized `session.end` when the process exits.
- Codex caveat: Codex has no per-session MCP config, so the harness can't inject the Sapiom MCP — a one-time `codex mcp add sapiom-dev -- npx -y @sapiom/mcp` hint is printed before launch.
- The child owns the terminal: the harness prints a one-line notice before spawn, stays silent until the agent exits, then propagates its exit code (128+n on signal death) and removes the session's generated config directory.
