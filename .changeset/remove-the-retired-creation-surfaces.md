---
"@sapiom/harness": patch
---

Agent Studio: the retired creation surfaces are gone. `CreateAgentDialog`, `TemplateUseDialog`, `StartDialog` with its detect flow, `project-dir` (`slugifyIdea`, `uniqueProjectDir`, `resolveProjectRoot`) and `firstInstructionPrompt` are deleted; the Overview card's "Open folder" runs the folder step; the web fallback for the folder step is the one-field `ProjectFolderDialog` on the shared dialog shell. Every entrance lands on one screen and every create goes through `POST /api/agents/scaffold` (flow-creation.md rev 4 §5, Q4).
