---
"@sapiom/harness": patch
---

Studio run and step-inspection hardening:

- Auto-bind a session to the workflow in its folder the moment the session starts, not only when a file later changes — so the canvas and Run actions light up immediately for an existing workflow.
- Animate the canvas board (per-step running / passed / failed status) during both local and production runs.
- Never let a direct action (Local Run / Prod Run / Deploy) fail silently: surface the reason on a blocked click, clear the in-flight indicator when the action settles, and distinguish "deploy failed — retry" from "not deployed yet".
- Enrich the step inspector: per-step input/output and logs, the capability calls a step made (with the served stub values on offline runs), and clickable preview / download / research links found in a step's output — all shown when you click into a step.
