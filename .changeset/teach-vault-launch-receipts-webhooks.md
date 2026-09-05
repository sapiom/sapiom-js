---
"@sapiom/mcp": patch
"@sapiom/harness": patch
"@sapiom/agent-core": patch
---

Re-sync the offline teaching fallbacks with the 2026-09 served-text release (SAP-3180), so a
session whose startup fetch fails learns the same four things an online session does:

- **Vault semantics** — secrets are set in the dashboard per deployed agent; agent code reads
  `ctx.sapiom.vault.get` and cannot write; a Sapiom-managed resource is used through its
  handle, never by copying its credentials into Vault.
- **`ctx.sapiom.agents.launch`** — fire-and-forget dispatch of a deployed agent for any caller
  that must return fast (a webhook receiver); `agents.run` waits for the terminal state.
- **Receipts and manual replay** of inbound events, pointed at the REST surface until a tool
  exists.
- **App Link webhooks** — `/hook/*` forwarding, off by default behind `webhooksEnabled`, 60 s
  hold, byte-exact body so third-party signature schemes verify inside the app.

`@sapiom/mcp`'s `AUTHORING_INSTRUCTIONS` (primer 2.9) and `@sapiom/harness`'s
`DEFAULT_SYSTEM_PROMPT` (1.1) move with their digest pins; the 2.9 primer also drops the
`deadlineMinutes` clause that offered a knob `llm.run` does not have. The
`sapiom-agent-authoring` skill gains a pointer to where these are taught, not a restatement.
