---
"@sapiom/mcp": patch
---

Re-sync the offline `AUTHORING_INSTRUCTIONS` fallback with the primer the server
actually serves. This is the text an agent gets on connect when the server's startup
fetch of `GET /v1/mcp/instructions` fails; it had fallen behind, so offline sessions
were told App Links do not exist.

Added, matching what online sessions already receive:

- **App Links** — publishing a durable `https://apps.sapiom.ai/{org}/{slug}` that
  outlives the sandbox a preview URL dies with, via `sapiom_dev_app_publish` (needs
  `@sapiom/mcp` >= 0.13), the hosted `sapiom_app_publish`, or the REST route.
- The current alias framing: local authoring under `sapiom`, hosted one-off capability
  calls under the distinct `sapiom-direct` alias.
- Corrected lifecycle wording for `sapiom_dev_agents_check`, `_run_local`, and
  `sapiom_authenticate`, and the fuller docs links.

Removed, because the served primer does not carry it: the detailed `ctx.shared` quota
paragraph (256 KiB limit, `JSON.stringify` measurement, setter-time validation, no
`delete()`). This fallback had it and the served text did not, so most sessions never
saw it. It remains documented in `@sapiom/agent`'s README and the scaffold-shipped
`sapiom-agent-authoring` skill.
