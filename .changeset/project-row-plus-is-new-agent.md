---
"@sapiom/harness": patch
---

A project row's `+` is **New agent**, scoped to that project, and a plain session is no longer a row verb.

The row's hover `+` (`project-create-agent-{label}`, accessible name "New agent in {project}") creates into the project named on the row. A bare project (sessions, no agent yet) keeps its distinct scaffold verb (`workspace-scaffold-{label}`). `project-start-session-{label}` is removed: a plain session starts from the tab strip, or from the **Start session** on the project's own pane. The empty project still gets no create row of its own; its Agent Map row is the CTA.

On the Group axis every group row carries the same `+` (`group-create-agent-{label}`), scoped to the project that holds the group's members, since a group has no directory.

Follows design-eng `IA.md` 219 and D34(a), D34(c); D34(e) and D35 item 6 for sessions belonging to the tab strip.
