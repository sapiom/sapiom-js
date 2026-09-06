---
"@sapiom/harness": patch
---

Prevent terminal mount cleanup from disposing the renderer before xterm's
queued viewport initialization runs. Ignore callbacks from closed terminal
connections and preserve workspace preferences across reloads in the Studio demo.
