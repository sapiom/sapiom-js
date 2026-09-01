# @sapiom/harness-desktop

## 0.4.2

### Patch Changes

- Updated dependencies [917c930]
- Updated dependencies [bf380c3]
- Updated dependencies [1107764]
- Updated dependencies [a7d4185]
- Updated dependencies [89430fa]
  - @sapiom/harness@0.12.0

## 0.4.1

### Patch Changes

- Updated dependencies [fc231c9]
- Updated dependencies [1d2ae02]
- Updated dependencies [e72d172]
- Updated dependencies [5745707]
- Updated dependencies [e5af82b]
  - @sapiom/harness@0.11.0

## 0.4.0

### Minor Changes

- 8a7f3af: Ship the current Agent Studio experience on the stable desktop channel again, by
  removing the temporary `@sapiom/harness@0.8.9` pin. The app now bundles the
  workspace Harness, so the Project rail rebuild and the dependency graph reach
  stable users for the first time.

  **Correcting the record for 0.3.8.** That release's changelog claims
  `@sapiom/harness@0.10.0`, and it did not ship it. The entry was generated from the
  workspace dependency graph, which could not see the `pnpm` override pinning the
  desktop app to `0.8.9` — so `0.3.8` carried the same Agent Studio SPA as `0.3.7`
  despite what its notes said. Nothing was wrong with the build; the pin was
  deliberate (see `0.3.7`) and only its removal was missed. This release is the one
  that actually delivers the newer Studio.

  **Rows you had may disappear on upgrade, and no files are touched.** The rail now
  derives its project list from one rule: a project is a directory you chose that
  holds agents. Remembered folders that were an agent's own directory, and folders
  known only because a session once ran there, stop being drawn. On one real install
  this cut 42 project rows to 3 with all 89 agents still visible. Nothing is
  deleted — any folder is one **Add a project** away from coming back.

### Patch Changes

- 3709e65: Make the pre-release update channel reachable. Desktop releases are now tagged
  `vX.Y.Z` instead of `harness-desktop-vX.Y.Z`, because the old prefix is not valid
  semver and the updater silently skipped every release when resolving a
  pre-release channel — so an install following betas was told "no published
  versions" no matter what had been published. The stable channel was never
  affected and keeps updating across the change.

  Also adds a persisted `preRelease` preference, so an install can follow betas
  without setting `SAPIOM_UPDATE_CHANNEL` — unusable as a real control on macOS,
  where a Finder or Dock launch inherits no shell environment. The control that
  writes it is a follow-up; the preference and the plumbing land here.

## 0.3.8

### Patch Changes

- Updated dependencies [f26d2cd]
  - @sapiom/harness@0.10.0

## 0.3.7

### Patch Changes

- 4eeaf92: Restore the stable desktop channel to the Agent Studio experience from `0.3.5`
  by packaging `@sapiom/harness@0.8.9`. The Project dependency graph remains
  available only through the separately versioned beta build while it is
  validated.

## 0.3.6

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

## 0.3.5

### Patch Changes

- Add browser-style session tabs and make the chat-header plus start a fresh,
  isolated same-folder Claude Code or Codex conversation while preserving the
  source session's provider and agent binding.

## 0.3.4

### Patch Changes

- Ship Codex 0.143 initial-prompt compatibility and post-trust readiness hardening in Sapiom Studio.

## 0.3.3

### Patch Changes

- Ship the Codex initial-prompt readiness fix in the Sapiom Studio desktop app.

## 0.3.2

### Patch Changes

- 13e5867: Start new and resumed interactive Claude Code sessions in Auto mode when the
  account supports it. Bypass permissions is available as an explicit Shift+Tab
  choice for accounts without Auto mode; it is never activated silently.
  Headless tasks keep their existing permission mode.
- Updated dependencies [7d4f13a]
- Updated dependencies [13e5867]
  - @sapiom/harness@0.8.1

## 0.3.1

### Patch Changes

- b1d791b: Add an artifact-first Studio run workspace for local and cloud agents. Studio now
  collects schema-driven input, streams chronological attempt evidence, renders
  bounded outputs with Rendered and Raw views, and provides an isolated Focus mode
  for inspecting input, output, state, directives, logs, and recorded capability
  calls.

  Local agent execution now emits start and settled trace events with timing,
  directive, shared-state, log, and capability-call evidence. Desktop development
  launches rebuild Harness first so Electron always opens the current Studio UI.

