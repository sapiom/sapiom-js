---
name: sapiom-sandbox-preview
description: Deploy a live preview of a web app from the current project to a
  Sapiom sandbox. Use when the user wants to preview, host, or deploy a web
  app, dev server, API, or static site to a live URL ("preview this app",
  "give me a live link", "host this server"), or mentions sapiom.json sandbox
  resources. Do NOT use for deploying Sapiom agents (that's
  sapiom_dev_agents_deploy) or for one-off capability calls.
---

# Sandbox Previews

Deploy the web app in the current project directory to a Sapiom **sandbox** and get a
**live public URL** — provisioned, uploaded, built, and started in one tool call. Driven
by the sapiom-dev MCP (`npx -y @sapiom/mcp`; see the [Get Started guide](https://docs.sapiom.ai/)
if it isn't connected).

**This is not agent deployment.** Sapiom *agents* deploy with `sapiom_dev_agents_deploy`;
sandbox previews host an ordinary app (Node server, static site, API) from your working
directory.

## Prerequisite

Run `sapiom_authenticate` once (browser login; caches a key in `~/.sapiom/credentials.json`).
The sandbox tools return a structured not-authenticated error otherwise. Check with
`sapiom_status`.

## The lifecycle

1. **`sapiom_dev_sandbox_configure`** — creates or updates a preview resource in the
   project's `sapiom.json`. Fill the typed arguments instead of hand-writing JSON — the
   config is validated and written under `resources.<name>` (`type: "sandbox"`). Returns
   the stored config.
2. **`sapiom_dev_sandbox_check`** *(optional)* — statically validates the resources without
   deploying. Returns `{ ok, sandboxes, issues }`; fix any `issues` before previewing.
3. **`sapiom_dev_sandbox_preview`** — reads `sapiom.json`, provisions the sandbox if
   needed, uploads the local code, builds, starts, and exposes a public URL. Returns
   `{ name, url, status, logs }`. Pass `name` only when the project defines more than one
   resource.

**A `failed` status is not an error** — it carries the build/start logs so you can fix the
app or the config and run `sapiom_dev_sandbox_preview` again. `unverified` means the app
started but didn't answer 2xx yet.

## The `sapiom.json` resource

```json
{
  "version": 1,
  "resources": {
    "web": {
      "type": "sandbox",
      "source": { "kind": "upload" },
      "start": "node server.js",
      "port": 3000,
      "ttl": "1h"
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `source` | yes | `{ "kind": "upload", "path"? }` (upload the local dir) or `{ "kind": "git", "slug", "path"? }` (server checks out a Sapiom repo) |
| `start` | yes | The server command (e.g. `node server.js`) |
| `port` | yes | 1–65535 — the port your app listens on |
| `build` | no | Build command run before start (e.g. `npm run build`) |
| `tier` | no | Sandbox size: `xs` \| `s` \| `m` \| `l` \| `xl` |
| `ttl` | no | Sandbox lifetime, e.g. `"1h"`, `"24h"`, `"7d"` |
| `env` | no | Environment variables (string map) |

Uploads skip `node_modules`, `.git`, and dotfiles — dependencies install in the sandbox at
build time; never upload them.

## CLI alternative

```bash
sapiom sandbox preview [name]   # alias: sapiom sbx preview; add --json for machine output
```

Defaults to the single resource when the project defines exactly one.

## From inside a Sapiom agent step

Steps can deploy previews through the typed client: `ctx.sapiom.sandboxes.uploadDir(localDir)`
to stage the code, then `sandbox.deployPreview({ start, port, build?, env? })` →
`{ url, status: "deployed" | "unverified" | "failed", logs }` (failures return `status:
"failed"` with logs, not a throw). `createPublicUrl({ port })` is the low-level primitive —
the port must have been declared when the sandbox was created.

## Reference

Full details: [Compute — Sandbox previews](https://docs.sapiom.ai/capabilities/compute#sandbox-previews).
