---
"@sapiom/langchain": patch
"@sapiom/langchain-classic": patch
"@sapiom/axios": patch
"@sapiom/node-http": patch
---

Mark as deprecated. Sapiom now settles paid capability calls server-side (the collapsed flow), so client-side 402/authorization handling is no longer needed. These packages remain published and receive maintenance fixes only — new projects should build on the agent stack (`@sapiom/agent` + `@sapiom/tools`). Adds a deprecation notice to each README.
