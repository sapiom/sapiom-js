---
"@sapiom/harness": patch
---

Fix Claude Code sessions that exit with code 1 before establishing a session id, and make the cause visible when they do.

Some users saw a session die within seconds — "Session exited · exit code 1 … it exited before establishing a session id" — with no way to tell why. The session id is only ever set from Claude Code's `SessionStart` hook, so this always means `claude` itself exited before that hook fired. Three independent, environment-specific causes were addressed, each of which is ours to prevent:

- **Version floor for `claude` (doctor).** The harness injects flags on every launch — notably `--plugin-dir`, which per the Claude Code changelog did not exist before the plugin system shipped in `2.0.12` — but nothing checked the installed version, so an older `claude` (a pre-existing global that shadows the app's install, or a stale one) rejected the unknown flag and exited 1 before the hook. `doctor` now enforces `MIN_CLAUDE_CODE_VERSION` (`2.1.0`, the range the harness's `--plugin-dir` skills usage is verified against): a below-floor `claude` reports NOT ok, so the desktop app installs a current one and the `npx` CLI shows an actionable upgrade remedy instead of every session crash-looping silently. A version we can't parse is left alone, so a future change to `claude --version`'s format can never mass-reject working installs.

- **Quote the SessionStart hook command path.** The generated hook command interpolated the emitter-script path unquoted (`node <path> <event>`). Claude Code runs a `command` hook through a shell, so a home directory containing a space (`/Users/First Last/…`) word-split the path — `node` got a truncated path, the hook died, and the session id was never established. The path is now double-quoted.

- **Preserve the agent's error line on abnormal exit.** A live pty's scrollback was discarded the instant it exited, so `claude`'s own error ("unknown option '--plugin-dir'", an auth failure, "Cannot find module …") was lost — which is why this was so hard to diagnose from a report. Sessions that exit with a non-zero code now keep a sanitized tail of their last output (`HarnessSession.exitTail`), shown in the exited-session pane. A clean exit keeps nothing.

The shared ANSI stripper used for this and for Codex trust-prompt detection moved from the Codex adapter into `core/strip-ansi.ts`.
