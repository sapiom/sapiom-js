---
"@sapiom/harness": patch
---

Remove unreachable legacy project graph browser code from Studio's bundled client and server. This internal cleanup preserves durable Agent Map navigation, project-wide conversation tabs, and ordinary sessions' independent Canvas and Steps views.

Restore each project's map pan and zoom when returning from another project or an agent Canvas. If the saved view would leave every node offscreen, fit the map into view.
