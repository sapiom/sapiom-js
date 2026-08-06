---
"@sapiom/harness-desktop": patch
"@sapiom/harness": patch
---

Fix new agents nesting under `projects/<agent>/projects/…` in Studio, deepening
on every launch. The desktop host derived its launch dir from the most-recent
session dir, which drifted into a project folder — so `<launchDir>/projects`
(where new agents are created) appended a second `projects/` inside it, and the
new agent's session cwd fed back in to nest even further next time. Pin the
launch dir to the harness home so every agent stays flat under one `projects/`
and the rail scans them all. The same `projectRoot` pin also fixes the template
destination, which nested (and failed with "Couldn't read that directory") for
the same reason. The "Add existing agents" folder picker now opens on the
project root where agents live.
