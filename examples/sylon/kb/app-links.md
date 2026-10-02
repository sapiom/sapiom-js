# App Links

Source: https://docs.sapiom.ai/capabilities/app-links

An **App Link** is a durable Sapiom-hosted URL for a small web app — a dashboard, a demo, an internal tool, a workflow UI:

```
https://apps.sapiom.ai/{your-org}/{your-app}
```

The link is the durable thing, not the sandbox behind it. You publish a bundle once; the URL keeps working. When someone opens it, Sapiom checks who they are, wakes the app from the stored bundle if nothing is running, and hands them over to it. Sandboxes stay short-lived and disposable — the link outlives all of them.

That is the difference from a sandbox preview URL, which lives and dies with its sandbox: when the TTL expires, the preview link stops resolving. See [Compute](/capabilities/compute) for sandboxes themselves.

## Wake on demand

Nothing runs between visits. That keeps an App Link cheap — you pay for the seconds an app is actually awake, not for idle hosting — and it is the main thing to understand before you share one:

1. **A visit arrives.** Sapiom verifies the visitor may open this app.

2. **If the app is already awake,** the visit is handed straight to it. This is fast.

3. **If nothing is running,** the visitor sees a "Starting …" page while Sapiom creates a sandbox and deploys your bundle. **Expect tens of seconds.** The page redirects itself when the app is ready.
   The first visit after a publish is always a cold start. So is the first visit after the app has been idle long enough for its sandbox to expire.

> **Caution: This is durable sharing, not hosting.**
> App Links are built for apps a handful of people open a few times a day. They are deliberately a poor fit for anything latency-sensitive or public-facing at volume — a cold start of tens of seconds is a normal outcome, not a fault. If you need always-on, use real hosting.

## What the URL does

An App Link is a **redirector, not a reverse proxy**. Under `/{your-org}/{your-app}` the host serves exactly three things, and forwards nothing else:

