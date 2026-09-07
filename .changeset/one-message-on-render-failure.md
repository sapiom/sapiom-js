---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

The canvas Render-failed state shows one message instead of two drawn on top of each other. The app's card and the rendered document both painted the failure reason, and the card is a transparent layer over the document, so the short reason and the long one overlapped and neither was readable. The document now stands its prose down while it is embedded, the same way it already hides its title, badge and legend as chrome the app draws instead. Opened on its own, or embedded somewhere that never takes the message over, the document keeps its prose and is still the only message, so a failure never ends as an empty board.