- 8ef5374: Restore drag-and-drop of images (and any file) into the Studio terminal. Removing the image composer (#562) left drops with no handler at all — xterm.js has no native drop behavior, so in the desktop app a dropped image was handed to the OS viewer instead of the agent. A drop on the terminal now behaves like a native emulator: the desktop preload resolves the dropped File to its real path (`webUtils.getPathForFile`) and the SPA pastes the quoted path into the pty, which Claude/Codex pick up natively (`[Image #1]`). Stray drops elsewhere in the SPA no longer navigate the page away.
- f5a67c2: Clicking a link in the terminal opens the actual URL instead of a macOS "no application set to open the URL about:blank" dialog

  The xterm web-links addon's default activation opens a blank window first and
  assigns `location.href` afterwards. The desktop app's window-open handler
  intercepts that first call, sees only `about:blank`, and hands it to the OS —
  which has no handler for that scheme, so the link dies in a system dialog. The
  terminal now passes the clicked URL directly to `window.open`, and the desktop
  host additionally refuses to hand anything but `http(s):`/`mailto:` URLs to
  `shell.openExternal`.

- Updated dependencies [bb0df7d]
- Updated dependencies [b1d791b]
- Updated dependencies [8ef5374]
- Updated dependencies [f5a67c2]
  - @sapiom/harness@0.8.0

## 0.3.0

### Minor Changes

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

- Updated dependencies [3cbe957]
- Updated dependencies [4edcbf5]
- Updated dependencies [f21f6a6]
  - @sapiom/harness@0.7.0

## 0.2.8

### Patch Changes

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

- c0135a1: Update window: use the actual desktop app icon as the brand mark

  The redesigned update window showed the SPA's `sapiom-mark.svg` (a different, green mark) in a themed chip. It now shows the app's own `icon.png` — the black rounded-square "S" badge — copied beside the renderer and referenced same-origin, so the window's logo is identical to the dock/installer icon and can't drift from it.

- 05773de: Replace the native "update ready" dialog with a designed, on-brand update window

  electron-updater's "Sapiom X is ready to install" prompt was a native OS dialog — unstyleable and generic. It's now a custom frameless window, built the same way as the setup window (bundled, CSP-locked HTML themed through the design-system seam), so it reads as Sapiom instead of a system alert.

  - **Design:** the Sapiom "S" mark (in a neutral ink chip) + wordmark + `agent.studio <version>` lockup, a concise "`<version>` is ready to install. Restart ends running agent sessions." line, and an ink primary **Restart now** with secondary **Later** and **Skip this version**. Light and dark.
  - **Skip this version** is persisted (a desktop-local `update-prefs.json`): that version is never re-offered, a newer one still is, and "Check for updates" clears skips.
  - **Automatically download and install updates** toggle: when on (the default), a downloaded update installs on the next ordinary quit (`autoInstallOnAppQuit`) — never a surprise mid-session restart; off keeps the prompt-only behaviour. This reverses the former hardcoded no-auto-install default, now that the user controls it.
  - **Theme sync:** the window follows the app's current light/dark theme. Its `file://` origin can't read the SPA's (`http://localhost`) theme storage, so the main process reads the SPA window's live `data-theme` and hands it in — no drift to the OS default when the user has picked a non-OS theme.
  - **Safety preserved:** "Later" is the keyboard default (Esc/Return defer); restarting needs an explicit click. The new IPC channels are scoped to the update window's own renderer (sender-gated, registered only while it is open), so page/agent content still cannot trigger a restart.

- 5e58677: Fix Windows auto-update: the NSIS installer now uses a space-free artifact name
  (`Sapiom-Setup-<version>.exe`), so the filename electron-builder records in
  `latest.yml` matches the asset GitHub actually stores. Previously the default
  spaced name (`Sapiom Setup <version>.exe`) was sanitised to hyphens in the
  manifest but to dots in the uploaded asset, so every Windows client 404'd on
  update. The release workflow now also fails if any published manifest references
  an asset that isn't attached, so this class of mismatch can't ship silently again.
- Updated dependencies [651c407]
- Updated dependencies [7bef8b2]
- Updated dependencies [95241fb]
- Updated dependencies [928a639]
- Updated dependencies [5c0c646]
- Updated dependencies [21bb3f0]
  - @sapiom/harness@0.6.0

## 0.2.7

### Patch Changes

- ac7d2df: Rebrand the desktop onboarding window to the new Sapiom identity

  The setup window now leads with the real Sapiom wordmark + `agent.studio` lockup — an inlined `currentColor` SVG, identical to the SPA's `BrandLogotype` — instead of a plain-text label, themed to ink in both light and dark.

  - **macOS chrome:** the window is borderless (`titleBarStyle: "hiddenInset"`) — no grey title bar, traffic lights kept — and the window itself is the card (paints `--s1` edge to edge; the OS rounds it and adds a shadow). Windows/Linux keep their native frame.
  - **CTA:** Continue / Retry use the design system's neutral ink button (`--btn`/`--btn-ink`), never green; the consent checkbox is ink too. Green stays reserved for semantic state.
  - **Copy:** the boot status reads "Starting…" (the wordmark already says Sapiom), the consent screen drops the redundant question line (the checkbox is the ask), any detail line that merely echoed the status is suppressed, and the error message is centered.
  - The window pre-paints in `--s1` so it no longer flashes before its stylesheet loads.

  Contract tests pin the inlined logo, the pre-paint background, and the design-system wiring against silent drift.

- 6bc0495: Studio: animated rail, back/forward hardening, and dark-mode + control polish

  - **Rail collapse/expand now animates** — the left workspace panel slides open/closed (0.22s ease) instead of snapping. It stays resizable and still reflows to its minimum width under space pressure, and it's inert once collapsed.
  - **Back/forward navigation** gained unit coverage for the visit-stack reducers, and a fix for a case where replaying a Back/Forward visit whose derived place had since changed kind (e.g. a session whose live CLI has exited) silently truncated the forward stack.
  - **Frameless macOS header**: the "sapiom agent.studio" lockup now sits a uniform gap below the window tools instead of a wide chasm under the traffic lights.
  - **Icon-only action controls** (Test / Deploy / globe when the bar is narrow) are square rather than wide rectangles.
  - **Command palette**: the selected row is legible in dark mode again — it was drawn with the on-green ink colour over a neutral highlight, which made it all but invisible.

- 6bc0495: Studio UI cleanup: denser rail navigation, a single 1:1 contract for every icon-only control, rail collapse grouped with the window controls with back/forward on the header's right anchor, the account menu's Overview as a modal that names the running build, canvas chrome (title, badges, stats, node-kind key) moved off the board into the overview panel, and a selected-card highlight on the graph so the bottom inspector always says which card it is describing.
- Updated dependencies [7612e30]
  - @sapiom/harness@0.5.1

## 0.2.6

### Patch Changes

- Updated dependencies [19b8bbb]
- Updated dependencies [03d23c8]
- Updated dependencies [5aa3e01]
  - @sapiom/harness@0.5.0

## 0.2.5

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

- Updated dependencies [e3b2e7a]
- Updated dependencies [a34bd32]
  - @sapiom/harness@0.4.1

## 0.2.4

### Patch Changes

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
- Updated dependencies [38a7327]
- Updated dependencies [0b0784c]
- Updated dependencies [0b0784c]
- Updated dependencies [feaaeaa]
- Updated dependencies [2c4e8d9]
- Updated dependencies [58f8008]
- Updated dependencies [1b3c103]
  - @sapiom/harness@0.4.0

## 0.2.3

### Patch Changes

- Brand-coherent terminal colors: Claude Code's accent colors now match the
  Studio palette instead of Claude's defaults. Each session is pinned to Claude
  Code's `dark-ansi` / `light-ansi` theme (matched to the app theme), routing
  its colors through the terminal's 16-color ramp, which is retuned to a calmer
  blue, the Studio green for success/live state, and harmonized red / yellow /
  cyan / magenta. The recessed terminal background is unchanged. (Ships the
  `@sapiom/harness` change ahead of the batched changeset release.)

## 0.2.2

### Patch Changes

- Open in Studio (SAP-2424): register a `sapiom://` URL scheme so the dashboard's
  "Open in Studio" action opens the desktop app and routes to the agent —
  focusing it when it's already cloned locally, or offering to clone it (by
  definition id) and then focusing it. Handles macOS `open-url` and
  Windows/Linux argv for both warm and cold launches, with a download-page
  fallback when the app isn't installed.

## 0.2.1

### Patch Changes

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

## 0.1.2

### Patch Changes

- Updated dependencies [3f96e37]
- Updated dependencies [c32f818]
- Updated dependencies [460bfc1]
- Updated dependencies [c32f818]
- Updated dependencies [b7f5b02]
- Updated dependencies [460bfc1]
- Updated dependencies [7b98507]
- Updated dependencies [b199f93]
- Updated dependencies [2d25205]
  - @sapiom/harness@0.2.0