| Path                    | What it answers                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/{org}/{app}`          | The link itself. A **302** to the preview URL currently serving the app — or, on a cold start, the "Starting …" page, which redirects itself once the wake finishes.                                                                 |
| `/{org}/{app}/__status` | Wake status as JSON, for that page: `{"status":"waking"}`, `{"status":"ready","url":"…"}`, or `{"status":"failed","error":"…"}`. Same access rules as the link; a caller who is not signed in gets `401 {"error":"login_required"}`. |
| `/{org}/{app}/hook/…`   | Inbound webhooks, when `webhooksEnabled` is on for the link (**off by default**) — forwarded to the app byte-exact with the prefix stripped. See [Webhooks](#webhooks).                                                              |

Any other path under the link — `/{org}/{app}/api/orders`, say — is **not proxied**. It is a 404 from the host, and your app never sees the request.

> **Caution: API calls must use the preview URL, not the link.**
> This is the part that changes how you architect around an App Link. The
> durable URL is for a **person opening the app in a browser**. Anything that
> calls the app's own API — another service, a scheduled job, a health check —
> has to talk to the preview URL the redirect landed on, not to a sub-path of
> the link.
>
> From inside the app this costs you nothing: the browser is already on the
> preview origin after the redirect, so relative paths (`fetch("/api/orders")`)
> work as you would expect. It is calls from _outside_ the app that need the
> preview address.

### Getting the current preview address

Do not hard-code it either, and do not store one you have resolved. The preview URL belongs to whichever sandbox is serving the app right now: a wake that has to recreate the sandbox produces a new one, and for an organization-scoped app the URL only works with a short-lived token (one hour) that Sapiom appends for the visitor. A URL you resolved and saved therefore stops working even without a new wake — the token expires under it. Re-resolve it per use. Two ways:

- **Follow the redirect.** A `GET` of the link, with the visitor's credentials, comes back as a 302 whose `Location` is the tokenized preview URL. On a cold start you get the "Starting …" page instead, which polls until it can redirect.
- **Read `__status`.** While a wake is in flight it answers `waking`; when the app is up it answers `{"status":"ready","url":"…"}` with that same tokenized URL. This is what the "Starting …" page itself polls.

> **Caution: Both routes need a signed-in member, not an API key.**
> `__status` runs the same access check as the link itself, deliberately — its
> `ready` payload _is_ the tokenized preview URL, so it has to be exactly as hard
> to reach as the link. That check reads the visitor's Sapiom session cookie. A
> Sapiom API key does not open either route.
>
> So for an **organization-scoped** app, reaching the app's own API is a
> browser-shaped operation. A server-side caller — a cron job, another service,
> an agent holding an API key — has two supported routes and neither is the
> preview URL:
>
> - **Publish the app `public`.** A public app's link and `__status` need no
>   session at all, so a server-side caller uses the same two routes above — and
>   the redirect is what wakes the app. Remember that public means anyone with
>   the link can wake it and your organization pays.
> - **Receive the traffic instead.** Turn on `webhooksEnabled` and let the caller
>   POST to `/hook/…`. That path is the one thing the host forwards to a sleeping
>   app, and it needs no session at all.

`GET /v1/app-links/{id}` reports `currentPreviewUrl` and `wakeStatus`. Treat them as **inspection, not an address**: the field is null right after a publish (activating a bundle marks the binding stale and leaves the old values), it can point at a sandbox that has since expired, and reading it wakes nothing. For an organization-scoped app it also carries no token. Go through the link.

## Publish an app

A publish needs three things: the app's files as UTF-8 text, the command that starts it, and the port it listens on. `start` runs inside a fresh sandbox on every wake, so the bundle must be self-contained.

Which surface you reach for depends on where the app already lives. From a project on disk, the local tool reads all three out of `sapiom.json` for you; the hosted MCP and REST take an explicit file map.
**Agent Studio**

In Agent Studio — or any coding agent on the local `sapiom-dev` MCP — call `sapiom_dev_app_publish`. It is the durable sibling of `sapiom_dev_sandbox_preview`: same project, same `sapiom.json` `type: "sandbox"` resource, different destination.

```json
{
  "slug": "quarterly-dashboard",
  "name": "Quarterly dashboard"
}
```

There is no file map. The tool reads the source directory, `start`, `port`, and the optional `build` and `env` out of the sandbox resource you already configured with `sapiom_dev_sandbox_configure`, uploads that source as a stored bundle, and activates it. `node_modules`, `.git`, dotfiles, symlinks, and `sapiom.json` itself are never uploaded — install dependencies at wake with `build`.

Add `resource` when the project defines more than one sandbox resource, `dir` when the project is not your working directory, and `visibility` with `confirmPublic` and `dailySpendCapUsd` to publish a public app. It returns `{ url, appLinkId, bundleSha256, manifest }`.

The 10 MiB bundle cap and the text-only rule are both enforced locally, before any upload, so a bad bundle costs no round trip and never leaves a half-published link behind.

> **Note: Tier and ttl do not travel.**
> `env` from the sandbox resource follows the app and is stored encrypted. Its `tier` and `ttl` deliberately do not: how long the sandbox behind a wake lives is Sapiom's business, and not having to care about it is the point of publishing.
> **Hosted MCP**

From a coding agent connected to the hosted capability MCP (the `sapiom-direct` alias), call `sapiom_app_publish` with the files inline — useful when the app was generated in the conversation rather than checked out on disk:

```json
{
  "slug": "quarterly-dashboard",
  "name": "Quarterly dashboard",
  "files": {
    "index.html": "<!doctype html><html>…</html>",
    "server.js": "const { createServer } = require('node:http'); …"
  },
  "start": "node server.js",
  "port": 3000
}
```

It returns the live URL, the app link id, and the bundle digest. Keep the file map small — the whole tool call has to fit the MCP transport's ~100 KB request body cap. For a bigger app, install dependencies at wake with `build` instead of bundling them, or publish over REST.
**REST**

Three calls: create or update the app, upload the bundle, publish it.

```bash
# 1. create (or update) the app link
curl -X POST https://api.sapiom.ai/v1/app-links \
-H "x-api-key: $SAPIOM_API_KEY" -H 'content-type: application/json' \
-d '{"slug":"quarterly-dashboard","name":"Quarterly dashboard"}'

# 2. upload the bundle
curl -X PUT https://api.sapiom.ai/v1/app-links/$APP_ID/bundle \
-H "x-api-key: $SAPIOM_API_KEY" -H 'content-type: application/json' \
-d '{"files":{"index.html":"<!doctype html>…"},"start":"node server.js","port":3000}'

# 3. publish
curl -X POST https://api.sapiom.ai/v1/app-links/$APP_ID/publish \
-H "x-api-key: $SAPIOM_API_KEY"
```

The REST path accepts bundles up to 10 MiB, so use it for anything the MCP body cap rejects.
**Workflow**

A workflow step can publish its own output, so a scheduled run can keep a dashboard current at a link people already have. A step body calls the same REST API, using the credential the run already has — `SAPIOM_API_KEY` is injected into every step, so there is nothing extra to configure:

```typescript
const api = process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai";
const headers = {
  "x-api-key": process.env.SAPIOM_API_KEY!,
  "content-type": "application/json",
};

