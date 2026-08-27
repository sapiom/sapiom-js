# @sapiom/harness

## 0.9.0

### Minor Changes

- 37ab85b: Agents nested deep under a project root are discovered again: the scan now reaches 8 levels, bounded by a node budget rather than by depth alone.

  `AGENT_PROJECT_SCAN_MAX_DEPTH` was 3, which predated the project-rooted rail — it assumed the directory you opened was roughly the agent's own folder. Under a root you _choose_, depth is ordinary: `<root>/backend/src/agents/<agent>` is four segments down and `<root>/apps/<app>/src/features/<x>/agents/<agent>` is six. Those agents were not found at all and landed in "No workspace" — on a measured root, well over a third of the rail.

  Raising the depth alone would not have been affordable, and the numbers are why. Measured against real roots (macOS/APFS, warm cache, ~22-25 µs per directory entered):

  | root                            | depth 3    | depth 8              | unbounded   |
  | ------------------------------- | ---------- | -------------------- | ----------- |
  | a single repo                   | 119 dirs   | 242 dirs · 7 ms      | 242 dirs    |
  | a monorepo                      | 758 dirs   | 9,016 dirs · 196 ms  | 9,195 dirs  |
  | a monorepo with worktree copies | 1,298 dirs | 35,489 dirs · 847 ms | 47,544 dirs |

  So cost is linear and predictable in _directories entered_, and that is now what is bounded: `AGENT_PROJECT_SCAN_MAX_NODES` (10,000) for the registry scan, and a tighter `AGENT_PROJECT_WATCH_MAX_NODES` (2,500) for the workspace watcher's fingerprint, which is synchronous and re-runs on a debounce after every save. Pruning harder was the other candidate and does not pay — extending the ignored-directory list with the usual suspects removed 0.5–11% of the directories on those roots.

  The registry and the watcher now share one traversal in `core/agent-project-discovery.ts`, and it is **breadth-first**, which is what makes the budget safe: every level shallower than the cut is complete, so a truncated scan degrades by depth exactly as the fixed cap did — just at a depth the tree's real width chooses instead of one guessed in advance. A scan reports how far it got (`AgentProjectScanBudget.envelopeDepth`) and the registry reconciles only within that, so a bounded scan never mistakes "I did not look there" for "it is gone".

  Termination on a pathological tree does not depend on the cap: subdirectories are filtered on raw dirent type, so a symlink — including one closing a cycle — is never descended into. That is now asserted directly, and `src/core/agent-project-scan.perf.test.ts` measures the cost of both bounds on a deep monorepo fixture next to the depth-3 baseline.

- b66ff0e: Show every registry-known agent contained by an Agent Studio Project in that Project's graph, including local-only and disconnected agents, while preserving partial inventory with path-free warnings.
- b66ff0e: Detect literal direct agent `run` and `launch` relationships in Agent Studio Project graphs, distinguish blocking and asynchronous modes, and report dynamic targets without drawing misleading connectors.

  The syntax-only detector recognizes the exact `ctx.sapiom.agents` form plus proven named `agents` aliases and legacy `orchestrations.launch` imports from `@sapiom/tools`. Unlike the previous text match, unrelated local objects, custom context names, destructured namespaces, namespace imports, and optional chains are not inferred. The existing per-agent Canvas remains launch-only, so blocking `agents.run` calls retain their existing capability chip there until that Canvas supports blocking relationship nodes.

  TypeScript is now a Harness runtime dependency, constrained to the tested 5.9 compiler-API band, because published Harness and desktop servers execute the syntax parser locally.

- 37ab85b: Agent Studio's left rail is rebuilt around where an agent **is** and what it is **related to**, and it can now move an agent's directory on disk.

  **Two axes, chosen from the rail's own `Group by` control.** _Project_ files every agent under the project roots that contain it — the folder you opened, a folder you have a session in — with the branching directories between them as rows. An agent inside two roots you both opened appears under both; they are two contexts, and the old longest-prefix rule made the shallower project silently lose agents it plainly contained. _Group_ is the arrangement you make yourself: named groups per project root, seeded from the launch edges between agents and then yours to edit. The **Deployment axis is retired** — an agent's deploy state is a badge on its row, not a place it lives.

  **`Remove project`** takes a root off the rail without touching anything on disk.

  **`POST /api/agents/move` renames a directory in your working tree.** This is the Project axis's drag, and it is a real filesystem move, not a display preference: dropping an agent on a folder relocates that agent's directory there — `git mv` when the directory is tracked in a git repo, a plain rename otherwise. Nothing inside `sapiom.json` is rewritten, live sessions whose cwd sat inside the moved tree follow it, and the endpoint refuses on its own findings (a destination that exists, a destination inside the source, a `from` that is not a registered agent, or a destination outside the folders the rail shows) rather than trusting the caller.

  **New local REST surfaces** on the same `127.0.0.1` boot-token-gated `/api` mount as the rest:

  - `GET`/`PUT`/`DELETE /api/studio-rail` — the stored Group-axis arrangement, one `.sapiom/studio-rail.json` per project root. It is a committable file, so a team can share an arrangement. Writable roots are exactly the roots the rail can show.
  - `GET /api/studio-rail/launch-edges` — which agents launch which, across every registered agent, used to seed groups.
  - `POST /api/agents/move` — above.

  **Stored UI state resets once on upgrade, deliberately.** The rail's preferences moved to keys that can name a project, a directory or a group rather than only a cwd: `collapsedCwds` → `collapsedKeys` (namespaced `project:` / `dir:` / `group:`) and `railGrouping` → `railAxis`. The old values are not migrated — they describe a rail that no longer exists — so after upgrading, every fold is open and the axis is back to _Project_. Set them again once and they stick.

  There is no migration for project roots either: every directory already in your recents, and every live session's cwd, becomes a project row. Nothing is discarded, and `Remove project` is how the list gets shorter.

- 37ab85b: A canvas board can now be read by agent path, with no session involved: `GET /api/workflows/:path/graph`.

  The canvas was reachable only at `/canvas/:harnessSessionId/`, resolved by the session's current binding — so an agent that had never hosted a session had no board, and you could not look at agent F's board while working in agent B's session.

  This adds a second, session-free entry point onto the _same_ derivation. `deriveWorkflowCanvas` is extracted out of the render-file write path and shared by both, so the document this route returns is byte-identical to the render a bound session's canvas serves for the same workflow. Nothing is written to disk.

  `:path` is the agent's absolute directory, URI-encoded into one segment (`encodeURIComponent(agentPath)`), matching `/api/workflows/:id/input-contract`. It sits behind the usual `/api` boot-token middleware, so it is a `fetch` target rather than an `<iframe src>`.

  Failure modes are deliberately distinct: `400` for a blank, relative or `..`-carrying path (and for a `sapiom.json` symlinked out of the project), `404` only for a path that is not a registered workflow, and `200` with `status: "empty" | "preparing" | "error" | "ok"` for everything else — a missing `sapiom.json` is an empty board, never a missing route.

  Full contract: `packages/harness/docs/agent-canvas-graph.md`.

- b66ff0e: Keep Agent Studio Project dependency graphs current with revisioned lifecycle snapshots, per-agent relationship caching, and last-good stale or degraded presentation during refresh failures. Opening a Project graph arms one additional session-independent recursive watcher for that Project; inventory fingerprints and the polling fallback run asynchronously so wide Projects do not block the Studio server loop.
- b66ff0e: Render Project dependency graphs as full-main Agent Studio destinations with deterministic non-linear layout, routed invocation modes, stable per-Project pan and zoom controls, and exact agent-card navigation from both rail axes.
- b66ff0e: Add a cached local Project dependency graph to Agent Studio. Project labels on both the Project and Group axes open the graph; use the dedicated chevron to expand or collapse the Project's agents.

## 0.8.9

### Patch Changes

- 9165f18: Studio's coding-agent system prompt now says to omit `model`, states that `smart` is a no-op, and keeps size labels as the deliberate choice — matching the authoring skill, the MCP instructions, and the call-surface guide.
- Updated dependencies [054f749]
- Updated dependencies [db81e32]
- Updated dependencies [054f749]
  - @sapiom/mcp@0.13.0
  - @sapiom/agent@0.12.2
  - @sapiom/agent-core@0.13.2

