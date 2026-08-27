---
"@sapiom/mcp": minor
---

New tool `sapiom_dev_app_publish` — publishes the project's `sapiom.json`
sandbox resource as an **App Link**: a durable
`https://apps.sapiom.ai/{org}/{slug}` URL that outlives any sandbox. Reads the
same resource `sapiom_dev_sandbox_preview` does (source dir, `start`, `port`,
optional `build`/`env`), collects the source as a text-only file map, and calls
the App Links REST API in order — `POST /v1/app-links` (upsert on slug) →
`PUT /v1/app-links/{id}/bundle` → `POST /v1/app-links/{id}/publish` — with the
cached `sapiom_authenticate` credential as `x-api-key`. Returns
`{ summary, url, appLinkId, bundleSha256, manifest }`.

- Bundles are validated locally, before any HTTP call: a non-UTF-8 file is
  rejected **by name**, and an over-cap bundle is measured exactly as the server
  measures it. A bad bundle costs neither an upload nor a half-finished link.
  Symlinks are skipped rather than followed, so a link out of the source tree
  can never publish what it points at.
- Backend wire codes map to actionable errors: `BUNDLE_BINARY_FILE` (names the
  file), `BUNDLE_TOO_LARGE` (quotes both sizes), `PUBLIC_CONFIRM_REQUIRED`,
  `PUBLIC_SPEND_CAP_REQUIRED`, `APP_LINK_MANAGEMENT_PERMISSION_REQUIRED`, 401
  (re-authenticate) and 403 (names the missing `org.app_links.publish`). Each
  error is step-aware about what it left behind: only a failure on the first
  call can say nothing was created — after that the link exists with no active
  bundle, and the error says to publish the same slug again to finish it.
- `sapiom_dev_sandbox_preview` now states in its description **and** on its
  result that the preview URL expires with the sandbox's `ttl`, and points at
  `sapiom_dev_app_publish` for a durable address — the agent reads that at the
  moment it is about to hand the URL over.