// upsert on (organization, slug) → stage the bundle → activate it
const app = await fetch(`${api}/v1/app-links`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    slug: "quarterly-dashboard",
    name: "Quarterly dashboard",
  }),
}).then((r) => r.json());

await fetch(`${api}/v1/app-links/${app.id}/bundle`, {
  method: "PUT",
  headers,
  body: JSON.stringify({
    files: { "index.html": renderDashboard(rows) },
    start: "npx --yes serve -l 3000 .",
    port: 3000,
  }),
});

await fetch(`${api}/v1/app-links/${app.id}/publish`, {
  method: "POST",
  headers,
});
```

Publishing needs the narrow `org.app_links.publish` permission, which a run's default credential carries — a workflow does **not** need an organization-wide write key to publish. That credential can create a link and republish its bundle, name, description, and environment, but it cannot change how an existing link is exposed or what it may spend: visibility, spend cap, wake rate limit, and sandbox class are refused. Change those yourself with `PATCH /v1/app-links/{id}` using a key that carries `org.write`.

### Republish in place

Publishing to a slug you already own **replaces the app at the same URL**. That is how you ship an update: the link you shared last week keeps working and starts serving the new bundle on its next wake. Identity is the `(organization, slug)` pair, so a link is only ever replaced deliberately — nothing republishes as a side effect of an unrelated deploy.

## Who can open it

**Organization (default)**

Only logged-in members of the organization that owns the app can open it. A visitor who is not signed in is sent to log in first, and one who is signed in but not a member does not get through.
**Public**

Anyone with the link can open it — and **your organization pays for every wake they cause.** Because of that, going public is not a single flag:

- `visibility: "public"` must be accompanied by an explicit confirmation (`confirmPublic: true`) — a deliberate acknowledgement, not a default.
- A **daily spend cap** (`dailySpendCapUsd`) is required. When the cap is reached, further wakes are refused, the app **flips back to organization-scoped**, and the owner is notified.
- A per-app wake rate limit applies (10 wakes/hour by default).

## Bundles

- **Text only.** UTF-8 files — HTML, CSS, JS, JSON, TypeScript. Images, fonts, and archives are rejected at publish rather than silently corrupted. Inline small assets as SVG or data URLs, or fetch them from a CDN at runtime.
- **Self-contained.** `start` has to work in a fresh sandbox. Use the optional `build` command (for example `npm install`) for dependencies — it runs on **every wake**, so keep it quick.
- **Environment variables** are set on the app itself (the `env` map on `sapiom_app_publish`, or on `POST /v1/app-links`), injected into the process at wake, and stored encrypted — only the key names are ever read back. Setting `env` again replaces the whole map.
- **No durable state inside the app.** Every wake is a fresh sandbox from the bundle, so anything written to its filesystem or held in memory is gone. Apps that need to remember something should use a [database](/capabilities/data).

## Webhooks

An App Link can also receive webhooks, which is what makes a Slack bot or a callback receiver practical on a sandbox that is usually asleep. Enable `webhooksEnabled` on the app, and everything under the link's `/hook/` path is forwarded to it:

```
https://apps.sapiom.ai/{your-org}/{your-app}/hook/slack/events
```

- The routing prefix is **stripped** — the app above sees `/slack/events`.
- Bodies are forwarded **byte-exact**, so signature verification inside your app works (Slack, Stripe, and GitHub all sign the raw body). Body cap: 1 MB.
- A request that arrives while the app is asleep is **held** while it wakes, up to 60 seconds, then forwarded.
- Slack URL-verification challenges are answered without waking anything, so registering the endpoint always succeeds.

> **Note: Cold starts and provider retries.**
> Whether this is seamless depends on the caller. Providers that retry — Slack
> events, Stripe — absorb a cold start for free: the first delivery times out
> while the wake continues, and the retry lands on a warm app. Callers that do
> not retry, like GitHub webhooks, will simply see the timeout. A Slack slash
> command against a cold app also times out visibly the first time.
>
> These endpoints are reachable by anyone who knows the URL, exactly like any
> other webhook receiver — verify signatures in your app.

## What App Links are not

- **Not always-on hosting.** Cold starts of tens of seconds are the design, not a bug.
- **Not a reverse proxy.** The link redirects; it does not forward sub-paths. See [What the URL does](#what-the-url-does).
- **Not a place for stateful apps.** Each wake redeploys from the bundle; use a database for anything that must persist.
- **Not for binary assets.** Bundles are UTF-8 text.
- **Not custom domains.** Apps are served under `apps.sapiom.ai`.

> **Note.**
> An App Link itself is free to hold. You pay for the sandbox time its wakes consume, billed to the owning organization like any other compute. See the [capability catalog](/capabilities) for current rates.