## 0.8.8

### Patch Changes

- 672550f: Start fresh same-folder Claude Code or Codex conversations from browser-style session tabs in Agent Studio.
  - @sapiom/agent@0.12.1
  - @sapiom/agent-core@0.13.1

## 0.8.7

### Patch Changes

- 5409191: Recognize the Codex CLI 0.143 empty-composer screen so accepting a new
  directory's trust prompt releases Agent Studio's held initial prompt. Also
  best-effort recognize future composer copy changes from the input marker and
  cwd footer while known onboarding fragments remain blocking.

## 0.8.6

### Patch Changes

- 3d79aab: Release held Agent Studio prompts into Codex once its terminal has rendered a
  stable, non-blocking screen. Partial terminal repaints retain recognized
  blockers until the empty composer is positively identified, while a bounded
  fallback prevents animation or an incomplete repaint from waiting forever.
  Initial prompts remain held through Codex trust, sign-in, and setup flows, and
  Claude Code's SessionStart readiness behavior is unchanged. Codex may now
  report `ready: true` before its first rollout/transcript exists: readiness
  describes an input-safe TUI, not durable conversation metadata.

## 0.8.5

### Patch Changes

- Updated dependencies [555475d]
- Updated dependencies [52efab3]
  - @sapiom/agent@0.12.0
  - @sapiom/agent-core@0.13.0
  - @sapiom/mcp@0.12.10

## 0.8.4

### Patch Changes

- Updated dependencies [9afeda9]
  - @sapiom/agent@0.11.0
  - @sapiom/agent-core@0.12.2

## 0.8.3

### Patch Changes

- 5a8eeea: `DEFAULT_SYSTEM_PROMPT` gains a compact "Calling LLMs from agent code"
  section — the same LLM call-surface rule taught in the MCP instructions and
  the `sapiom-agent-authoring` skill, kept to ~8 lines since the prompt is
  injected fresh into every Studio session's context. Also corrects the
  adjacent "sapiom (remote, HTTP)" bullet's vague "models" capability mention
  to point at the new section.
- Updated dependencies [00b8814]
- Updated dependencies [5a8eeea]
- Updated dependencies [5a8eeea]
  - @sapiom/agent-core@0.12.0
  - @sapiom/mcp@0.12.8
  - @sapiom/agent@0.10.1

## 0.8.2

### Patch Changes

- Updated dependencies [af764cd]
  - @sapiom/agent@0.10.0
  - @sapiom/agent-core@0.11.4
  - @sapiom/mcp@0.12.7

## 0.8.1

### Patch Changes

- 7d4f13a: Allow files to be picked, dropped, or pasted into the create-new composer so they arrive with the agent's first request.
- 13e5867: Start new and resumed interactive Claude Code sessions in Auto mode when the
  account supports it. Bypass permissions is available as an explicit Shift+Tab
  choice for accounts without Auto mode; it is never activated silently.
  Headless tasks keep their existing permission mode.
  - @sapiom/agent@0.9.4
  - @sapiom/agent-core@0.11.1

## 0.8.0

### Minor Changes

- b1d791b: Add an artifact-first Studio run workspace for local and cloud agents. Studio now
  collects schema-driven input, streams chronological attempt evidence, renders
  bounded outputs with Rendered and Raw views, and provides an isolated Focus mode
  for inspecting input, output, state, directives, logs, and recorded capability
  calls.

  Local agent execution now emits start and settled trace events with timing,
  directive, shared-state, log, and capability-call evidence. Desktop development
  launches rebuild Harness first so Electron always opens the current Studio UI.

### Patch Changes

- bb0df7d: Canvas: open the right pane when a real step graph renders, not when scaffolding is written

  A canvas WRITE is not a canvas RESULT. The pane revealed itself on every
  `canvas.reload`, and the "Preparing your agent — installing dependencies"
  placeholder written while npm runs is exactly such a write — so a fresh
  scaffold popped the pane open on setup state and presented it as the result
  (the server's "Rendering agent diagram…" pending document does the same to the
  mount probe).

  The reveal now waits for the document to post `sapiom-canvas:graph`, which only
  a real render embeds and the placeholders deliberately omit. Nothing is
  deferred but the reveal: a collapsed pane is hidden with `display:none`, never
  unmounted, so the iframe still loads and swaps its document in the background
  and the board is there the instant it is worth showing. Absence of content is
  still announced immediately, so an empty pane still hides itself.

