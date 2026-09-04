---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Studio's dialogs now behave the same as each other. Add existing agents, Add a project, Create an agent, Use a template, Remove project, End session and Clone agent share one shell, so Tab stays inside the open dialog instead of walking into the rail behind it, the page behind the dialog stops taking clicks and screen-reader attention while it is up, and focus opens on the dialog's subject rather than its close button. Closing a dialog hands focus back to the control that opened it — through the close button, the backdrop and Cancel, not only Escape — wherever that control is still on screen to receive it. Enter submits from a single-line field and Cmd/Ctrl+Enter from a text area, one rule everywhere, and the three confirmation dialogs take neither, so a removal is never one stray Return away. Dialog titles are one size instead of the two they had drifted into.
