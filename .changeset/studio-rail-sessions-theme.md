---
"@sapiom/harness": minor
---

Studio shell polish — left rail, theme, and the session bar:

- **Even rail spacing.** The workspace panel's top stack (agent.studio → Search → Create new → Templates → Workspaces) now sits on one uniform 8px rhythm instead of three different gaps.
- **"Create new" CTA.** A standing button under Search opens the Add menu (new session / workspace / templates). When the rail has no agents yet it becomes the filled brand-green primary with a soft ring, so a first-run workspace has an obvious next step.
- **Theme follows the OS by default.** With no saved choice the Studio mirrors the system light/dark preference and keeps tracking it across launches; a manual toggle still wins and persists.
- **Session switcher in the title menu.** The current session is a single selector whose ⌄ menu lists every live session (disambiguated by name + last-active time, active one checked), plus New session and the session actions. This replaces the inline chips — sessions that share a base name no longer read as a row of near-identical labels — and the bound-agent line moves into that menu.
