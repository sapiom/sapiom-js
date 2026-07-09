---
"@sapiom/harness": patch
---

Skills panel Use button populates the terminal (no auto-submit); Sapiom skills registered as session slash commands via --plugin-dir.

- Re-adds the "Use skill" button to the skill detail view. Clicking it calls
  `injectInput` with `submit:false`, writing the text to Claude's input line
  without sending Enter — the user edits and presses Enter themselves.
- Package skills populate `/<id> ` (slash command with trailing space for args);
  user skills populate a natural-language invocation `Use the "<name>" skill: <desc>`.
- Button is disabled with a visible reason when there is no ready session.
- On success, a toast confirms "Typed into the terminal — edit and press Enter."
- Adds `generateSkillsPlugin` in `core/inject/skills-plugin.ts`: creates a
  per-session `--plugin-dir` from the Sapiom skills bundled in `@sapiom/agent-core`.
  claude-code auto-discovers `<plugin-dir>/skills/<name>/SKILL.md` and registers
  `/<name>` as a slash command. Gracefully no-ops when agent-core's skills dir is
  absent or unresolvable — the session still launches normally without the flag.
- `LaunchOpts.pluginDir` added; `ClaudeCodeAdapter.buildConfigArgs` emits
  `--plugin-dir <path>` when set. Codex adapter ignores the field (unchanged).
