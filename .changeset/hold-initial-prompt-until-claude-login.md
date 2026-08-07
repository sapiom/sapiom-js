---
"@sapiom/harness": patch
---

Hold a new session's first prompt until Claude Code is signed in

Starting a session from the composer (or a template/clone) created the session and then fired the initial prompt immediately, retrying only on a 409 for ~9s. But a Claude Code session only becomes injectable once its `SessionStart` hook fires — which doesn't happen until the user is past Claude's own login/onboarding. A first-time, not-yet-signed-in user therefore blew past the 9s window and the prompt was silently dropped.

The prompt is now held per session and sent the moment the session reports ready (i.e. Claude is signed in and interactive). If the session is still not ready after a short grace, a hint points the user at the terminal login ("Sign in to Claude in the terminal — your prompt sends automatically once you're signed in"), so first-run intent is preserved instead of lost.
