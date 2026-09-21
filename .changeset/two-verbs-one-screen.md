---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Agent Studio creation is two verbs, one screen, one session type. The rail's top control is `New project`: it runs the folder step (the OS picker on desktop, a one-field dialog on the web), opens the folder as a project, and lands on the new-agent screen scoped to it. `Add project` runs the same step and stops. A project row's New agent, an empty project's name and template Use land on the same screen. Submit scaffolds the agent through `POST /api/agents/scaffold` first (a refusal lands under the field and nothing starts), then opens one ordinary session on it whose first prompt is the idea, the attached files, the linked sources and the planning instructions as session setup. Opening a project no longer creates an automatic "Plan Agents" session, and the desktop host no longer sends new agents to `~/.sapiom/harness/projects`. Past sessions moves from the Projects options menu to a history glyph in the rail's top bar. The create dialogs, the detect flow and the English scaffold prompt are deleted.
