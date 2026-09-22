---
"@sapiom/harness": patch
---

Agent Studio: the new-agent screen takes a project and takes links and documents. `NewSessionComposer` is mounted only with a project and states it ("New agent in {project}") above the headline and in the session bar chip; New project, a project row's New agent, and an empty project's name all land on it. A paste that is only links is listed as sources and handed to the session by URL; a long paste becomes an attached document instead of a wall of text. An install with no project sees the no-project home, whose one move is New project (flow-creation.md rev 4 §4.3, §4.6 step 1, D36).
