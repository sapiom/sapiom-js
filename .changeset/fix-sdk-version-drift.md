---
"@sapiom/axios": patch
"@sapiom/fetch": patch
"@sapiom/node-http": patch
"@sapiom/langchain": patch
"@sapiom/langchain-classic": patch
---

Fix the SDK version reported in request telemetry, which was hardcoded and had drifted from the actual published package version.
