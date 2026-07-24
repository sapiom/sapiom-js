# @sapiom/harness

## 0.1.6

### Patch Changes

- b6b9d16: Add a server-side actions router with direct Deploy and Prod-run routes:

  - `POST /api/workflows/:id/deploy` deploys a linked agent and streams build status as NDJSON (a `building` line up front, then a terminal `ready`/`error` line).
  - `POST /api/runs` `{ definitionId, input }` starts an execution and returns `{ executionId }`.

  Both run entirely server-side with the held API key (never exposed to the browser) and require no coding-agent session, so an action consumes no LLM credits.

- b6b9d16: Enrich the step debug/explain context with the run's real per-step evidence. When you ask the agent to debug or explain a step from the run inspector, the injected context now folds in the step's actual input and output, the capabilities it called (with a marker for any served by a stub), and — for offline runs — supplied stubs that matched nothing or carried the wrong shape, on top of the step's status, latency, error, and logs. Every section is emitted only when the trace carries it (no fabricated placeholders), and the context names capabilities, never a model, so "why did this step do X" carries the real evidence instead of just the step name.
- b6b9d16: Extend the expired/rotated API key recovery to the Deploy and Prod-run actions. When one of these actions is rejected as unauthorized, the Studio now re-reads your cached credentials and retries once — so signing in again (in the CLI or elsewhere) unblocks Deploy/Prod-run in place, matching the live-run status path, instead of every action staying stuck on the stale key until a restart.
- b6b9d16: The Harness Studio presents your coding agent in a terminal view.
- b6b9d16: Studio run and step-inspection hardening:

  - Auto-bind a session to the workflow in its folder the moment the session starts, not only when a file later changes — so the canvas and Run actions light up immediately for an existing workflow.
  - Animate the canvas board (per-step running / passed / failed status) during both local and production runs.
  - Never let a direct action (Local Run / Prod Run / Deploy) fail silently: surface the reason on a blocked click, clear the in-flight indicator when the action settles, and distinguish "deploy failed — retry" from "not deployed yet".
  - Enrich the step inspector: per-step input/output and logs, the capability calls a step made (with the served stub values on offline runs), and clickable preview / download / research links found in a step's output — all shown when you click into a step.

