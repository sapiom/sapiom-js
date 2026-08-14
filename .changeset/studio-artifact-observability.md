---
"@sapiom/agent-core": minor
"@sapiom/harness": minor
"@sapiom/harness-desktop": patch
---

Add an artifact-first Studio run workspace for local and cloud agents. Studio now
collects schema-driven input, streams chronological attempt evidence, renders
bounded outputs with Rendered and Raw views, and provides an isolated Focus mode
for inspecting input, output, state, directives, logs, and recorded capability
calls.

Local agent execution now emits start and settled trace events with timing,
directive, shared-state, log, and capability-call evidence. Desktop development
launches rebuild Harness first so Electron always opens the current Studio UI.
