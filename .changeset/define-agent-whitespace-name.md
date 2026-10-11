---
"@sapiom/agent": patch
---

`defineAgent` checked `!def.name`, so a whitespace-only name (`"   "`) passed validation despite the documented "non-empty name" requirement. Matches the same presence contract harness's `refuseAgentName` already enforces (`typeof name !== "string" || name.trim() === ""`).
