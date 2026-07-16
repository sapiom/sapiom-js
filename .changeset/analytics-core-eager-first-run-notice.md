---
"@sapiom/analytics-core": minor
---

New `eagerFirstRunNotice` config option: print (and persist the shown-marker for) the once-per-machine first-run notice at instance creation instead of on the first `track()`. For hosts that hand the terminal to a child process right after startup (e.g. the harness CLI passthrough spawning a full-screen agent TUI), the notice must reach stderr while the host still owns it — not later, in the middle of the child's UI. Consent still gates it: a disabled instance never prints. Default behavior (notice on first `track()`) is unchanged.