- b6b9d16: Degrade gracefully when the Studio is offline or the session drops. Losing your network connection no longer blanks the Studio: a boot failure now shows an honest, recoverable state (offline / session needs a refresh / server unreachable) with a Retry that reconnects in place, and a non-blocking banner appears if the connection drops mid-session so the app stays usable against its last-known state. A rejected credential surfaces as a recoverable "reconnect" state rather than a hard lockout. These states are wired to real signals (the browser's connectivity and the kind of the failed request).
- b6b9d16: Recover from an expired or rotated API key instead of getting stuck. When a live-run status request is rejected as unauthorized, the Studio now re-reads your cached credentials and retries once, so signing in again (in the CLI or elsewhere) unblocks the app in place rather than requiring a restart. Studio actions always authenticate with your held API key.
- b6b9d16: Remove the Studio's cost and pricing surfaces. The wallet card, the per-workflow price note, and per-step cost figures are gone; the run inspector now shows logs, latency, and pass/fail only. `StepView` no longer carries a `costUsd` field.
- b6b9d16: Remove the run spend and transactions endpoints (`GET /api/runs/:executionId/spend` and `/transactions`) and their supporting fetchers. The runs router now serves only run state (`GET /api/runs/:executionId/state`).
- b6b9d16: Restore the bundled demo canvas document (`web/public/canvas/sess-boot/`) the
  Studio's mock/demo mode renders on first paint. The web app already references
  it (the demo session opens on its seeded board), but the file was missing, so
  the canvas pane stayed empty in demo mode. This is demo/mock-only content; real
  local mode still renders the server-generated canvas.
- b6b9d16: Show real per-step input and output in the run inspector's "Last run" section. When a step's run recorded the value it ran on and the value it produced, each is rendered as a collapsible, inspectable payload; a step that carried no input/output shows no block at all (never a fabricated placeholder). Objects are pretty-printed, plain strings shown as-is, and a real `null`/`false`/`0` is displayed faithfully.
- b6b9d16: Add `POST /api/runs/local`: run an agent entirely offline against stub capabilities and stream the result back as NDJSON — one per-step trace line, then a terminal summary carrying the run outcome plus which supplied stub keys went unused or had the wrong shape. It runs in a child process, needs no sign-in, and makes no network call, so a local run works signed-out and at zero cost.
- b6b9d16: Serve the harness web UI from the package build and harden the design-system seam:

  - `pnpm build` emits the web app to `dist/web` and the harness server serves it as the SPA (index.html, hashed assets, and client-side deep-route fallback), so `start` and `npx @sapiom/harness` launch the full UI against the real server. Adds a regression test pinning the build → serve path.
  - The design system resolves to the real package when it's installed and falls back to a committed neutral, unbranded token set otherwise — so a public build renders legibly out of the box, with no theme source required. The stylesheet only bridges variable names onto tokens; it never redefines a token.

  No behavioral or API changes to the harness server.

- b6b9d16: Surface how an offline run's stubs behaved in the run inspector. A step that ran in an offline (stub) run now shows a read-only "stubbed" chip on its row and in its detail, so it is clear its capability calls were served by stubs rather than real calls. The inspector also shows, when present, a read-only notice for supplied stubs that matched no capability call (a no-op mock — usually a typo or the wrong path) and for stubs whose value had the wrong shape — so a stub that silently did nothing is visible instead of a mystery. Nothing is shown when a run has no such issues, and the affordance names capabilities, never a model. Real (non-offline) runs are unaffected.
- b6b9d16: Refresh the harness web UI with a rebuilt workspace: a three-zone layout (an on-disk explorer of your agents, a per-agent workbench with a session tab strip, and session-keyed projections — Canvas / Steps / Code / Skills), a command palette, a chat/terminal view toggle, and a click-into-step run inspector. The bundle ships with a neutral, unbranded default theme so a public build renders legibly out of the box; light and dark are both supported. No behavioral or API changes to the harness server.
- b6b9d16: Point the harness web UI's `@shared/types` alias at the package's own shared contract instead of a vendored copy, so the web and server always build against a single source of truth. The snippet panel now reads the real deployed-agent slug and executions base URL when the server provides them, falling back cleanly when it does not. No behavioral or API changes to the harness server.
- b6b9d16: Wire prod and offline run logs into the Studio's click-into-step run inspector.

  - **Prod runs** light up per-step in the inspector as they progress — status, latency, pass/fail, and (when the run carries them) the step's real input and output. The inspector polls the run's state after it starts and stops quietly once the run finishes or can't be found, so a click into any step shows what it actually did.
  - **Offline stub runs** render in the SAME inspector: their streamed per-step trace is mapped into the identical step view (logs, pass/fail, and the input/output each step ran on), so an offline run reads exactly like a real one — just free and untimed, since a stub run records no cost or duration.

  Both paths share one step-render shape, so the inspector can never disagree with itself about how a run looks. The inspector names the capability a step called, never a model.

- b6b9d16: Restore the `resolveCoreBaseUrl` helper that the actions router relies on to derive the core API base URL. It is now co-located with `resolveAgentsBaseUrl` (its only dependency) instead of living in a since-removed module, so the harness server builds and the actions router self-defaults its base URL again.
- b6b9d16: Wire the Studio's Deploy, Prod-run, and Run-local buttons to their direct routes instead of typing a command into the coding agent:

  - **Deploy** streams build status and refreshes the workflow once it publishes, flipping the Draft/Deployed state.
  - **Prod-run** starts a real execution and hands the new execution off to the run inspector, so it shows up in the Steps view.
  - **Run-local** runs the workflow offline with capabilities stubbed and reports the outcome — no network, no spend.

  These three actions now run without a coding-agent session, so they consume no LLM credits. Debug, Explain, and free-form prompts still go through the coding agent, and Visualize is unchanged.

- Updated dependencies [b6b9d16]
  - @sapiom/agent-core@0.9.9

## 0.1.5

### Patch Changes

- 5752434: Show live run status on the canvas step graph itself — each step node lights up running/passed/failed with latency while a run executes, and the header badge switches to running/testing — replacing the separate status panel.
- 5752434: Show per-step and total run cost (in credits) on the live canvas — total at the top, per-step in the step panel — and include cost in the debug-macro context.
- 5752434: Show the live run canvas for runs started via the agent tooling, not just the CLI. The run detector now recognizes the run tool's `executionId` result in addition to the CLI's start line, so pressing Prod Run lights up the live step graph. Also stop polling a run whose state can't be fetched after repeated attempts, so a stale or malformed id can't poll indefinitely.
- 5752434: Show a live step graph on the canvas while a deployed run executes — steps update from running to passed/failed with latency, driven by the run-state poll loop.
- 5752434: Add a harness endpoint that reports a deployed run's live per-step state (status, latency, errors, logs) so the canvas can show progress during a run. The Sapiom credential stays server-side.
- 5752434: Make the deployed-agent trigger snippet resilient when the agent's slug can't be resolved from the deployment. The panel now falls back to the project name (and flags it as inferred so you can verify) instead of showing a fill-in placeholder in the read-only slug field, and it targets the configured Agents API host so the copy-paste call reaches the same environment the agent was deployed to.
- 5752434: Click a step on the live canvas to see its status, latency, and logs, and run debug macros that hand the step's logs to your coding agent — plus a free-form ask.
- 5752434: Add the web poll loop that fetches a run's live state during execution — polling on a fixed cadence, stopping when the run finishes, and pausing while the tab is hidden.

## 0.1.4

### Patch Changes

- eff9d50: fix(harness): separate inspecting a workflow from binding it, and keep the rail highlight in sync with the canvas

  Clicking a workflow in the workspace rail used to immediately rebind it to the
  active session, so just _looking_ at another workflow clobbered what the session
  was working on. Selecting is now pure inspection (it highlights the row and docks
  the action strip); a session's binding changes only via an explicit "Work on
  this" control on the strip (or by running a macro against the workflow, which is
  already an explicit action).

  Switching session tabs now always snaps the rail/strip highlight to that
  session's own binding — including clearing it when the session has no binding, so
  the rail no longer stays lit on the previous session's workflow while the canvas
  shows nothing.

