---
"@sapiom/harness": patch
---

Stop the empty-board auto-collapse from closing a canvas pane the user just opened. The collapse fires once per (session, binding), which was meant to make a redundant "still empty" probe harmless — but the pane's expand control is most often used right after starting a session on an agent, i.e. *before* `activeSessionId` exists, so the probe that follows arrives under a different key and slams the pane shut a beat after the click (measured: 3–5 of 12 runs of the action-bar e2e, on `main`). A manual expand now claims the session, and a claim made while none is active adopts the one that reports next; switching sessions still re-arms the collapse.
