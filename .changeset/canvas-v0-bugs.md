---
"@sapiom/harness": patch
---

Fix two canvas v0 bugs:

**UI (CanvasPane)**: While an enrichment task runs, the activity strip now overlays the iframe instead of replacing it. The deterministic SVG render is visible immediately after binding; the spinner appears on top during the LLM annotation pass and disappears on completion. Failure state (Retry/Dismiss) remains full-screen and is unchanged.

**Server (forceRefresh)**: The already-running check for a workflow's enrichment task is now performed before any cache invalidation or re-render. A double-clicked Visualize correctly rejects with a 409 and leaves the enrichment cache and render files exactly as the still-running task will need them.
