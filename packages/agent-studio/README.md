# Agent Studio

Agent Studio is a local workspace for building, testing, deploying, and running
Sapiom agents with your own coding agent.

```bash
npx @sapiom/agent-studio@latest [dir]
```

The optional directory defaults to the current working directory. Every Agent
Studio launch flag is passed through unchanged, including `--port`, `--login`,
`--no-open`, `--no-auth`, `--no-telemetry`, `--no-session`, and `--state-root`.

This package is the branded public launcher. It delegates to an exact,
release-tested version of the `@sapiom/harness` implementation package; it does
not contain a second copy of the application. The supported direct command
continues to work:

```bash
npx @sapiom/harness@latest [dir]
```

Agent Studio requires Node.js 20 or newer and Claude Code or Codex on `PATH`.
