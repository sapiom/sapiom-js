---
"@sapiom/harness": minor
---

The Studio "new session" experience is now composer-first. Instead of opening on a terminal-and-canvas workbench (with the canvas showing "nothing generated yet") behind a first-run welcome overlay, a fresh install — and Create new / New session / the + — opens a centered composer: a greeting, **"What should your agent do?"**, quick-idea chips, an input with an agent selector and send, and a **"Start from a template"** row. Describing an outcome starts a session and hands the agent that outcome (the same create+inject path the "start from an idea" door uses); the screen then gives way to the terminal, and the canvas slides in only once that session generates content — the manual show/fold still overrides. The first-run WelcomePanel overlay is retired; its open-folder, browse-templates, docs, and telemetry opt-in fold into the composer, and recent workspaces live in the rail.
