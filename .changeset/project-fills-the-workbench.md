---
"@sapiom/harness": minor
---

Studio: selecting a project fills the workbench instead of replacing it — your
conversation stays, and the project's map draws beside it.

Picking a project used to collapse the shell to one column and take both panes
away: the map arrived as a full-width destination and the chat you were mid-
sentence in vanished. Browsing a template gallery is a detour; looking at your
project's shape while you talk to it is not. Now the conversation keeps the
centre and the map fills the right pane.

- **A project is somewhere you work.** Selecting one makes it the conversation's
  subject: the tab strip shows that project's live sessions — including the ones
  bound to its agents, which were invisible before — and a project with nothing
  running is given a session at its root.
- **Selecting an agent inside the project changes only the right pane.** The
  session already reaches every agent in its project, so the chat does not move.
  Crossing to a different project still hands the conversation over.
- **The map and an agent's board are one canvas at two heights.** Clicking an
  agent on the map drills into its board, and a control at the head of the tab
  row cuts back up to the map — it used to be a one-way door. The rail selection
  and the canvas always agree, driven from either side.
- **Tabs are now Canvas and Steps.** Steps is disabled at map altitude with the
  reason, since a whole project has no step list. The **Code** tab is gone; its
  "Trigger from your code" snippets moved to the Steps surface, under the deploy
  banner — the moment that question is actually asked.
- The active session's tab is kept in view when the strip's own width changes,
  so a newly created tab can no longer be stranded off-screen.

An agent that is linked to Sapiom but has no ready cloud build yet gets the
snippets section with the reason there is nothing to copy, rather than nothing
at all. Snippet clicks are now attributed to the canvas surface rather than a
Code-tab surface that no longer exists; `object=snippet` is unchanged.

Membership stays derived from where an agent lives on disk. Nothing is stamped
onto a session record, so moving an agent or removing a project cannot leave a
second, staler answer behind.
