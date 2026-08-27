---
name: sapiom-sandbox-preview
description: Deploy a web app from the current project to a live Sapiom URL —
  either a throwaway sandbox preview or a durable App Link. Use when the user
  wants to preview, host, deploy, or share a web app, dashboard, dev server,
  API, or static site ("preview this app", "give me a live link", "host this
  server"), and especially when they want that link to last ("a permanent
  link", "something I can share with my team", "keep it alive", "my link
  died"), or mentions sapiom.json sandbox resources or App Links. Do NOT use
  for deploying Sapiom agents (that's sapiom_dev_agents_deploy) or for one-off
  capability calls.
---

# Sandbox Previews & App Links

Two ways to put the web app in the current project on a live URL, both driven by the
sapiom-dev MCP (`npx -y @sapiom/mcp`; see the [Get Started guide](https://docs.sapiom.ai/)
if it isn't connected) and both reading the same `sapiom.json` resource:

| You want                                      | Tool                         | The URL                                             |
| --------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| To look at it now, iterate, throw it away     | `sapiom_dev_sandbox_preview` | **Temporary** — dies with the sandbox's `ttl`       |
| A link that lasts, or that someone else opens | `sapiom_dev_app_publish`     | **Durable** — `https://apps.sapiom.ai/{org}/{slug}` |

**This is not agent deployment.** Sapiom _agents_ deploy with `sapiom_dev_agents_deploy`;
both tools here host an ordinary app (Node server, static site, API, dashboard) from your
working directory.

## Prerequisite

Run `sapiom_authenticate` once (browser login; caches a key in `~/.sapiom/credentials.json`).
`sapiom_dev_sandbox_preview` and `sapiom_dev_app_publish` return a structured
not-authenticated error otherwise; `configure` and `check` only touch local files and work
signed-out. Check with `sapiom_status`.

## The lifecycle

1. **`sapiom_dev_sandbox_configure`** — creates or updates a preview resource in the
   project's `sapiom.json`. Fill the typed arguments instead of hand-writing JSON — the
   config is validated and written under `resources.<name>` (`type: "sandbox"`). Returns
   the stored config.
2. **`sapiom_dev_sandbox_check`** _(optional)_ — statically validates the resources without
   deploying. Returns `{ ok, sandboxes, issues }`; fix any `issues` before previewing.
3. **`sapiom_dev_sandbox_preview`** — reads `sapiom.json`, provisions the sandbox if
   needed, uploads the local code, builds, starts, and exposes a public URL. Returns
   `{ name, url, status, logs }`. Pass `name` only when the project defines more than one
   resource.
4. **`sapiom_dev_app_publish`** — when the link needs to outlive the sandbox. See below.

**A `failed` status is not an error** — it carries the build/start logs so you can fix the
app or the config and run `sapiom_dev_sandbox_preview` again. `unverified` means the app
started but didn't answer 2xx yet.

**The preview URL is temporary.** It belongs to a sandbox that expires with the resource's
`ttl` (default `1h`), and it goes away with it — along with any bookmark, Slack message, or
doc anyone pasted it into. Say so when you hand it over, and reach for
`sapiom_dev_app_publish` instead whenever the link is meant to survive.

## Make it durable / share it

Route to **`sapiom_dev_app_publish`** whenever the ask is about the link lasting or leaving
your machine — "share this", "send this to my team", "a permanent link", "keep it alive",
"can I bookmark this", "put this somewhere", "my link died", "the URL stopped working".

```
sapiom_dev_app_publish { slug: "dash", name: "Dash" }
  → { url: "https://apps.sapiom.ai/{org}/dash", appLinkId, bundleSha256, manifest }
```

It reads the **same** `sapiom.json` sandbox resource (source dir, `start`, `port`, optional
`build`/`env`), uploads the source as a stored bundle, and activates it. What to know:

- **Wake on demand, not always-on.** Nothing runs until someone visits. The first visit
  after a publish cold-starts the app — tens of seconds behind a "Starting…" page — then
  it's fast until it idles out again. Tell the user that, so a slow first load doesn't read
  as broken.
- **Org-scoped by default.** Only logged-in members of the organization can open it.
  `visibility: "public"` (anyone with the link) additionally needs `confirmPublic: true`
  and a `dailySpendCapUsd` — the org pays for every wake, so **ask the user before setting
  either**.
- **Republish in place.** Publishing the same `slug` again replaces the app at the _same_
  URL and returns a new `bundleSha256`. That is how you ship an update; never mint a second
  slug for v2.
- **Text-only bundles.** UTF-8 files only — no images, fonts, or archives. A binary is
  rejected **by name** before anything is uploaded; drop it, or use inline SVG, a data URL,
  or a CDN reference. `node_modules`, `.git`, dotfiles and `sapiom.json` are never uploaded,
  so install dependencies at wake with the resource's `build` command.
- **~10 MiB** per bundle over this path. Drop generated output (`dist`, build artifacts,
  vendored assets) rather than shipping it.
- Pass `resource` only when the project defines more than one sandbox resource. `slug`
  (`[a-z0-9-]{1,63}`) is the app's identity; `name` is what the "Starting…" page shows.

The canonical link is the identity — share `https://apps.sapiom.ai/{org}/{slug}`, never the
sandbox address the browser lands on after a wake.

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

| Field    | Required | Notes                                                                                                                            |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `source` | yes      | `{ "kind": "upload", "path"? }` (upload the local dir) or `{ "kind": "git", "slug", "path"? }` (server checks out a Sapiom repo) |
| `start`  | yes      | The server command (e.g. `node server.js`)                                                                                       |
| `port`   | yes      | 1–65535 — the port your app listens on                                                                                           |
| `build`  | no       | Build command run before start (e.g. `npm run build`)                                                                            |
| `tier`   | no       | Sandbox size: `xs` \| `s` \| `m` \| `l` \| `xl`                                                                                  |
| `ttl`    | no       | Sandbox lifetime, e.g. `"1h"`, `"24h"`, `"7d"` — **preview only**; an App Link's URL is not bounded by it                        |
| `env`    | no       | Environment variables (string map)                                                                                               |

Uploads skip `node_modules`, `.git`, and dotfiles — dependencies install in the sandbox at
build time; never upload them.

## CLI alternative

```bash
sapiom sandbox preview [name]   # alias: sapiom sbx preview; add --json for machine output
```

Defaults to the single resource when the project defines exactly one.

## From inside a Sapiom agent step

Steps can deploy previews through the typed client. Get a `Sandbox` instance first —
`await ctx.sapiom.sandboxes.create({...})` or `.attach(name)` — then call
`sandbox.uploadDir(localDir)` to stage the code and
`sandbox.deployPreview({ start, port, build?, env? })` →
`{ url, status: "deployed" | "unverified" | "failed", logs }` (failures return `status:
"failed"` with logs, not a throw). `sandbox.createPublicUrl({ port })` is the low-level
primitive — the port must have been declared when the sandbox was created.

## Reference

Full details: [Compute — Sandbox previews](https://docs.sapiom.ai/capabilities/compute#sandbox-previews).
