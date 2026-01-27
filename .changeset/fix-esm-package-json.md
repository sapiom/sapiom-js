---
"@sapiom/axios": patch
"@sapiom/fetch": patch
"@sapiom/core": patch
"@sapiom/langchain": patch
"@sapiom/langchain-classic": patch
"@sapiom/node-http": patch
---

Fix ESM imports in Node.js by adding `{"type": "module"}` package.json to dist/esm folders
