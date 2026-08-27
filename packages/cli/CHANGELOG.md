# @sapiom/cli

## 8.0.0

### Patch Changes

- Updated dependencies [37ab85b]
- Updated dependencies [b66ff0e]
- Updated dependencies [b66ff0e]
- Updated dependencies [37ab85b]
- Updated dependencies [37ab85b]
- Updated dependencies [b66ff0e]
- Updated dependencies [b66ff0e]
- Updated dependencies [b66ff0e]
  - @sapiom/harness@0.9.0

## 7.0.4

### Patch Changes

- 52efab3: `sapiom-agent-authoring` skill + scaffold `AGENTS.md`: system-design teaching for multi-stage builds. New "Composing Deployed Agents" section — one agent per PROJECT; a multi-stage system is several small projects composed via `ctx.sapiom.agents.run`, with a worked coordinator example — and the scaffold's "keep exactly one `defineAgent` export" rule now says so inline, so it reads as a per-project rule rather than a design instruction to inline every stage. Also drops the "pass `smart` if you must pin" no-op from the label rule (omitting `model` is the recommendation; `smart` already is the default).
- Updated dependencies [555475d]
- Updated dependencies [52efab3]
  - @sapiom/agent@0.12.0
  - @sapiom/agent-core@0.13.0
  - @sapiom/harness@0.8.5

## 7.0.3

### Patch Changes

- Updated dependencies [9afeda9]
  - @sapiom/agent@0.11.0
  - @sapiom/agent-core@0.12.2
  - @sapiom/harness@0.8.4

## 7.0.2

### Patch Changes

- Updated dependencies [5a8eeea]
- Updated dependencies [00b8814]
- Updated dependencies [5a8eeea]
  - @sapiom/harness@0.8.3
  - @sapiom/agent-core@0.12.0
  - @sapiom/agent@0.10.1
  - @sapiom/sandbox-preview@0.1.16

## 7.0.1

### Patch Changes

- Updated dependencies [af764cd]
  - @sapiom/agent@0.10.0
  - @sapiom/agent-core@0.11.4
  - @sapiom/harness@0.8.2

## 7.0.0

### Patch Changes

- Updated dependencies [bb0df7d]
- Updated dependencies [b1d791b]
- Updated dependencies [8ef5374]
- Updated dependencies [f5a67c2]
  - @sapiom/harness@0.8.0
  - @sapiom/agent-core@0.11.0

## 6.0.0

### Patch Changes

- f21f6a6: Windows: sessions create and deliver their prompt, the canvas refreshes, and nothing pops a console window

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

- Updated dependencies [3cbe957]
- Updated dependencies [4edcbf5]
- Updated dependencies [f21f6a6]
  - @sapiom/harness@0.7.0
  - @sapiom/agent-core@0.10.7

## 5.0.0

### Patch Changes

- Updated dependencies [651c407]
- Updated dependencies [7bef8b2]
- Updated dependencies [651c407]
- Updated dependencies [95241fb]
- Updated dependencies [928a639]
- Updated dependencies [5c0c646]
- Updated dependencies [21bb3f0]
  - @sapiom/harness@0.6.0
  - @sapiom/agent-core@0.10.6

## 4.0.0

### Patch Changes

- Updated dependencies [19b8bbb]
- Updated dependencies [03d23c8]
- Updated dependencies [5aa3e01]
  - @sapiom/agent-core@0.10.5
  - @sapiom/harness@0.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [38a7327]
- Updated dependencies [0b0784c]
- Updated dependencies [0b0784c]
- Updated dependencies [feaaeaa]
- Updated dependencies [2c4e8d9]
- Updated dependencies [58f8008]
- Updated dependencies [1b3c103]
  - @sapiom/harness@0.4.0

## 2.0.0

### Patch Changes

- 1000510: Describe deploy as a synthesized bundle of current local source, distinguish
  account-free local validation from metered cloud builds and production runs,
  and make execution inspection's cost-agnostic evidence boundary explicit.
- Updated dependencies [3ef1454]
- Updated dependencies [1000510]
- Updated dependencies [2485561]
- Updated dependencies [25fc26f]
- Updated dependencies [9addb66]
- Updated dependencies [533cc88]
- Updated dependencies [7ae67f6]
- Updated dependencies [cc2e4aa]
- Updated dependencies [baa6102]
  - @sapiom/harness@0.3.0
  - @sapiom/agent-core@0.10.3

## 1.0.3

### Patch Changes

