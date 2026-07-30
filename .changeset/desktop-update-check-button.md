---
"@sapiom/harness": patch
---

Add a desktop-only "Check for updates" item to the profile menu, alongside Disconnect.

The Electron app (`@sapiom/harness-desktop`) now ships a minimal preload exposing `window.sapiomDesktop`, and the SPA feature-detects it: the row appears in the desktop app and is **absent** under `npx @sapiom/harness`, where there is no bundle to replace. New `web/src/lib/desktop.ts` owns that detection plus the outcome→copy mapping.

The bridge contract is mirrored here rather than imported, because the dependency runs the other way (the desktop app depends on this package, never the reverse). `getDesktopBridge()` validates the shape rather than trusting a flag, so a desktop build older than a given SPA build reads as "no bridge" instead of throwing inside a click handler and leaving a dead button.

The result arrives as a toast, because the menu closes on click and the outcome is the whole point of pressing it. Outcomes are distinguished rather than collapsed into one "checked!" message, because each has a different next step: downloading (wait), already downloaded (restart, via the native prompt described below), up to date (named with version *and* channel, since a beta and a stable install are up to date at different versions), updates disabled, or the check failed.

Applying an update is confirmed by a **native dialog** raised by the desktop app, and the bridge exposes no way to trigger it. That is deliberate: a restart ends every running agent session, and the page asking for it shares an origin with the agent-authored files the harness serves at `/canvas/:sessionId/*`. Asking for a check when something is already downloaded re-raises that prompt.
