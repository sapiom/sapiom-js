# @sapiom/harness-desktop

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
