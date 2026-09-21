---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Agent Studio: New project and Add project run the folder step first. The rail's top control is one filled `New project` button with no menu: on desktop it opens the OS folder picker directly, on the web a one-field folder dialog on the shared dialog shell; the chosen folder opens as a project and the new-agent screen opens scoped to it. `Add project` (the Projects header's folder-plus) runs the same step and stops. The `Create new agent` CTA and the `Add existing agents` row are gone, and the desktop host no longer sends new agents to `~/.sapiom/harness/projects` (flow-creation.md rev 4 §4.1, §4.5, §4.7, Q8).
