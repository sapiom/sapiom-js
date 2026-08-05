---
"@sapiom/harness": patch
---

Recolor the embedded terminal so Claude Code's accent colors match the Studio
brand, without touching the terminal background.

Claude Code renders in 256-color by default, so the terminal's own 16-color
palette never reached its output — its "blue", "green", etc. were Claude's, not
Studio's. Each Claude session is now pinned to Claude Code's `dark-ansi` /
`light-ansi` theme (matched to the app theme) through the generated `--settings`
file, which routes Claude's colors through the terminal's ANSI ramp. That ramp
(`Terminal.tsx`) is retuned to a brand-coherent palette: a calmer blue, the
Studio green for success/live state, and harmonized red / yellow / cyan /
magenta that read cleanly on the recessed `--bg` surface (which is unchanged).

The app theme is threaded through session create and persisted on the session so
resume keeps the same base; unthemed launches (server-side auto-create, a legacy
session resumed from before this existed) omit the theme and keep Claude's
default rendering.
