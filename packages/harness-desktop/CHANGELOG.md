# @sapiom/harness-desktop

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
