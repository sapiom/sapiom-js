---
"@sapiom/harness": patch
---

fix(harness): separate inspecting a workflow from binding it, and keep the rail highlight in sync with the canvas

Clicking a workflow in the workspace rail used to immediately rebind it to the
active session, so just *looking* at another workflow clobbered what the session
was working on. Selecting is now pure inspection (it highlights the row and docks
the action strip); a session's binding changes only via an explicit "Work on
this" control on the strip (or by running a macro against the workflow, which is
already an explicit action).

Switching session tabs now always snaps the rail/strip highlight to that
session's own binding — including clearing it when the session has no binding, so
the rail no longer stays lit on the previous session's workflow while the canvas
shows nothing.
