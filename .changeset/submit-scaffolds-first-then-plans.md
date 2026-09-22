---
"@sapiom/harness": patch
---

Agent Studio: submit scaffolds first, then one ordinary session that plans first. The new-agent screen calls `POST /api/agents/scaffold` in its project and only then opens an ordinary session bound to the agent; a refusal lands under the field and nothing starts. `CreateSessionRequest` loses `scaffold` (the harness never scaffolds inside a session any more; embedders call the scaffold endpoint, then create the session) and gains `initialSources` (links handed to the first prompt by URL) and `initialSetup` (session setup shown as a collapsed "Planning instructions" disclosure, never as the user's words). Template Use routes through the same screen; `TemplateUseDialog` is unreachable (flow-creation.md rev 4 §4.4, §4.6 steps 2 and 3, D30, D31, D37).
