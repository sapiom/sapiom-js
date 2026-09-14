---
"@sapiom/mcp": patch
---

`sapiom_dev_agents_inspect` and `sapiom_dev_agents_signal` now reject a non-numeric `executionId` at the schema, with a message naming where a real id comes from. Passing a step name or a variable (`result`, `child-expert-1`) previously reached the server and came back as "execution not found", which reads as "the run is gone" rather than "that is not an id".
