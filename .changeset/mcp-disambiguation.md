---
"@sapiom/mcp": patch
---

Reframe `@sapiom/mcp` as the local Sapiom developer MCP (`sapiom-dev`) to stop it being conflated with the remote `sapiom` capability MCP.

Two servers brand as "Sapiom": the remote `sapiom` MCP is the production capability surface (paid, gateway-routed — `sapiom_sandbox_*`, scrape, search, …); this package is the local `sapiom-dev` MCP — the unmetered `sapiom_dev_*` developer surface for building and operating on Sapiom (today it scaffolds, tests, deploys, and inspects orchestrations) and it exposes no capability tools. The dividing line is billing, not task: the `sapiom_dev_*` namespace is reserved for developer tooling and never makes a paid capability call. The runtime server names already differed, but the package/registry name and descriptions read generically.

- Adds a `packages/mcp/README.md` framing the package as the local developer MCP, with the `npx -y @sapiom/mcp` install snippet, `SAPIOM_ENVIRONMENT` config, and the `sapiom_authenticate` browser-login flow.
- Sets a client-facing `title` ("Sapiom Dev — local developer tools") and `description` on the MCP server; the wire `name` stays `sapiom-dev`.
- Sharpens the `package.json` / `server.json` descriptions and the `sapiom_authenticate` / `sapiom_status` tool descriptions to say which Sapiom this is.

Docs-only / metadata change — no behavior change to either MCP.