- 8ef5374: Restore drag-and-drop of images (and any file) into the Studio terminal. Removing the image composer (#562) left drops with no handler at all — xterm.js has no native drop behavior, so in the desktop app a dropped image was handed to the OS viewer instead of the agent. A drop on the terminal now behaves like a native emulator: the desktop preload resolves the dropped File to its real path (`webUtils.getPathForFile`) and the SPA pastes the quoted path into the pty, which Claude/Codex pick up natively (`[Image #1]`). Stray drops elsewhere in the SPA no longer navigate the page away.
- f5a67c2: Clicking a link in the terminal opens the actual URL instead of a macOS "no application set to open the URL about:blank" dialog

  The xterm web-links addon's default activation opens a blank window first and
  assigns `location.href` afterwards. The desktop app's window-open handler
  intercepts that first call, sees only `about:blank`, and hands it to the OS —
  which has no handler for that scheme, so the link dies in a system dialog. The
  terminal now passes the clicked URL directly to `window.open`, and the desktop
  host additionally refuses to hand anything but `http(s):`/`mailto:` URLs to
  `shell.openExternal`.

- Updated dependencies [b1d791b]
  - @sapiom/agent-core@0.11.0
  - @sapiom/mcp@0.12.6

## 0.7.0

### Minor Changes

- 3cbe957: Command palette: a proper fuzzy finder, redesigned as Command Search

  The Cmd+K palette is rebuilt around the reported search failures ("cannot find
  this simple agent"): short queries no longer "match" characters scattered
  across absolute paths, duplicate past sessions no longer flood the list, and
  what you search is what the rail shows.

  - **Boundary-gated matcher** (`web/src/lib/fuzzy.ts`): every matched character
    must be contiguous with the previous one or sit at a word/segment boundary,
    with a substring fallback for mid-word fragments. Scattered-noise matches are
    rejected outright, not merely down-ranked. Multi-term queries AND across
    whitespace.
  - **Ranking model** (`web/src/lib/palette.ts`, new): rows carry display names
    (`displayAgentName`, `sessionDisplayName` — user renames are searchable);
    same-title same-folder past sessions collapse to the newest; sections order
    by their best hit with per-section caps (lifted when only one kind matches);
    recency is a bounded score bonus that never lifts a path-only match over a
    name match.
  - **Command Search surface** (per the design-eng widget): a search bar with a
    clear button, filter tabs — All / Sessions / Agents / Templates / Docs /
    Files / Actions — cycled with Tab/Shift+Tab, and a shortcut-bar footer. App
    verbs (browse templates, toggle theme, panel toggles, new session here) are
    injected actions; the Templates tab lists the catalog and opens the gallery
    focused on a template; the Docs tab searches a short list of docs pages with
    the docs site as the footer destination.
  - The active session is badged "current", demoted from the unqueried top spot,
    and never the default selection; matched characters render on an
    accent-tinted cap that stays legible on selected rows in both themes.

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

### Patch Changes

- 4edcbf5: Update the bottom toast to the design-system widget spec: the tone now lives in a leading icon — a green circled check for success, a neutral ⓘ for information, a red ⚠ for errors — instead of a red edge stripe on every toast (which error-coded even "Path copied."). The card itself is the shared floating surface every popover uses. Toasts default to the error tone; positive results (copy confirmations, deploy success, describe finished, agents found, up-to-date/downloaded update checks) opt into success, and neutral status (deploy progress, editor hand-offs, empty scans) opts into info. Also: spring entrance and a short exit animation, the auto-dismiss timer pauses while hovered or focused, and the dismiss control is the shared 22px icon button.
- Updated dependencies [f21f6a6]
  - @sapiom/agent-core@0.10.7
  - @sapiom/mcp@0.12.5

## 0.6.0

### Minor Changes

- 928a639: Studio: a new agent's workspace folder now appears in the rail the instant you
  start creating it — from the composer or a template — as an optimistic
  "Creating agent…" row, pinned to the top and focusable. It stays put through
  session-landing and the clone, and across the brief window after the session
  binds but before its `sapiom.json` is registered, so switching sessions
  mid-creation can never strand the in-progress agent.

  Also fixes two rail/canvas issues:

  - **Canvas no longer clips the terminal step.** A revise loop (a step pointing
    back to an earlier one) left a gap in the layer numbering; the SVG height was
    derived from the layer _count_ while nodes were positioned by their raw layer
    _index_, so the deepest node (a terminal like `deliver`) fell below the
    viewBox and was drawn off-screen with a dangling edge. Rows are now compacted
    to consecutive positions, which also removes the empty band the gap produced.
  - **Cloned agents show a short name in the rail.** The row now reads
    `newsletter-autopilot` rather than the full package name
    `@sapiom/example-newsletter-autopilot` (npm scope and a leading `example-`
    stripped for display only — the full name is on hover, and the raw name still
    keys testids and lookups).

- 5c0c646: Rail footer: live plan & balance card, and an "Update now" card for a downloaded desktop update

  The rail's footer gains two shaded cards above the account row.

  - **Plan & balance card** (both hosts): the harness server relays core reads at
    `GET /api/account/plan` — the API key never reaches the page — showing the
    org's plan name and one honest money line: daily spend against the org's
    spend-limit rule (the same "$used / $cap" pair the dashboard renders),
    falling back to the prepaid available balance, else nothing. An Upgrade pill
    and a ⋮ menu deep-link to billing/usage on the dashboard (checkout is
    dashboard-session-only). Signed-out or unreachable hides the card — it never
    invents a number.
  - **"Update now" card** (desktop only): when an update has finished
    downloading, the main process pushes state over a new receive-only
    `onUpdateState` bridge member (re-pushed on page load, buffered in the
    preload so a reload can't drop it) and the card appears with the target
    version. Clicking it goes through the existing `checkForUpdates()` — the
    pending branch re-raises the update window — so there is still no
    page-reachable install channel. It outlives "Later"; "Skip this version"
    suppresses and retracts it (and now also disarms auto-install-on-quit for a
    skipped build that was already staged).

### Patch Changes

- 651c407: Canvas extraction failures now name the project directory they bundled. The Canvas is the only `check()` caller whose directory the user never typed — it comes from the bound workflow row — so a report of "check, run_local and deploy succeed but the Canvas fails on the same project" was unfalsifiable from the panel alone; esbuild's own paths are printed relative to the invoking package, which reads like the bundler resolving `node_modules` from the wrong root.
- 7bef8b2: Stop the empty-board auto-collapse from closing a canvas pane the user just opened. The collapse fires once per (session, binding), which was meant to make a redundant "still empty" probe harmless — but the pane's expand control is most often used right after starting a session on an agent, i.e. _before_ `activeSessionId` exists, so the probe that follows arrives under a different key and slams the pane shut a beat after the click (measured: 3–5 of 12 runs of the action-bar e2e, on `main`). A manual expand now claims the session, and a claim made while none is active adopts the one that reports next; switching sessions still re-arms the collapse.
- 95241fb: Give the rail toggle a resting surface while the app window is blurred: macOS hides the traffic lights it sits beside, so the bare glyph read as a gap on the left of the header.
- 21bb3f0: Let "Open in editor" target the editor you actually use.

  The session menu hardcoded `vscode://file…`, so on a machine with Cursor (or
  Windsurf, Zed, VS Code Insiders) and no VS Code the item silently did nothing —
  the OS resolves the scheme and never reports back, so an unhandled scheme is
  indistinguishable from a working one. Settings now carries an editor picker
  (`HarnessSettings.editor`, `PATCH /api/settings`), the menu item names the
  chosen editor ("Open in Cursor"), and a toast says where the folder was sent.
  Windows paths are normalized to the `/C:/…` shape the handlers expect.

- Updated dependencies [651c407]
  - @sapiom/agent-core@0.10.6

## 0.5.1

### Patch Changes

- 7612e30: Submit injected prompts as a bracketed paste, so a click that sends a prompt to the CLI chat lands as one prompt and actually sends. Multi-line prompts (the canvas chat prepends step context to every question) no longer submit at their first newline, and the trailing Enter is a keypress rather than a race against the coding agent's paste heuristic — which is why the same click sometimes needed a manual Enter. Sessions whose harness never enables bracketed paste keep the previous raw write.

## 0.5.0

### Minor Changes

- 5aa3e01: Give the account menu's "Overview" its own page — a proper introduction to Agent Studio

  "Overview" used to be an alias for the composer home. It now opens a standalone
  Overview destination (`OverviewPanel`) that introduces the app: the
  build-with-your-coding-agent → shape-on-the-Canvas → run-on-Sapiom loop, a
  "How it works" trio, and a grid of what's in the window (embedded coding agent,
  Agents rail, Canvas, Templates, deploy, production run, Sapiom capabilities,
  zero config mutation). It renders as a full-width destination like Templates
  (`.app.is-browsing` hides the panes) with its own top bar, a Build-an-agent CTA
  into the composer, and a Start-from-a-template shortcut.

  The page follows the Studio brand: neutral chrome throughout, with the scarce
  green (`--brand`) spent only on the three "how it works" glyphs. First run warms
  the eyebrow to a welcome and, when signed out, hints at connecting a Sapiom
  account. "Create new" (the composer) is unchanged and remains the primary
  creative action.

### Patch Changes

- 19b8bbb: Install a new agent's dependencies on scaffold, and turn the Canvas's "Could not resolve …" render error into an actionable "run npm install" hint

  The Canvas step-graph extraction (`check` / `loadDefinition`) esbuild-bundles a project's `index.ts` resolving its imports — `@sapiom/agent`, `zod`, … — from the project's own `node_modules`. A newly-scaffolded (or freshly-cloned) agent whose deps were never installed therefore failed its very first, unprompted Canvas render with a raw esbuild wall (`Could not resolve "@sapiom/agent" … Could not resolve "zod"`), which the failure panel relayed verbatim.

  Two fixes:

  - `scaffold()` gains an opt-in `installDependencies` flag (returned as `dependenciesInstalled`), and the `sapiom_dev_agents_scaffold` MCP tool — the Studio's create path — now passes it, so a new agent opens with a working Canvas. Best-effort and non-fatal: a missing/offline npm still yields a successful scaffold. The `installProjectDependencies` helper (previously demo-only inside the harness's example seed) now lives in `@sapiom/agent-core` and is shared by both.
  - `check` and `loadDefinition` now route bundle failures through `describeBundleFailure`, which detects the "no `node_modules` + unresolved import" case and returns `Dependencies are not installed. Run \`npm install\` in <dir>, then try again.` (preserving the raw esbuild detail). Every other bundle failure's message is unchanged.

- 03d23c8: Hold a new session's first prompt until Claude Code is signed in

  Starting a session from the composer (or a template/clone) created the session and then fired the initial prompt immediately, retrying only on a 409 for ~9s. But a Claude Code session only becomes injectable once its `SessionStart` hook fires — which doesn't happen until the user is past Claude's own login/onboarding. A first-time, not-yet-signed-in user therefore blew past the 9s window and the prompt was silently dropped.

  The prompt is now held per session and sent the moment the session reports ready (i.e. Claude is signed in and interactive). If the session is still not ready after a short grace, a hint points the user at the terminal login ("Sign in to Claude in the terminal — your prompt sends automatically once you're signed in"), so first-run intent is preserved instead of lost.

- Updated dependencies [19b8bbb]
  - @sapiom/agent-core@0.10.5
  - @sapiom/mcp@0.12.4

## 0.4.1

### Patch Changes

- e3b2e7a: Studio's top bar, rail icon, and window floor:

  - While the composer home is up there is no session to name, so the bar's first
    slot carries **Back** (a left arrow) to the session the composer was opened
    over, replacing the inert `💬 new session` pill — and the composer's own
    floating Back, which duplicated it and overlapped the heading on a narrow
    window. With nothing behind the composer (first run, every session closed) the
    slot is empty rather than offering a Back that goes nowhere.
  - "Add existing agents" now reads with a folder**+** glyph instead of the open
    folder it shared with the Workspaces header.
  - The desktop window refuses to resize below **560×480**: dragged narrower, the
    app became a strip of overlapping labels. The starter-template row also drops
    to one column under 640px, where two cards left the names ellipsized past the
    words that tell templates apart.

- a34bd32: Studio UI fixes from design review:

  - **Canvas chat input**: the "Ask about this agent/step" field is now a clean, boxless single row — no border, padding box, or separator hairline — that auto-grows upward up to five lines (then scrolls) with the Ask button bottom-anchored.
  - **Canvas overview card**: no longer repeats the step/exit count or the entry/step/terminal legend that the canvas board already shows; the card focuses on the description, Describe-with-AI, notes, and per-step detail.
  - **Rail brand header (frameless macOS)**: the Sapiom wordmark drops off the traffic-light line and reads inline as "sapiom agent.studio"; only the theme/collapse tools ride the lights' line.
  - **Account menu**: opening the account menu now collapses the settings card (and vice-versa) so the two never stack; the Workspaces ⋯ menu's Past-sessions sub-card also collapses when a grouping/sort choice is clicked.
  - **"Create new"**: promoted above Search as the primary affirmative action, restyled to the app's solid ink-button CTA (the Deploy treatment) with the reserved brand-green plus; the empty-rail state keeps a brand halo.
  - **Rail spacing**: top-level rail rows share one icon size, icon–text gap, and left inset.
  - **Sign-out**: removed the duplicate Disconnect from the settings panel — signing out now lives once in the account menu, below "Check for updates" and only when signed in.
  - **Composer**: dropped the redundant "New session" + from the top bar of the create-new composer — you're already starting one there.
  - **Canvas pane reveal**: an empty agent's board no longer snaps the canvas shut again right after you manually open it (a reveal race that also flaked CI); a live render still re-opens a pane you'd collapsed, and switching agents still follows the new board.
  - **Collapsed panels**: the expand control is now the mirror of the collapse icon (a panel-open glyph, same quiet style) instead of a menu/list icon; the rail's top tools line up with the icons below them; and the Templates header no longer collides with the macOS traffic lights when the left panel is collapsed.

- Updated dependencies [0bf040f]
  - @sapiom/agent-core@0.10.4
  - @sapiom/mcp@0.12.3

## 0.4.0

### Minor Changes

- feaaeaa: Make Test / Run / Deploy observable in Studio: clicking one now reveals the
  right pane and switches it to the Steps view (the unified activity surface),
  instead of the action landing silently.

  - **See it move.** A run's steps advance pending → running → passed in view; the
    acting button carries a `data-running` pulse tied to the real run status (not
    just the brief hand-off ring); and the demo prod run now progresses across
    polls on a wall clock rather than snapping to "completed".
  - **Relevant final data up front.** A run-summary card headlines the Steps
    surface — outcome, live progress, total duration, and the single most relevant
    result CTA (the deployed agent's dashboard link → a dev-server preview →
    URLs the run produced → the final step's output). Honest-absence throughout:
    no cost fields, no latency on a still-running step, no fabricated values.
  - **Better payload CTAs.** Input / Output / Logs / Result share one disclosure
    with a Copy button (the final Result renders expanded); nothing renders for a
    payload a step never carried.
  - **Deploy as an action, not a toast.** Deploy lands in the same Steps surface
    with a live linking → building → deployed banner, then a completion state that
    links to the dashboard and jumps to the "Trigger from your code" snippet.

  Note: after an action, the persisted right-pane tab is Steps.

- 2c4e8d9: Studio now emits agent-lifecycle product events to PostHog, so the build →
  templates → deploy funnel is measurable.

  - `agent.created` — a new agent came into existence (a fresh `sapiom.json`
    appeared in the workspace registry), deduped by path and seeded on first load
    so pre-existing agents are never counted. This is the "agents built" metric —
    confirmed existence, not the click that kicked off scaffolding.
  - `agent.template_cloned` — a template was used to start an agent, carrying the
    template slug and the on-ramp surface. The "templates used" metric.
  - `agent.deploy_started` / `agent.deploy_succeeded` (with duration) /
    `agent.deploy_failed` (coarse `error_kind` enum) — the "agents deployed"
    metric, fired from the deploy stream.

  Payloads carry ids / enums / counts / durations only — never prompt text, file
  contents, or absolute paths. Capture stays gated by the existing
  product-analytics consent tiers and is disabled under mock/e2e.

### Patch Changes

- 38a7327: Studio's canvas pane now simply follows the active session's board: whenever a
  session has a rendered board, the pane is shown; when it doesn't, it stays
  closed. This replaces the previous auto-reveal, which fired only once and only
  for sessions born from the composer — so a resumed session that built an agent,
  or opening an already-populated agent, left the freshly-rendered board sitting
  in a collapsed pane the user had to open by hand.

  Now any live render (a `canvas.reload` for the active session — a finished
  build, a re-render) opens the pane on its own, and switching to a populated
  session shows its board straight away. Trade-off of the simpler model: a manual
  collapse of the canvas is no longer a persisted arrangement — it lasts until the
  next render or session switch (the rail collapse and the Canvas/Steps/Code tab
  still persist). Exited sessions keep their pane open for the "resume to see it"
  invite.

- 0b0784c: Fix the Canvas showing a raw "Render failed" esbuild dump (`Could not resolve
"@sapiom/agent"` / `"zod/v4"`) on a freshly scaffolded agent, before its
  `npm install` has run. Studio now shows a calm "Preparing your agent…"
  placeholder while dependencies are missing and auto-renders the step graph the
  moment they land — no Retry click. Readiness waits for the whole declared
  dependency set (walking `node_modules` up the tree as esbuild does), so a
  partial install can't flash the error. The Canvas empty-state and "rendering…"
  pages are now theme-aware, matching the app's light/dark theme instead of always
  painting a white panel.
- 0b0784c: Fix new agents nesting under `projects/<agent>/projects/…` in Studio, deepening
  on every launch. The desktop host derived its launch dir from the most-recent
  session dir, which drifted into a project folder — so `<launchDir>/projects`
  (where new agents are created) appended a second `projects/` inside it, and the
  new agent's session cwd fed back in to nest even further next time. Pin the
  launch dir to the harness home so every agent stays flat under one `projects/`
  and the rail scans them all. The same `projectRoot` pin also fixes the template
  destination, which nested (and failed with "Couldn't read that directory") for
  the same reason. The "Add existing agents" folder picker now opens on the
  project root where agents live.
- 58f8008: Fix two issues on the Templates screen in Studio:

  - The info (i) spec sheet popover rendered with no surface — its background,
    border, and shadow were missing, so the Steps / Trigger / Complexity /
    Capabilities list and the Preview / Use buttons painted directly over the card
    behind it. `.template-facts` now opts into the shared popover elevation recipe.
  - The Templates destination hid the workbench, but the rail's other nav actions
    never cleared it, so clicking Create new, Search, or an agent/session row left
    you stranded on the browser until you used the back arrow. Navigating anywhere
    now dismisses the Templates screen the same way the back arrow does.

- 1b3c103: Recolor the embedded terminal so Claude Code's accent colors match the Studio
  brand, without touching the terminal background.

  Claude Code renders in 256-color by default, so the terminal's own 16-color
  palette never reached its output — its "blue", "green", etc. were Claude's, not
  Studio's. Each Claude session is now pinned to Claude Code's `dark-ansi` /
  `light-ansi` theme (matched to the app theme) through the generated `--settings`
  file, which routes Claude's colors through the terminal's ANSI ramp. That ramp
  (`Terminal.tsx`) is retuned to a brand-coherent palette: a calmer blue, the
  Studio green for success/live state, and harmonized red / yellow / cyan /
  magenta that read cleanly on the recessed `--bg` surface (which is unchanged).

  The app theme is threaded through session create and persisted on the session so
  resume keeps the same base; unthemed launches (server-side auto-create, a legacy
  session resumed from before this existed) omit the theme and keep Claude's
  default rendering.

## 0.3.0

### Minor Changes

- 533cc88: The Studio "new session" experience is now composer-first. Instead of opening on a terminal-and-canvas workbench (with the canvas showing "nothing generated yet") behind a first-run welcome overlay, a fresh install — and Create new / New session / the + — opens a centered composer: a greeting, **"What should your agent do?"**, quick-idea chips, an input with an agent selector and send, and a **"Start from a template"** row. Describing an outcome starts a session and hands the agent that outcome (the same create+inject path the "start from an idea" door uses); the screen then gives way to the terminal, and the canvas slides in only once that session generates content — the manual show/fold still overrides. The first-run WelcomePanel overlay is retired; its open-folder, browse-templates, docs, and telemetry opt-in fold into the composer, and recent workspaces live in the rail.
- 7ae67f6: Studio (web app) redesign to match the new brand.

  Adopt the shared design-system's named `sapiom-studio` preset in the web app, vendored into the committed public `ds-neutral` fallback so open-source builds and the packaged desktop app both render the new design with no private-registry dependency. This brings Geist typography, compact IDE control/type density, a scarce green brand (green now signals only live/success/on/confirmed), and neutral ink-based focus and selection chrome (previously green-tinted).

  The rail brand lockup is now the Sapiom wordmark + `agent.studio` (lowercase mono), matching a new terminal masthead (pixel mark + wordmark + working-directory / status facts) that replaces the old status bar.

  The shell reads as three flat blocks — a grey workspace rail, the grey terminal shell, and the raised white graph pane — with no permanent dividers or raised header bands (a header boundary is a lie until content scrolls under it). The affirmative CTA is the theme's ink button, not a green fill; green appears only on genuine state (live, deployed, on, entry/active step, activity).

  Main panel: the session bar, tab lane, and action row merge into ONE header. The active session is a title dropdown (copy path, rename, open in editor, end session); the focused agent's other live sessions sit beside it as side-scrollable switch chips with a trailing `+`. The agent actions are Prod (globe) · Test · Run · Deploy, right-anchored, the primary CTA following state (Deploy for a draft, Run for a deployed agent); Draft/Deployed status shows once, in the graph pane's header, never duplicated in the bar.

  Rail: Search and Templates are labelled destination rows (Search carries a right-aligned ⌘K / Ctrl+K, not a boxed field), and agent rows drop their leading glyph — indentation carries the nesting under the workspace folder. The `⋯` menu files the explorer by Workspace or Deployment and orders it by recent activity or name, with past sessions opening in a sub-card beside the menu rather than a scrolling list inside it. The footer is one continuous block: a plan summary (demo fixture only; live mode shows none) above the account row, no divider.

  Floating menus and dialogs paint an opaque surface (a portaled popover that inherited a translucent inset wash let the rail bleed through it); the canvas board is navigated only by its own zoom/fit/pan controls and never shows native scrollbars; and the canvas resize splitter stays welded to the board's edge at every window width.

  Depth: the raised graph column — its dotted board included — is a lighter white lifted off a slightly darker rail/terminal shell by a soft left-edge shadow, so it reads as the forefront panel instead of a fourth flat grey. The shadow paints the full column height (it must sit above the terminal's opaque, absolutely-positioned scroll viewport, which had been overpainting it from the terminal's top down). In light mode the canvas render's accent and success colour is now the brand green, matching the rest of the app; it had been an off-brand cyan in light only.

  In the packaged desktop app on macOS the window is frameless: it drops the native title bar and insets the OS traffic lights into the rail's 56px top line, which becomes the window's drag handle (every control on it opts back out, so buttons and tabs still click). The rail header splits across two rows — the Sapiom wordmark and the theme/collapse tools beside the lights, `agent.studio` on the line below — while the session bar and graph tabs stay a single top line. This chrome activates only in that host (signalled by a `frame=macos` query param); the `npx` browser app never sets it and is unchanged.

- cc2e4aa: Studio shell polish — left rail, theme, and the session bar:

  - **Even rail spacing.** The workspace panel's top stack (agent.studio → Search → Create new → Templates → Workspaces) now sits on one uniform 8px rhythm instead of three different gaps.
  - **"Create new" CTA.** A standing button under Search opens the Add menu (new session / workspace / templates). When the rail has no agents yet it becomes the filled brand-green primary with a soft ring, so a first-run workspace has an obvious next step.
  - **Theme follows the OS by default.** With no saved choice the Studio mirrors the system light/dark preference and keeps tracking it across launches; a manual toggle still wins and persists.
  - **Session switcher in the title menu.** The current session is a single selector whose ⌄ menu lists every live session (disambiguated by name + last-active time, active one checked), plus New session and the session actions. This replaces the inline chips — sessions that share a base name no longer read as a row of near-identical labels — and the bound-agent line moves into that menu.

- baa6102: Replace the rail's header "+" Add-popover — and the `AddWorkspaceDialog` /
  `NewSessionModal` doors behind it — with one detection-driven **"Add existing
  agents"** dialog, reached from a dedicated rail button (and the new-session
  composer's "Open a folder").

  Point at a folder and detection relabels the single ink action: **Add workspace**
  (the folder is an agent project), **Add all N** (it's a folder of agent
  projects), or a disabled "No agent in this folder" when it holds none. No intent
  step, no doors, and no way to land on two identical folder-picker screens.
  Creating a NEW agent stays with "Create new" (the composer); this dialog only
  registers agents that already exist.

  The folder field's **Browse** button opens the OS-native folder chooser in the
  desktop app (a new sender-guarded `dialog:choose-directory` IPC), falling back to
  the in-app directory listing under `npx` — the listing stays either way, since
  only it shows the "✓ Agent" detection badges.

### Patch Changes

- 3ef1454: Keep direct actions independent of coding-agent readiness, distinguish linked agents from ready cloud builds, and make Canvas/Code run and integration evidence accurately reflect the selected agent.
- 1000510: Describe deploy as a synthesized bundle of current local source, distinguish
  account-free local validation from metered cloud builds and production runs,
  and make execution inspection's cost-agnostic evidence boundary explicit.
- 2485561: Fix Claude Code sessions that exit with code 1 before establishing a session id, and make the cause visible when they do.

  Some users saw a session die within seconds — "Session exited · exit code 1 … it exited before establishing a session id" — with no way to tell why. The session id is only ever set from Claude Code's `SessionStart` hook, so this always means `claude` itself exited before that hook fired. Three independent, environment-specific causes were addressed, each of which is ours to prevent:

  - **Version floor for `claude` (doctor).** The harness injects flags on every launch — notably `--plugin-dir`, which per the Claude Code changelog did not exist before the plugin system shipped in `2.0.12` — but nothing checked the installed version, so an older `claude` (a pre-existing global that shadows the app's install, or a stale one) rejected the unknown flag and exited 1 before the hook. `doctor` now enforces `MIN_CLAUDE_CODE_VERSION` (`2.1.0`, the range the harness's `--plugin-dir` skills usage is verified against): a below-floor `claude` reports NOT ok, so the desktop app installs a current one and the `npx` CLI shows an actionable upgrade remedy instead of every session crash-looping silently. A version we can't parse is left alone, so a future change to `claude --version`'s format can never mass-reject working installs.
  - **Quote the SessionStart hook command path.** The generated hook command interpolated the emitter-script path unquoted (`node <path> <event>`). Claude Code runs a `command` hook through a shell, so a home directory containing a space (`/Users/First Last/…`) word-split the path — `node` got a truncated path, the hook died, and the session id was never established. The path is now double-quoted.
  - **Preserve the agent's error line on abnormal exit.** A live pty's scrollback was discarded the instant it exited, so `claude`'s own error ("unknown option '--plugin-dir'", an auth failure, "Cannot find module …") was lost — which is why this was so hard to diagnose from a report. Sessions that exit with a non-zero code now keep a sanitized tail of their last output (`HarnessSession.exitTail`), shown in the exited-session pane. A clean exit keeps nothing.

  The shared ANSI stripper used for this and for Codex trust-prompt detection moved from the Codex adapter into `core/strip-ansi.ts`.

- 25fc26f: Make local agent runs parse step inputs through their Zod schemas like production, normalize relative check directories, stage and retry gallery clones across branch-propagation delays, and clarify that local validation stubs Sapiom capability traffic without sandboxing arbitrary author-code side effects.
- 9addb66: Keep Agent Studio workspace discovery consistent across scanning, live updates, and the folder picker; preserve Studio state when cloning gallery templates; and clarify bundled starter network requirements.
- Updated dependencies [1000510]
- Updated dependencies [25fc26f]
- Updated dependencies [9addb66]
  - @sapiom/agent-core@0.10.3
  - @sapiom/mcp@0.12.2

## 0.2.7

### Patch Changes

- 267598a: Publish `@sapiom/agent-studio` as the branded Agent Studio launcher while
  keeping `@sapiom/harness` as the supported implementation and compatibility
  command.
- 87636c1: Make bundled starters work from a fresh Agent Studio session by preserving Studio-owned state, writing the project discovery marker, and handing Claude the local scaffold MCP tool directly.
- Updated dependencies [87636c1]
  - @sapiom/agent-core@0.10.2
  - @sapiom/mcp@0.12.1
  - @sapiom/agent@0.9.3

## 0.2.6

### Patch Changes

- 824eb1e: Use Agent terminology across generated Canvas content, server errors, and demo fixtures.
- 368125b: Normalize Agent Studio shell terminology and route dashboard links to the canonical Agents page.
- addb63c: Clarify Agent Studio coding-agent prompts, resume metadata, and authoring action labels.
- 9199e10: Use Agent and Agent run terminology throughout the Canvas and Steps interfaces.
- 94584a2: Guard visible Agent Studio terminology and share the product name across CLI and desktop hosts.
- Updated dependencies [40d1c64]
- Updated dependencies [be2b81b]
  - @sapiom/agent-core@0.10.0
  - @sapiom/mcp@0.12.0

## 0.2.5

### Patch Changes

- Updated dependencies [c8072cd]
  - @sapiom/agent@0.9.0
  - @sapiom/agent-core@0.9.13

## 0.2.4

### Patch Changes

- Updated dependencies [a1e0e4f]
- Updated dependencies [a1e0e4f]
  - @sapiom/agent@0.8.0
  - @sapiom/agent-core@0.9.12

## 0.2.3

### Patch Changes

- a258741: Deploy now links (or creates) the remote agent for a project that has never
  been linked, instead of failing.

  A gallery-template clone lands with `sapiom.json` carrying its fork provenance
  and no `definitionId` — by design, since the definition was always meant to be
  created at deploy. That half was missing, so `POST /api/workflows/:id/deploy`
  answered 409 "workflow is not linked to a Sapiom agent" and the Deploy button
  could not succeed on a fresh template.

  The route now resolves-or-creates the agent first (`link({ create: true })`,
  which matches an existing definition by name/slug before creating one, so
  re-deploying never duplicates it), caches the id in `sapiom.json`, and continues
  into the build. The stream gains a non-terminal `linking` line so the UI can say
  what it is doing; terminal lines are unchanged. The agent is named after its
  declared `defineAgent({ name })` where resolvable, falling back to the cached
  name or the workflow's own name. An unparseable `sapiom.json` still 409s — now
  with a message that says so, because creating a remote agent we could not
  record would orphan it.

  Caching the newly-linked id in `sapiom.json` is best-effort: the file is a
  re-resolvable cache and `link` re-resolves the same agent by name, so a failed
  write (read-only checkout, a permissions error, the config turning invalid
  between the initial check and this write) must not cost the user their build.
  On that path the stream emits a non-terminal `warning` line instead of failing
  — the agent was created on Sapiom but not recorded locally, so the Deployed
  chip will not flip and the next deploy re-links, but nothing is duplicated
  because `link` resolves the same agent again. The SPA renders both the
  `linking` and `warning` lines, and a double-click on Deploy can no longer
  create two remote agents for the same project.

  Because linking matches by name, two gallery clones of the same template —
  which share the same declared `defineAgent({ name })` — resolve to the same
  remote agent, so deploying the second one replaces the first's build; this is
  inherent to link-by-name (unchanged from `sapiom agents link --create`), not
  a new bug, but it's now reachable from a single button click.
  - @sapiom/agent@0.7.1
  - @sapiom/agent-core@0.9.11

## 0.2.2

### Patch Changes

- 781593c: Add a desktop-only "Check for updates" item to the profile menu, alongside Disconnect.

  The Electron app (`@sapiom/harness-desktop`) now ships a minimal preload exposing `window.sapiomDesktop`, and the SPA feature-detects it: the row appears in the desktop app and is **absent** under `npx @sapiom/harness`, where there is no bundle to replace. New `web/src/lib/desktop.ts` owns that detection plus the outcome→copy mapping.

  The bridge contract is mirrored here rather than imported, because the dependency runs the other way (the desktop app depends on this package, never the reverse). `getDesktopBridge()` validates the shape rather than trusting a flag, so a desktop build older than a given SPA build reads as "no bridge" instead of throwing inside a click handler and leaving a dead button.

  The result arrives as a toast, because the menu closes on click and the outcome is the whole point of pressing it. Outcomes are distinguished rather than collapsed into one "checked!" message, because each has a different next step: downloading (wait), already downloaded (restart, via the native prompt described below), up to date (named with version _and_ channel, since a beta and a stable install are up to date at different versions), updates disabled, or the check failed.

  Applying an update is confirmed by a **native dialog** raised by the desktop app, and the bridge exposes no way to trigger it. That is deliberate: a restart ends every running agent session, and the page asking for it shares an origin with the agent-authored files the harness serves at `/canvas/:sessionId/*`. Asking for a check when something is already downloaded re-raises that prompt.

- c034c4d: Studio: "New session…" moves from the Sessions menu to the Add menu.

  Starting a session is the most common thing the rail's `+` is pressed for, and it is unambiguously an _add_ — but it lived in the History popover, one button over. That was an accident of order: the Sessions menu existed first, so the action was put where there was already a list to put it in. The result was the thing you do daily sitting behind the button for reviewing work that has already finished, and "start something new" split across two popovers that look identical and mean different things.

  It now leads the Add menu, above the three workspace doors, and is gone from the Sessions menu — one action, one home. The Sessions popover is left doing exactly one job: reopening a past session.

  The row is the same `DoorRow` component as the doors beside it rather than a hand-matched copy of the markup, so it cannot drift out of alignment with them; `DoorList` takes a `leading` slot for rows that belong to the menu but have no door in the dialog.

## 0.2.1

### Patch Changes

- c403426: Studio: one vocabulary for adding a workspace, and the intent question asked once.

  Two surfaces offered the same action under different names and different shapes. The rail's `+` opened a centred modal titled "Add to Sapiom" whose first door was "I have a project"; Overview's primary row said "Open a folder". Same destination, two words for it, and only one of them matched the button the user had just pressed.

  - **The `+` is a menu, not a modal.** It now opens an anchored popover on the same `AnchoredPopover` primitive and the same `connect-card` recipe as the History menu one button to its left, which is what it always should have been: a centred, scrimmed dialog to pick one of three words was the heaviest possible container for the lightest possible choice, and it read as a different surface from its own neighbour. The rows are not a reworded copy — `DoorList` moved out of the dialog and is rendered by both, so the three labels cannot drift again.
  - **It opens beside the rail rather than over it**, via a new `right-start` / `right-end` placement on `AnchoredPopover`. Every existing placement drops the panel above or below its trigger, which is wrong for a trigger pinned to a left-hand edge: the panel grows back across the workspace tree it is about to add to, covering the list you are checking against. Side placements align the panel's top edge to the trigger's and grow rightward; the existing measured clamp pass still shifts an overhanging panel back inside the viewport, so the width is deliberately not pre-clamped to the space remaining (which would squeeze the card narrow on a small window instead).
  - **Overview's "Open folder" lands on the folder question.** It opened the door _list_, so clicking a button called "Open folder" was answered with three intents, one of which was opening a folder. `AddWorkspaceDialog` takes an optional `initialDoor` and both callers now pass the door they already named. Entered that way there is no list behind the door, so the back button is suppressed rather than left pointing at a state the dialog was never in.
  - **Door 1 is "Open a folder" everywhere**, adopting the word Overview already used.

  Recent workspaces, the templates hand-off, and every door's own flow are unchanged.

## 0.2.0

### Minor Changes

- 3f96e37: Canvas board redesign + deterministic step/workflow metadata.

  - **Board redesign** matching the new design: in-drawer step navigation removed (the chart is beside it), chat split into a standalone toggleable panel independent of the info panel, the board subheader dropped with the deployed pill and expand relocated to the tab bar, and the manual "Render diagram" button replaced by auto-render on bind/session-start.
  - **Deterministic metadata:** the renderer surfaces per-step `description` / `inputSchema` / `capabilities` / `timeoutMs` and a workflow Overview payload, all read from the manifest (no LLM in the render path). When a step doesn't call a capability or declare a description, the field is simply absent — the shape summary still renders.
  - **Capability auto-detect** from `sapiom.*` call sites in the workflow source, attributed to the `defineStep` block the call sits in (calls in shared helpers are left unattributed rather than mis-billed to the nearest step).

  Reads the new optional `description` / `capabilities` fields from `@sapiom/agent`; workflows on an older SDK render with those fields blank.

- 7b98507: Studio: show a template's complexity band where the per-run cost estimate used to be.

  The Templates dialog rendered `estCostPerRunUsd`, relayed from the same core endpoint the dashboard's Template library reads. Core stopped serving that field: it could only price capabilities metered per `call`, so the estimate was `null` for 21 of 26 templates, and a number that honest for 5 of them was not worth a slot on every card. Core now derives a **complexity band** — `Minimal` through `Advanced`, 1–5 — from each template's declared shape.

  Without this change nothing errored, which is why it would have gone unnoticed: `template-catalog.ts`'s defensive narrowing turned the missing field into `null` and the formatter turned that into an em dash, so **every** template read `—` where a cost used to be.

  `TemplateSummary.estCostPerRunUsd` is replaced by `TemplateSummary.complexity`, and the new `TemplateComplexity` / `TemplateComplexityBasis` types are exported alongside it. **Breaking for embedders** (hence `minor`): `src/index.ts` re-exports `./shared/types.js`, so code reading `estCostPerRunUsd` off a summary stops compiling.

  The band is read, never computed. Whether core derives it (today) or serves an authored one later, this surface is unchanged.

  `complexity` is typed nullable here even though core types it required, and that is deliberate rather than belt-and-braces. This is a published npm package: an old copy can point at any backend, and a fresh copy can point at a backend that predates the field — a local stack, a self-hosted one, production before a promotion. An unguarded dereference in the row renderer would take out the whole dialog, so a band that isn't there degrades that one row to an em dash instead. Note the glyph's meaning has changed: it used to mean "no cost estimate exists", the majority case; it now means "this response predates the band", and nobody should ever see it against a current backend.

  On the card the band rides beside the step count, with the counts behind it in the tooltip. In the detail pane, the section retitles to "Capabilities and complexity" and the old three-state cost note collapses to a single line — the band plus what produced it ("2 model steps, 1 chained, 5 steps, 1 capability"), so it reads as an estimate of shape rather than an opaque verdict. Text only, no meter or dots, matching the dashboard's gallery.

- b199f93: Studio: read the template gallery live, and stop pitching the product at returning users.

  **Templates come from the real catalog.** `web/src/lib/templates.ts` shipped a hardcoded copy of two registry entries (pinned at harness 0.1.4 / `f0e3406`) because, as its header said, no listing API exposed the gallery to any client. One exists now, so the Studio showed 2 templates while the dashboard's Template library showed 26. New `GET /api/templates` and `GET /api/templates/:id` relay core's `GET /v1/workflows/templates{,/:id}` — the same endpoint the dashboard renders, so the two surfaces can no longer drift. The dialog gains category grouping, search, and a per-template complexity band. Two contract details, both verified against a running backend: the core surface authenticates with `Authorization: Bearer` (the `x-sapiom-api-key` header the _agents_ surface takes returns 401 here), and the path carries the `/v1` prefix. The API key stays server-side, as with the runs router; a 401/403 triggers one credential refresh and retry. Signed out or with core unreachable, the dialog falls back to the bundled offline starters **and says which** — silence is what let a two-entry list read as the whole gallery.

  The detail pane now projects the graph core actually serves — the engine's `DefinitionStepDto`/`DefinitionTransitionDto` shapes, where a step carries `stepName` and a singular `capabilityId`, edges reference steps by namespaced `id`, and a step's role is decided by its transition kinds rather than array order. Node kinds come from `classifyStepKind`, extracted from `canvas-graph.ts`'s `classifyNode` and now shared: the preview claims parity with the canvas, so it must not own a second copy of that precedence. All four kinds (`continue`/`pause`/`terminate`/`fail`) survive the projection — a fail-only sink renders amber "needs attention" rather than a green success exit, a `continue`-plus-`terminate` gate stays a mid-flow step, and a pause step shows its signal.

  **Overview is a working surface, not a pitch.** `showWelcome` was `overviewSelected || (firstRun && !hasLiveSession)`, so the first-run hero rendered whenever the Overview tab was selected — including for someone with a rail full of workspaces. The hero is now genuine-first-run only; returning users get their recent workspaces, with the Docs / Templates / New workspace action band shared by both states.

  **Workspace terminology.** A workspace is a folder, matching the rail and the editor convention users arrive with: the rail header reads "Workspaces", and "New project" / "Add project" / "Project directory" become their workspace equivalents. "Agent project" is left alone deliberately — that is the SDK's own term for a `sapiom.json` directory, and `sapiom agents init` and `AGENTS.md` both use it.

  **The Sample project action is gone**, along with `POST /api/sample-project` and the exported `SampleProjectSeedResponse` type (nothing else in the repo referenced either). `core/example-seed.ts` remains — `scripts/seed-example.mjs` still uses it for demo prep.

  **Breaking for embedders** (hence `minor`, not `patch`): `src/index.ts` re-exports `./shared/types.js`, so `SampleProjectSeedResponse` was part of the published surface, and `HarnessServerOptions` loses its `sampleProjectRoot` field. Code typed against either stops compiling. `TemplateStepView` also carries `kind`/`sublabel` rather than a `terminal` boolean — see above for why that collapse was wrong. No in-repo consumer is affected.

### Patch Changes

- c32f818: Session history now outlives the event log it is rebuilt from (SAP-2060).

  H2 made past sessions readable by folding them out of `events.ndjson`. That file is an analytics sink with an analytics sink's retention — 50 MB / 30 days, truncated oldest-first — so a session a user could read today would quietly stop existing next month, with no way to tell "never recorded" from "swept".

  - New `src/core/record-archive.ts`: at session end the folded `SessionRecord` is compacted and written to `~/.sapiom/harness/records/<harnessSessionId>.json`. Tool inputs and results are clipped hard (they are most of the bytes and the least useful part of a months-old record); prompts and assistant text — the conversation — are kept whole. Over ~64 KB it drops whole turns oldest-first, never below one. Both losses are declared as new `SessionRecord.limitations` codes (`compacted-archive`, `dropped-early-turns`) and the transcript view spells them out, alongside a note naming the record as an archived copy (`SessionRecord.archivedAt`).
  - Bounded, not merely durable: the store enforces a 16 MB total and a 365-day age cap, oldest-first, swept after every write and once at boot. `turnCount` deliberately keeps the conversation's count even when turns were dropped, so a history row's count doesn't change when its events are swept.
  - Written on the normal end of a session (the `SessionEnd` hook's event, via a new `onEventPersisted` ingest seam — fired from `onNormalizedEvent` it would race the append and store a record with no `endedAt`) and on an abnormal one (the session's transition to `exited`, which is all a killed pty gives us). A boot pass archives conversations the log still holds but the archive doesn't, which is what keeps history that predates this feature — and any session lost to a force-kill — from disappearing at its 30-day mark.
  - Reads prefer whichever source still holds the WHOLE conversation. The ticket asked for "prefer the archive, fall back to events"; taken literally that serves a compacted excerpt for a session that ended a minute ago, and freezes a resumed conversation's record at its first exit. Since retention truncates oldest-first, an intact first event means the log lost nothing, so: the log when it still holds the beginning or has events newer than the archive, the archive otherwise, null when neither has anything (still an honest 404).
  - Records live in their own root, NOT under `<generated>/<sessionId>/` as the ticket suggested: that directory is deleted the moment a session's pty exits and swept 7 days after going stale, both shorter than the 30 days of events the archive exists to outlive.

- 460bfc1: Expose the embedding surface so a second host (the Electron desktop app) can reuse the harness instead of forking it: re-export `startServer`/`HarnessServer`/`HarnessServerOptions` plus the setup helpers (`runDoctor`, `pickDefaultHarness`, `ensureAuthenticated`, `getOrCreateMachineId`, `ensureSpawnHelperExecutable`, settings, install-command constants) from the package entry. `saveSettings` is part of that surface: a host that prompts for telemetry consent natively (instead of through the TTY-shaped `ensureConsent`) must persist the answer itself, or the settings file — which the UI's analytics indicator and the next launch both read — never learns about it. No CLI behavior change.

  Also run the Canvas step-graph check subprocess correctly when embedded in Electron: it spawns `process.execPath` (the Electron binary when embedded), so it now passes `ELECTRON_RUN_AS_NODE=1` — guarded by `process.versions.electron`, a no-op under the CLI's real Node. And `packageRoot()` (used as the subprocess `cwd`) now translates an `app.asar` path to its `app.asar.unpacked` twin, since a `cwd` inside the asar archive fails with `spawn ENOTDIR` (the host must `asarUnpack` the harness + its deps).

- c32f818: Portable continue: a session the agent can no longer reattach to is now continuable, by seeding a fresh session with our own reconstruction of it (SAP-2059).

  H1 stopped offering Resume on rows that would fail; that left them with nowhere to go — a disabled button and "start a new session instead", even when our event log held the whole conversation. Resume-as-reattach can only ever work for the vendor that wrote the transcript, on the machine that wrote it. This adds the other half: `POST /api/sessions` takes `rehydrateFrom`, and the new session launches with a bounded markdown briefing about the old one.

  - New `src/core/resume-brief.ts`: `buildResumeBrief(record, opts)` renders a `SessionRecord` as ~6k tokens of markdown — what the session was (title, cwd, branch, bound workflow + `definitionId`), the rolling summary when present, the last N turns with tool calls collapsed to name + target, and files written / commands run derived from `tool.call` inputs. Over budget it drops turns oldest-first, then the (hard-capped) digests, and clamps the summary only as a last resort.
  - It leads with an honesty header and spells out each of the record's `limitations` in prose. A brief that reads like restored memory is worse than no brief: the agent would assert file contents and command results it never saw.
  - Delivery is per-adapter, declared not inferred (`HarnessAdapter.systemPromptDelivery`). Both shipped adapters use `launch-flag` — the brief is appended to the generated system-prompt file, which claude-code reads via `--append-system-prompt` and codex inlines as `developer_instructions`, so one code path serves both with no adapter change. A harness with no prompt flag declares `post-ready-injection` and gets the brief through the ordinary input path once the session reports `ready`, never into a TUI sitting on a trust prompt.
  - New `src/core/rolling-summary.ts`: opt-in via `HarnessSettings.rollingSummary` (off by default; toggle in Settings). Every 10 completed turns and once at session end, a bounded headless run (`launchTask`, cheap model, `--max-turns 1`) folds the record into `<generated>/<sessionId>/summary.md`. Fully detached from the ingest path — a turn is never slower or riskier for it. Codex has no `launchTask`, so its briefs degrade to last-N-turns, as does everyone's with the setting off.
  - `HarnessSession.rehydratedFrom` records what actually happened, not what was asked for: a `rehydrateFrom` id our log holds nothing for still creates the session, with the field null and the UI saying the continue carried no context.
  - UI: `resumeFromHistory` branches on the server-verified `resumeMode` instead of guessing, and the dead-session pane offers "Continue here" (with what will and won't carry over) wherever it has a record to seed from, instead of a disabled Resume.

- b7f5b02: Verify resumability before offering Resume, so no past-session row is a button that's guaranteed to fail (SAP-2057).

  A row's Resume badge was `agentSessionId != null` — "our SessionStart hook fired once", not "the agent still has this conversation". Since neither Claude Code nor Codex writes any transcript for a session that never received a prompt, one in three registry rows on a real machine (16 of 49 measured) offered Resume and answered with `No conversation found with session ID: …`, exit 1, and a dead pane offering Resume again. Transcript-only rows had the inverse bug: hardcoded un-resumable even when the transcript was right there, so opening one silently started a fresh session and dropped the conversation.

  - `HarnessAdapter` gains `canResume(agentSessionId, cwd)` (never throws): one `stat` on the encoded transcript path for claude-code, a `session_meta` id+cwd match for codex.
  - Both adapters now resolve symlinked cwds. Claude Code encodes the cwd's **realpath**, so a session in `/tmp/foo` (macOS: `/tmp` → `/private/tmp`) stores its transcript under a different encoding than the registry's cwd string — history discovery silently missed those rows before, and a resumability probe would have gone further and refused a resume that works.
  - `SessionSummary` gains `resumeMode: "agent-resume" | "rehydrate"`, resolved server-side in `GET /api/sessions/history` for both row sources. Adapters now return `PastSessionRecord`, so they can't decide it themselves.
  - `SessionManager.resume()` pre-flights `canResume()` and throws `SessionNotResumeableError` (409, with a reason naming the agent) instead of spawning a doomed pty.
  - New `POST /api/sessions/adopt` wires up `registerHistorical()`: a transcript-only row whose conversation the agent really holds is adopted into the registry and genuinely resumed. The server re-verifies resumability itself, and the route is idempotent.
  - Truthful durations: a resume that never reaches a live pty no longer stamps `lastActiveAt`, so an idle session stops reporting "Ran for 6h 25m" after a failed Resume, and `formatDuration` returns null on a zero span instead of inventing "under a minute".
  - UI: rows render the verified `resumeMode` (`resumable` / `archived`, `checking…` until known); the dead pane and past-session pane disable Resume with the real reason instead of a generic one.

- 460bfc1: Install the seeded sample project's dependencies on first creation, so the Canvas step-graph renders on first view instead of failing with "Could not resolve @sapiom/agent / zod". `seedExampleProject` now runs a best-effort `npm install` right after scaffolding (before the initial commit, keeping the gitignored `node_modules` out of history); it's non-fatal (missing/offline npm falls back to the existing "ask your agent to fix it" Canvas prompt) and skippable via the new `installDependencies` option (default true; tests pass false to stay offline). Adds `dependenciesInstalled` to `SeedExampleProjectResult`.
- 2d25205: Fix starting a session on Windows. An agent installed by npm is `claude.cmd`, and node-pty spawns via `CreateProcess`, which performs no `PATHEXT` resolution and cannot execute a `.cmd` at all — so every session failed with `Cannot create process, error code: 2` while `doctor` reported the agent present (detection shells `where`, which _does_ resolve `PATHEXT`). Background tasks and macros failed the same way through `child_process.spawn`.

  Both paths now resolve the shim to what it really runs — Claude Code ships a native `bin\claude.exe`, other packages a `cli.js` run under node — and spawn that directly. Deliberately **not** via `cmd.exe`: node-pty escapes `"` as `\"` for `CreateProcess`, but cmd only counts raw quotes, so one embedded quote desynchronises its parser and any following `&`/`|` becomes a command separator (CVE-2024-27980's class, reachable on every session since the codex adapter passes `JSON.stringify(prompt)` as an argument). Resolving the target keeps arguments in exactly one quoting layer, with no shell involved.

  Also exports `resolveSpawnTarget` and `createClaudeCodeAdapter` for hosts that spawn a pty themselves or need to point the adapter at a different binary. No change on macOS or Linux.

- Updated dependencies [3f96e37]
  - @sapiom/agent@0.7.0
  - @sapiom/agent-core@0.9.10

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
