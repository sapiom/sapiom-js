# @sapiom/harness

Run coding agents locally under a managed session runtime — real
pseudo-terminals, harness adapters, a local server and a browser terminal
UI.

> **Status: early preview.** The session foundation is available; harness
> adapters, the local server/UI, analytics and doctor land incrementally.
> APIs may change while the package is pre-1.0.

## Install

```bash
npm install @sapiom/harness
```

node-pty (a native module) compiles during install. With pnpm 10+, allow
its build scripts (`pnpm approve-builds`) or the addon will be missing at
runtime.

## Session runtime

`SessionRuntime` owns interactive terminal sessions; `PtyRuntime` is the
node-pty–backed implementation:

```ts
import { PtyRuntime } from "@sapiom/harness";

const runtime = new PtyRuntime();

const session = await runtime.create({
  command: "bash",
  args: ["-i"],
  env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
  cwd: process.cwd(),
  cols: 120,
  rows: 32,
});

const unsubscribe = runtime.onData(session, (chunk) => {
  process.stdout.write(chunk);
});

runtime.write(session, "echo hello\r"); // prompt injection primitive
runtime.resize(session, 100, 40);

await runtime.kill(session); // SIGTERM, then SIGKILL after a timeout
runtime.isAlive(session); // false
unsubscribe();
```

Behavior notes:

- **Lazy native import** — requiring the package never crashes on machines
  without a working node-pty build. `create()` rejects with a typed
  `PtyUnavailableError` (stable `code: "PTY_UNAVAILABLE"`, remediation
  hint, original cause) that diagnostic tooling can consume.
- **Prebuild repair** — some published node-pty prebuilds (e.g. 1.1.0 on
  macOS) ship their `spawn-helper` without the executable bit, making every
  spawn fail with `posix_spawnp failed`. The runtime restores the bit
  best-effort before spawning.
- **Graceful kill** — `kill()` sends SIGTERM and escalates to SIGKILL if
  the process does not exit within `killTimeoutMs` (default 5s,
  configurable via the `PtyRuntime` constructor).
- **Handles outlive processes** — after exit, `isAlive()` returns `false`
  and writes are dropped; methods called with a handle the runtime never
  issued throw `UnknownSessionError`.

## Development

```bash
pnpm --filter @sapiom/harness build
pnpm --filter @sapiom/harness test
```

Tests run against a transcript-driven fake agent
(`e2e/fixtures/fake-agent/`) inside real ptys — hermetic, no external
agents or network required.

## License

MIT