- 524ffdf: fix(harness): resume/history rows are distinguishable — real titles + branch/turns/last-active

  Resume-history rows were near-indistinguishable: on any long session the title
  fell back to the bare `agentSessionId` UUID (the tail-only transcript read
  missed the first prompt), and rows carried no differentiating metadata.

  The claude-code adapter now derives a human-readable title from Claude's own
  generated `ai-title` (falling back to a compaction `summary`, then the first
  human prompt, then the directory basename — never a bare UUID), and surfaces
  the session's git branch and an exact human-turn count. Transcripts small
  enough to scan in full report an exact turn count; larger ones are still read
  only at head+tail (so the dropdown never parses a 100MB file) and simply omit
  the count. The history dropdown renders branch · turns · last-active under each
  title so many sessions in one directory can be told apart.

- c8eecf0: fix(harness): workspace/workflow rail no longer clips below the fold on first paint

  `.rail` was missing `min-height: 0`, so as a grid/flex item it grew to its
  content height instead of the grid row's — the nav clipped below the fold and
  `.rail-list`'s `overflow-y: auto` never engaged until a reflow (only a hard
  refresh appeared to fix it). The rail is now constrained to the viewport and
  scrolls internally on the initial render.

- Updated dependencies [c8eecf0]
  - @sapiom/agent-core@0.9.5

## 0.1.3

### Patch Changes

