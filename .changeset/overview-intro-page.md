---
"@sapiom/harness": minor
---

Give the account menu's "Overview" its own page — a proper introduction to Agent Studio

"Overview" used to be an alias for the composer home. It now opens a standalone
Overview destination (`OverviewPanel`) that introduces the app: the
build-with-your-coding-agent → shape-on-the-Canvas → run-on-Sapiom loop, a
"How it works" trio, and a grid of what's in the window (embedded coding agent,
Agents rail, Canvas, Templates, deploy, production run, Sapiom capabilities,
zero config mutation). It renders as a full-width destination like Templates
(`.app.is-browsing` hides the panes) with its own top bar, a Build-an-agent CTA
into the composer, and a Start-from-a-template shortcut.

The page follows the Studio brand: neutral chrome throughout, with the scarce
green (`--brand`) spent only on the three "how it works" glyphs. First run warms
the eyebrow to a welcome and, when signed out, hints at connecting a Sapiom
account. "Create new" (the composer) is unchanged and remains the primary
creative action.
