---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Studio's dialogs now behave the same as each other. Add existing agents, Add a project, Create an agent, Use a template, Remove project, End session and Clone agent share one shell, so Tab stays inside the open dialog instead of walking into the rail behind it, the page behind the dialog stops taking clicks and screen-reader attention while it is up, focus opens on the dialog's subject rather than its close button, and focus returns to the control that opened it however the dialog was closed — the close button, the backdrop and Cancel, not only Escape. Enter submits from a single-line field and Cmd/Ctrl+Enter from a text area, one rule everywhere, and the two destructive confirms deliberately take neither. Dialog titles are one size instead of the two they had drifted into.
