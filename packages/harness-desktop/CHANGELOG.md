# @sapiom/harness-desktop

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
