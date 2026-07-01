---
"@sapiom/orchestration-core": patch
---

`coding-pause` template now gates the publish to `main` behind the human approval
(SAP-1038)

The scaffolded `coding-pause` orchestration previously let the coding agent push
inside its own run before the pause, so the approval sat _downstream_ of the
irreversible push — "reject" couldn't prevent anything. The template is rewritten
as the two-agent variant: agent #1 writes the change to a non-canonical
`proposed/<executionId>` branch, the workflow pauses on a `review.decision`
signal, and only on approve does agent #2 promote that branch onto `main`. A
rejected (or unapproved) run leaves `main` untouched; an approved run publishes to
`main` only after the approve signal. No engine or platform change — it works on
the local coding substrate today.
