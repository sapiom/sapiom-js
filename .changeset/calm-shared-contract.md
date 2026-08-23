---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
"@sapiom/agent-core": patch
"@sapiom/mcp": patch
---

Publish the authoritative 256 KiB `ctx.shared` whole-snapshot contract from
`@sapiom/agent`: `CTX_SHARED_QUOTA_CONTRACT`,
`MAX_SHARED_SNAPSHOT_BYTES`, `measureCtxSharedSnapshotBytes`,
`findCtxSharedSizeViolation`, `CtxSharedSizeLimitExceededError`,
`ctxSharedSizeLimitExceededPayloadSchema`, and
`isCtxSharedSizeLimitExceededPayload`, plus the
`CtxSharedSizeLimitPhase`, `CtxSharedSizeViolation`,
`CtxSharedSizeLimitExceededPayload`, and
`CtxSharedSizeLimitExceededErrorOptions` types.

`@sapiom/agent-runtime` now publicly exports `stepCompletionErrorSchema`,
preserves compatible structured quota payloads through protocol-1 parsing, and
re-exports the canonical compatibility limit.

This release defines measurement and error contracts; it does not make
`ctx.shared.set()` an atomic size gate or add local/final host-boundary
enforcement by itself. Host versions must adopt the contract. Authoring skills,
scaffolds, and MCP guidance now document compact ID/reference usage and that
enforcement can vary during rollout.
