---
"@sapiom/mcp": patch
---

Instructions now cover the sandbox-preview lifecycle: sapiom-dev drives agent
authoring **and sandbox app previews** — `sapiom_dev_sandbox_configure` →
`sapiom_dev_sandbox_check` → `sapiom_dev_sandbox_preview` (live URL; a `failed`
status carries build/start logs). A new `sapiom-sandbox-preview` skill ships in
the plugin so agents route "preview this app" asks correctly.
