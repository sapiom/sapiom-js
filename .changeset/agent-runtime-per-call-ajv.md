---
"@sapiom/agent-runtime": patch
---

Manifest input validation no longer retains a compiled validator per call, so a long-lived process hosting `AgentRunnerCore` stops growing with every validated step.
