---
"@sapiom/harness": minor
---

Project rows in the rail now carry one action control instead of two glyphs that acted on different things. The `+` created an agent inside the project while the `×` removed the project itself — same size, side by side, so `+` read as "add project". Both now live behind the row's `⋮`, where each action names its own subject ("Create an agent in <project>", "Remove <project> from the rail").

Double-clicking a project or folder label now folds and unfolds it, the way the chevron always has. On a project row the single click still selects, so a double-click leaves the project both selected and folded.

A one-time card explains what projects and agents are and what happens to your rows on upgrade. It is dismissible, shown once, and re-openable from the account menu.
