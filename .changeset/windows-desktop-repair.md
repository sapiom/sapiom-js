---
"@sapiom/harness": minor
"@sapiom/harness-desktop": minor
"@sapiom/agent-core": patch
"@sapiom/mcp": patch
"@sapiom/cli": patch
---

Windows: sessions create and deliver their prompt, the canvas refreshes, and nothing pops a console window

The desktop app was unusable on Windows — every `POST /api/sessions` answered
`500 {"error":"internal error"}`, and when a session did start, its first
prompt never reached the agent. Root-caused on a real machine and fixed
end to end.

- **Sessions.** Claude Code's own native auto-updater had renamed the running
  `claude.exe` to `claude.exe.old.<ts>` inside the app-managed npm prefix and
  never written the replacement, so every spawn failed while `doctor` (which
  shells `where`) still reported the agent present. Boot now verifies the
  agent actually spawns, repairs the managed install when it doesn't, and sets
  `DISABLE_AUTOUPDATER` for installs the app owns. The refusal itself names
  the situation instead of "target could not be determined".
- **The first prompt.** It is held until the session reports ready, which only
  happens when the generated `SessionStart` hook POSTs back — and Claude Code
  runs hooks through Git Bash on Windows, which cannot resolve a `.cmd`, so
  the desktop's `node.cmd`-only shims meant the hook never ran. The host now
  ships npm's extensionless sh shim too, a 20s hook-timeout fallback rescues a
  session whose hook chain is broken (gated on Claude's blocking-prompt
  screens so it can never answer a trust dialog), `emit.cjs` gets budgets a
  cold loopback survives (SessionStart only — the other hooks block the
  agent), and multi-line prompts are paste-wrapped under ConPTY, which hides
  the bracketed-paste announcement.
- **Console windows.** The `sapiom-dev` MCP server was launched via `npx`,
  whose `cmd.exe` sat on screen as a persistent blank window; closing it
  killed the server and every later tool call hung. The app now installs
  `@sapiom/mcp` into its own prefix and launches it through the app binary
  (GUI subsystem — no console can exist), and every `child_process` call
  across the harness, agent-core, the MCP and the desktop passes
  `windowsHide`.
- **Canvas.** `fs.watch` reports native separators, so the watcher's
  POSIX-literal comparison never matched on Windows and `canvas.reload` was
  never published — every canvas hot-reload was silently dead there (the
  "Preparing your agent" placeholder outliving a finished install was the
  visible symptom).
- **Diagnosis.** 500s now carry the real message (and errno) instead of
  "internal error", the desktop tees its main-process log to
  `<userData>/logs/main.log`, and spawn failures map to actionable 4xx.
- **Also:** Git is provisioned from git-for-windows' checksum-pinned MinGit
  when a Windows machine has none (template clone and deploy shell out to a
  real `git`); client-supplied `cwd` is normalized server-side and the SPA's
  path helpers understand both separators; gateway requests time out instead
  of hanging an MCP tool call for minutes; and the updater falls back to
  HTTP/1.1, names a GitHub 429 for what it is, and bounds every path that can
  reach GitHub.