- 5b8dacc: Fix the Skills panel and stale workflow bindings.

  - Skills panel: the package-skill scan now resolves `@sapiom/agent-core` via
    Node's module search list, so bundled Sapiom skills (e.g. sapiom-agent-authoring)
    appear under any install layout — previously `npx @sapiom/harness` hoisted the
    packages into a shared `node_modules` and the scan (which only looked in the
    harness package's own nested `node_modules`) found nothing.
  - The panel now lists only Sapiom package skills by default; a developer's
    personal `~/.claude/skills` are opt-in (`showUserSkills`) so they don't clutter
    the product's skill list.
  - Sessions now drop a persisted workflow binding that points outside their own
    workspace on load, so the canvas never renders a stale workflow left over from
    an earlier session in a different directory.

## 0.1.2

### Patch Changes

- 0cc7cd5: Fix two canvas v0 bugs:

  **UI (CanvasPane)**: While an enrichment task runs, the activity strip now overlays the iframe instead of replacing it. The deterministic SVG render is visible immediately after binding; the spinner appears on top during the LLM annotation pass and disappears on completion. Failure state (Retry/Dismiss) remains full-screen and is unchanged.

  **Server (forceRefresh)**: The already-running check for a workflow's enrichment task is now performed before any cache invalidation or re-render. A double-clicked Visualize correctly rejects with a 409 and leaves the enrichment cache and render files exactly as the still-running task will need them.

- a318f0b: HarnessAdapter registry with embedded/external modes

  - Introduces `HarnessAdapterInfo` union type (`EmbeddedHarnessAdapterInfo` | `ExternalHarnessAdapterInfo`) with a `mode` field distinguishing harnesses spawned by the harness server from companion-app harnesses that own their own sessions.
  - Adds a data-driven registry (`createHarnessAdapterRegistry`, `listHarnessAdapters`, `getHarnessAdapter`) backed by five built-in adapters: claude-code, codex (both embedded), pi, opencode (embedded, experimental), and conductor (external).
  - Each adapter entry carries an `installMcpPrompt()` method with per-harness MCP install guidance — the skills-panel Install MCP modal reads these from the registry rather than embedding its own copy.
  - Adds `GET /api/harnesses` endpoint returning all adapters with `id`, `label`, `mode`, `experimental`, and `installed` fields. Embedded entries are session-createable today; external entries expose `mode:"external"` for future UI rendering.
  - Adds `ExternalHarnessError` (code `HARNESS_EXTERNAL`, HTTP 409) thrown from `SessionManager.getAdapter()` (resume path) and `SessionManager.submitInput()` (input path) when a session's harness id resolves to an external-mode adapter. A `sessions.json` entry written by an earlier build, hand-edited, or imported with `harness="conductor"` now surfaces a clear "managed by the Conductor app" 409 instead of a generic adapter-not-found error or a silent 404.
  - Exports `SPAWNABLE_HARNESS_KINDS` as a const tuple from `shared/types.ts` — the single source of truth that both derives the `HarnessKind` type and supplies the values to `z.enum()` in the session-creation schema, preventing drift between the two.
  - Routes the codex-tailer branching in server/index.ts through `adapter.eventSource` instead of a hardcoded `session.harness !== "codex"` check.
  - `UnknownHarnessAdapterError` (code `UNKNOWN_HARNESS_ADAPTER`) is thrown by registry lookups for unknown ids, listing known ids in the message for self-correction.
  - claude-code and codex behavior is byte-identical — no changes to their existing runtime adapter implementations (launch/resume/doctor/listPastSessions).

- c8c4746: Remote telemetry now reaches the hosted collector.

  The bespoke `CollectorBatcher` (which posted to a non-existent `/v1/harness/events` endpoint) has been replaced by `@sapiom/analytics-core`. Events are now delivered to `POST /v1/analytics/collector` — the same endpoint used by all other Sapiom SDK packages.

  **What changes for users:**
  - Remote telemetry (consent-gated, as before) now actually works. Previously all remote traffic was silently dropped because the target endpoint did not exist.
  - The local `~/.sapiom/harness/events.ndjson` sink continues to be written on every event regardless of consent, unchanged.
  - Consent behavior (stored settings toggle, `--no-telemetry` flag, `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) is unchanged.
  - Anonymous identity migrates: on first boot after upgrade, the install's existing `~/.sapiom/harness/machine-id` value is seeded into `~/.sapiom/analytics.json` so the longitudinal join key survives across versions.

- 97e8259: Awaitable kill for harness sessions and tasks with liveness-fallback resolution.

  `SessionManager.kill()` now returns `Promise<boolean>` that resolves once the
  process is **actually gone** — not fire-and-forget. Existing callers that do not
  await the return value keep working unchanged.

  Resolution is driven by whichever path fires first: node-pty's real `onExit`
  event, or a synthesized exit from `kill()`'s own escalation path. The escalation
  path is genuinely bounded:

  1. SIGTERM sent immediately.
  2. After `KILL_ESCALATION_MS` (2000 ms): if still alive, send SIGKILL.
  3. After a further `KILL_ESCALATION_CONFIRM_MS` (500 ms): `markExited()` is
     called **unconditionally** — SIGKILL has been sent and the window has
     elapsed, so the session is over regardless of any liveness probe. This
     prevents an EPERM zombie (a process that `isPidAlive` still reports as alive
     after SIGKILL) from leaving the promise pending forever.

  `SessionManager.killAll()` is now `async` and resolves when all concurrent kills
  have confirmed death via `markExited()` — the single convergence point for real
  and synthesized exits alike.

  `TaskManager.killAll()` gains the same awaitable treatment with SIGTERM→SIGKILL
  escalation and per-task exit promises wired through the existing `finish()`
  convergence point. After the SIGKILL confirm window, `finish(id, null)` is
  synthesized for any still-registered process — a zombie that never emits an exit
  event is declared dead rather than leaving `killAll()` pending forever.
  `finish()`'s idempotence guard prevents a double-fire if the real exit event
  arrives concurrently.

  Server shutdown (`close()` in server/index.ts) now awaits both `killAll()` calls
  with a 5-second outer timeout, so the process actually exits cleanly instead of
  leaving orphaned agent children.

- 1ff8d3c: Document that the harness is also launchable via `sapiom dev [dir]` from `@sapiom/cli`.
- 6d7ccd8: Packaging polish: LICENSE file, explicit exports map, and pack-contents audit.

  Adds a per-package LICENSE file (MIT, matching repo root) so published tarballs include it. Adds an explicit `exports` map with a main entry (`"."`) and `"./package.json"` sub-path — the latter is required by `@sapiom/cli`'s `createRequire().resolve('@sapiom/harness/package.json')` resolution path; without it a conditional-exports package would fire `ERR_PACKAGE_PATH_NOT_EXPORTED` and break `sapiom dev`. Updates `files` to include `LICENSE`, `CHANGELOG.md`, and `README.md` alongside `dist`. Excludes `src/test-setup.ts` from the build tsconfig so `dist/test-setup.*` no longer appears in the published tarball. Stays ESM-only (`"type": "module"`) — the harness is an app-style bin package, not a library; a dual CJS+ESM build would introduce the dual-package hazard for the typed error hierarchy (`instanceof` dispatch) with no user benefit.

- e0334ca: Terminal-only center pane for v0

  The center pane renders the xterm terminal as the sole content when a session
  is live, and the exited-session overlay (resume / close) when the session has
  exited. The first-run welcome panel continues to appear when no session exists
  on a fresh install.

  - Analytics hook pipeline (SessionStart / UserPromptSubmit / PreToolUse /
    PostToolUse / Stop / SessionEnd → /ingest → normalizer → store + emitter →
    collector) is fully intact and independent of the center-pane shape
  - Skills panel, canvas, consent chip, telemetry, adapter registry, session
    kill/resume, and typed errors are all preserved

- 6c64501: Internal robustness fixes (no behavior change for users):

  - Serialize WorkflowRegistry writes through a promise queue so concurrent prune/scan/connectPath calls can't interleave and drop entries from workflows.json.
  - Thread the resolved workflow path from the macros router into background task requests so TaskManager can dedupe per-workflow across sessions, not just per-session.
  - Make the workspace-watcher polling fallback walk async (fs/promises) to avoid blocking the event loop on wide directories; lengthen the poll interval to 2 s.

- 58ec57f: Fix Sapiom skill registration in harness sessions. `@sapiom/agent-core` now
  exposes its `package.json` through the `exports` map so consumers can resolve
  its bundled `skills/` directory; previously `require.resolve` threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` and the skill silently never loaded. The harness
  skill-plugin resolver also gains a fallback that locates the skills directory by
  resolving the package's main entry when the `package.json` subpath isn't
  exported. Skills register under the `sapiom` plugin namespace, so the
  agent-authoring skill is available as `/sapiom:sapiom-agent-authoring`.
- 1b355a4: Typed error codes on session and spawn failures; HTTP status mappings unchanged.

  Adds a `HarnessError` base class and five typed subclasses — `UnknownSessionError`, `SessionNotReadyError`, `SessionNotResumeableError`, `SessionAlreadyLiveError`, `AdapterNotFoundError` — each carrying a stable machine-readable `code` property. Server routes now dispatch on `instanceof` rather than parsing `error.message` text, so future message rewordings cannot silently alter the HTTP status they produce. Wire responses and response body shapes are unchanged.

- a686143: Skills panel Use button populates the terminal (no auto-submit); Sapiom skills registered as session slash commands via --plugin-dir.

  - Re-adds the "Use skill" button to the skill detail view. Clicking it calls
    `injectInput` with `submit:false`, writing the text to Claude's input line
    without sending Enter — the user edits and presses Enter themselves.
  - Package skills populate `/<id> ` (slash command with trailing space for args);
    user skills populate a natural-language invocation `Use the "<name>" skill: <desc>`.
  - Button is disabled with a visible reason when there is no ready session.
  - On success, a toast confirms "Typed into the terminal — edit and press Enter."
  - Adds `generateSkillsPlugin` in `core/inject/skills-plugin.ts`: creates a
    per-session `--plugin-dir` from the Sapiom skills bundled in `@sapiom/agent-core`.
    claude-code auto-discovers `<plugin-dir>/skills/<name>/SKILL.md` and registers
    `/<name>` as a slash command. Gracefully no-ops when agent-core's skills dir is
    absent or unresolvable — the session still launches normally without the flag.
  - `LaunchOpts.pluginDir` added; `ClaudeCodeAdapter.buildConfigArgs` emits
    `--plugin-dir <path>` when set. Codex adapter ignores the field (unchanged).

- Updated dependencies [696f111]
- Updated dependencies [48fb35c]
- Updated dependencies [95bfcd1]
- Updated dependencies [bf44229]
- Updated dependencies [dab6d44]
- Updated dependencies [ebfa0bc]
- Updated dependencies [58ec57f]
- Updated dependencies [5e9659a]
  - @sapiom/agent-core@0.9.2
  - @sapiom/analytics-core@0.2.1
  - @sapiom/mcp@0.11.2

## 0.1.1

### Patch Changes

- Updated dependencies [5f73ae7]
- Updated dependencies [d661d57]
  - @sapiom/mcp@0.11.0
  - @sapiom/agent-core@0.9.0
  - @sapiom/agent@0.6.2

## 0.1.0

### Minor Changes

- 020139a: Canvas serving, macro engine, and dev-server port detection — the backend half of the canvas/action-rail/preview workstream:

  - `GET /canvas/:harnessSessionId/*` serves whatever a session's agent wrote to its `.sapiom/canvas/` directory, with a friendly HTML empty-state when nothing's been rendered yet.
  - `GET /api/macros` / `POST /api/macros/:id/run` resolve and execute the action-rail macros (`{{workflow.path}}`-style placeholder substitution, missing-value validation).
  - Per-session canvas file watching (`canvas.reload` on change) and streaming `localhost:<port>` detection (`port.detected`) for the Preview pane's port chip.

### Patch Changes

- Updated dependencies [020139a]
- Updated dependencies [020139a]
- Updated dependencies [c0fef6d]
- Updated dependencies [3dfbd10]
  - @sapiom/agent@0.6.1
  - @sapiom/agent-core@0.8.0
  - @sapiom/mcp@0.10.0