- 40d1c64: Use Agent and Agent run terminology in scaffolded and published authoring assets.
- Updated dependencies [824eb1e]
- Updated dependencies [368125b]
- Updated dependencies [addb63c]
- Updated dependencies [40d1c64]
- Updated dependencies [9199e10]
- Updated dependencies [be2b81b]
- Updated dependencies [94584a2]
  - @sapiom/harness@0.2.6
  - @sapiom/agent-core@0.10.0

## 1.0.2

### Patch Changes

- Updated dependencies [c8072cd]
  - @sapiom/agent@0.9.0
  - @sapiom/agent-core@0.9.13
  - @sapiom/harness@0.2.5

## 1.0.1

### Patch Changes

- Updated dependencies [a1e0e4f]
- Updated dependencies [a1e0e4f]
  - @sapiom/agent@0.8.0
  - @sapiom/agent-core@0.9.12
  - @sapiom/sandbox-preview@0.1.10
  - @sapiom/harness@0.2.4

## 1.0.0

### Patch Changes

- Updated dependencies [3f96e37]
- Updated dependencies [3f96e37]
- Updated dependencies [c32f818]
- Updated dependencies [460bfc1]
- Updated dependencies [c32f818]
- Updated dependencies [b7f5b02]
- Updated dependencies [460bfc1]
- Updated dependencies [7b98507]
- Updated dependencies [b199f93]
- Updated dependencies [2d25205]
  - @sapiom/agent@0.7.0
  - @sapiom/harness@0.2.0
  - @sapiom/agent-core@0.9.10

## 0.4.2

### Patch Changes

- 1ff8d3c: Add `sapiom dev [dir]` command that launches the Sapiom Harness.

  Spawns `sapiom-harness` asynchronously with `stdio: 'inherit'` so the terminal is handed to the harness cleanly. SIGTERM and SIGHUP are forwarded to the child process; SIGINT is intentionally not re-sent (the TTY process group delivers it to both parent and child). If the child exits via a signal the parent exits with 128+signum per POSIX convention; non-zero exit codes are propagated via `process.exitCode`. Unknown flags (future harness flags) pass through verbatim without a CLI update.

  `@sapiom/harness` is an optional peer dependency (declared `>=0.1.1 <2`). When absent, a clear install hint is printed. The harness bin is located via `createRequire` bound to `process.argv[1]` so resolution is correct in ESM production; a `__filename` fallback covers the CJS test environment. The `[dir]` positional is never included in analytics payloads.

- Updated dependencies [696f111]
- Updated dependencies [48fb35c]
- Updated dependencies [95bfcd1]
- Updated dependencies [bf44229]
- Updated dependencies [dab6d44]
- Updated dependencies [ebfa0bc]
- Updated dependencies [0cc7cd5]
- Updated dependencies [a318f0b]
- Updated dependencies [c8c4746]
- Updated dependencies [97e8259]
- Updated dependencies [1ff8d3c]
- Updated dependencies [6d7ccd8]
- Updated dependencies [e0334ca]
- Updated dependencies [6c64501]
- Updated dependencies [58ec57f]
- Updated dependencies [1b355a4]
- Updated dependencies [a686143]
  - @sapiom/agent-core@0.9.2
  - @sapiom/analytics-core@0.2.1
  - @sapiom/harness@0.1.2

## 0.4.1

### Patch Changes

- 41e9ecd: Add `sapiom sandbox preview [name]` (alias `sbx`): deploy a web-app preview from the current project to a Sapiom sandbox and print the live URL. Reads the sandbox's declared intent from `sapiom.json` (`type: "sandbox"`, singular-default when the project defines exactly one, or pass a name). A `failed` status prints the build/start logs so you can fix and re-run; `--json` emits the structured result.
- Updated dependencies [41e9ecd]
  - @sapiom/sandbox-preview@0.1.2

## 0.4.0

### Minor Changes

- 1d993b2: Emit anonymous `command.run` usage analytics via `@sapiom/analytics-core`.

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

### Patch Changes

- Updated dependencies [3f25008]
- Updated dependencies [55462b3]
- Updated dependencies [d661d57]
  - @sapiom/analytics-core@0.2.0
  - @sapiom/agent-core@0.9.0
  - @sapiom/agent@0.6.2

## 0.3.2

### Patch Changes

- Updated dependencies [020139a]
- Updated dependencies [3dfbd10]
  - @sapiom/agent@0.6.1
  - @sapiom/agent-core@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [7a9d57a]
  - @sapiom/agent@0.6.0
  - @sapiom/agent-core@0.7.0

