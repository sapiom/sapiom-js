---
"@sapiom/mcp": minor
---

New tool `sapiom_dev_app_publish` — publishes the project's `sapiom.json`
sandbox resource as an **App Link**: a durable
`https://apps.sapiom.ai/{org}/{slug}` URL that outlives any sandbox. Reads the
same resource `sapiom_dev_sandbox_preview` does (source dir, `start`, `port`,
optional `build`/`env`), collects the source as a text-only file map, and calls
the backend publish API in order — `POST /v1/app-links` (upsert on slug) →
`PUT /v1/app-links/{id}/bundle` → `POST /v1/app-links/{id}/publish` — with the
cached `sapiom_authenticate` credential as `x-api-key`. Returns
`{ summary, url, appLinkId, bundleSha256, manifest }`.

- A non-UTF-8 file is rejected **by name**, locally, before any HTTP call, so a
  binary in the source dir never costs a round trip or a half-published link.
- Backend wire codes map to actionable errors: `BUNDLE_BINARY_FILE` (names the
  file), `BUNDLE_TOO_LARGE` (quotes both sizes), `PUBLIC_CONFIRM_REQUIRED`,
  `PUBLIC_SPEND_CAP_REQUIRED`, 401 (re-authenticate) and 403 (names the missing
  `org.app_links.publish`). Every one says nothing was published.
- `sapiom_dev_sandbox_preview` now states in its description **and** on its
  result that the preview URL expires with the sandbox's `ttl`, and points at
  `sapiom_dev_app_publish` for a durable address — the agent reads that at the
  moment it is about to hand the URL over.
