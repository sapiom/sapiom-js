---
"@sapiom/harness": minor
---

Studio rail: an agent is never a project, and a row that is both opens the agent.

**Rows you had may disappear on upgrade, and no files are touched.** The rail now
derives its project list from one rule: a project is a directory you chose that
holds agents. Two kinds of row stop being drawn:

- A remembered folder that is an agent's **own** directory. It is dropped when
  another project already shows that agent, and otherwise replaced by the folder
  that holds it. These were residue of a fixed bug (a session used to root at the
  agent's folder, and that folder got remembered), and they rendered the same
  agent twice: once nested under its project and once again at top level. On one
  real install this cut 42 project rows to 3 with all 89 agents still visible.
- A folder known only because a session ran there and holding no agent, unless a
  session is live in it.

Nothing is deleted: `recentDirs` is untouched and any folder is one **Add a
project** away from coming back. Opening an agent's own folder now opens the
folder that holds it, rather than doing nothing.

Also: a project row whose root is an agent now opens that **agent** on click
instead of a dependency graph with one node in it; the graph moves to its own
control on the row. Every project row gains a hover **+** that creates an agent in
that folder. The rail header reads "Projects" on both axes, the primary call to
action reads "Create new agent", and two rail rows that painted a solid brand
green (the "New group" row on hover, and the armed "Reset to detected groups"
row) are a neutral hover and a red wash.
