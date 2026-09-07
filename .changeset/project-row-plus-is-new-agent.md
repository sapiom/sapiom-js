---
"@sapiom/harness": minor
---

A project row's `+` is **New agent**, scoped to that project, and a plain session is no longer a row verb.

Creation had been delegated to the pinned Agent Map: `mapOwnsCreation` is true for every project on a current server, and it gated both the row's create action and the empty project's create row, so neither rendered. The Agent Map has no create control of its own — its only route to generating agents was the planner session, which SAP-3143 removes. A project that already held agents was left with no scoped way to grow another; the rail's top CTA opens the composer with no project context and cannot create into an existing project.

The `+` now opens the new-agent screen for the row's own project (`project-create-agent-{label}`), and a bare project keeps its distinct scaffold verb (`workspace-scaffold-{label}`). `project-start-session-{label}` is removed: a plain session starts from the tab strip, or from the **Start a session** on the project's own pane. The empty project still gets no create row of its own — its Agent Map row is the CTA.

Follows design-eng `IA.md` 219 and D34(a); D34(e) and D35 item 6 for sessions belonging to the tab strip.
