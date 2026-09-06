---
"@sapiom/harness": minor
---

Migrate persisted project maps atomically to immutable version histories and role-neutral proposal attribution, with storage for shared build plans. Map and brief quotas, malformed aggregates and unsupported storage schemas now report terminal manual-intervention recovery through MCP; operation history is explicitly bounded before writes.

**Breaking:** `ProposalActor` and proposal-history payloads now contain only trusted `userId` and `sessionId` attribution. Consumers must stop reading or constructing the removed `role` and `assignment` fields and use `sessionId` for attribution. Those fields never represented write or implementation authority.