## 0.3.0

### Minor Changes

- cc1261e: Rename the composition SDK to **agents** and the coding/LLM capability to **models**.

  **Breaking — the package names changed. Install the new names; the old ones are deprecated.**

  - Packages: `@sapiom/orchestration` → `@sapiom/agent`, `@sapiom/orchestration-core` → `@sapiom/agent-core`, `@sapiom/orchestration-runtime` → `@sapiom/agent-runtime`. (`@sapiom/create-orchestration` is retired — scaffold with the CLI or the developer MCP.)
  - API: `defineOrchestration` → `defineAgent`; `Orchestration*` types/errors → `Agent*`.
  - `@sapiom/tools`: the `agent` capability namespace is now `models` (e.g. `sapiom.models.coding`); the `orchestrations` namespace is now `agents`.
  - CLI: `sapiom orchestrations …` → `sapiom agents …`.
  - Developer MCP tools: `sapiom_dev_orchestrations_*` → `sapiom_dev_agents_*`.

### Patch Changes

- Updated dependencies [cc1261e]
  - @sapiom/agent@0.5.0
  - @sapiom/agent-core@0.6.0

## 0.2.5

### Patch Changes

- f2f4fec: Bring `inspect()` / `listExecutions()` to REST `ExecutionProjection` parity (tree + per-node cost + trace refs), replacing the flat inspection shape.

  **Breaking (return shapes):**

  - `inspect(opts, client)` now resolves the decoded `ExecutionProjection` **directly** (previously `{ execution }`). It carries the dispatch tree (`traceRoot`/`traceParent`/`traceId`/`spanId`, `parentExecutionId`/`rootExecutionId`, typed `children`), per-step `spanId`/`events`/`dispatch`, and a structured `StepError` (`trace` is now a `StepErrorTrace` of source-mapped frames, not a string).
  - `listExecutions(client)` now resolves `ExecutionRef[]` **directly** (previously `{ executions }`).
  - The flat `ExecutionDetail` / `StepRecord` types are removed; import the new projection types (`ExecutionProjection`, `StepProjection`, `CostNode`, `ExecutionRef`, `DispatchRef`, `StepError`, `StepEvent`) instead.

  **Cost is honest, never fabricated:** `cost` is `CostNode | null` at run and step granularity. The execution-detail read is cost-agnostic today (authoritative cost lives at `/executions/:id/spend`), so an absent cost decodes to `null`, not a misleading `$0`. `authorizedUsd`/`capturedUsd`/`settleState` are never collapsed when cost is present.

  The engine must emit the corresponding fields (per-node cost, list lineage, named child edges) for the projection to be fully populated; until then `inspect()`/`listExecutions()` degrade honestly rather than throwing. SDK pins move in lockstep with the engine.

- Updated dependencies [f2f4fec]
  - @sapiom/orchestration-core@0.5.0

## 0.2.4

### Patch Changes

- a85e665: Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

  - `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
  - `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
  - `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
  - `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.

- Updated dependencies [a85e665]
- Updated dependencies [ae1df3c]
  - @sapiom/orchestration-core@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [56fd77d]
  - @sapiom/orchestration@0.4.0
  - @sapiom/orchestration-core@0.3.4

## 0.2.2

### Patch Changes

- Updated dependencies [f41ab95]
  - @sapiom/orchestration@0.3.0
  - @sapiom/orchestration-core@0.3.3

## 0.2.1

### Patch Changes

- Updated dependencies [b2c5612]
  - @sapiom/orchestration@0.2.0
  - @sapiom/orchestration-core@0.3.2

## 0.2.0

### Minor Changes

- eb5dca2: Add a `staging` environment to host resolution. `resolveHost` maps the `staging` target (alias `dev`) to the staging API host, and the MCP server resolves `SAPIOM_ENVIRONMENT=staging`/`dev`/`prod` from built-in presets without requiring a `~/.sapiom/credentials.json` entry. A file-defined environment still takes precedence.

### Patch Changes

- @sapiom/orchestration@0.1.9
- @sapiom/orchestration-core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [e17b2d1]
- Updated dependencies [e17b2d1]
  - @sapiom/orchestration-core@0.3.0
  - @sapiom/orchestration@0.1.8

## 0.1.1

### Patch Changes

- Updated dependencies [704c9ac]
  - @sapiom/orchestration-core@0.2.0
  - @sapiom/orchestration@0.1.7
