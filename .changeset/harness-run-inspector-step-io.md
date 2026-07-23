---
"@sapiom/harness": patch
---

Show real per-step input and output in the run inspector's "Last run" section. When a step's run recorded the value it ran on and the value it produced, each is rendered as a collapsible, inspectable payload; a step that carried no input/output shows no block at all (never a fabricated placeholder). Objects are pretty-printed, plain strings shown as-is, and a real `null`/`false`/`0` is displayed faithfully.
