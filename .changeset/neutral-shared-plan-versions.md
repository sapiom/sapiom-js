---
"@sapiom/harness": minor
---

Add role-neutral immutable Agent Map and shared build-plan versions, durable
migration and concurrency-safe persistence, universal build-plan authoring
tools, and the reserved neutral focused-brief history seam.

**Breaking:** `ProposalActor` and proposal-history payloads now contain only
trusted `userId` and `sessionId` attribution. Consumers must stop reading or
constructing the removed `role` and `assignment` fields; those fields never
represented write or implementation authority.
