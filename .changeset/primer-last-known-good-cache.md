---
"@sapiom/mcp": minor
---

Serve the authoring primer live → last-known-good → bundled, and stop pinning the bundled copy
to the backend by digest (SAP-3579).

- **Last-known-good cache.** After every successful `GET /v1/mcp/instructions`, the body and
  its `X-Sapiom-Content-Release` / `-Digest` / `-Key` stamp are written next to
  `~/.sapiom/credentials.json`, one file per `apiURL` so production and staging never overwrite
  each other. Written atomically (temp file + rename). When the live fetch fails, that copy is
  served before the compiled-in snapshot; a missing, unreadable or corrupt cache is ignored.
- **Generated snapshot.** The compiled-in fallback is now `instructions.generated.ts`, written
  by `scripts/mcp-instructions-snapshot.mjs` from the served endpoint together with the release
  and digest it was taken from. `instructions.ts` re-exports it, so `AUTHORING_INSTRUCTIONS`
  keeps working; `AUTHORING_INSTRUCTIONS_RELEASE` and `AUTHORING_INSTRUCTIONS_DIGEST` are new.
  Regenerating it is a release step (see `PUBLISHING.md`); nothing fetches the network at
  install or publish time.
- **Startup provenance.** One line on stderr at server start names the source being served,
  its release and its digest prefix, e.g.
  `sapiom-dev: authoring primer source=cached release=2.14 digest=055076ab6773`. stdout stays
  the MCP transport.
- **Digest pin retired.** The test that froze a sha-256 of the bundled body against the
  backend's current content release is gone, replaced by a self-consistency check
  (sha-256 of the generated body equals the digest the generator stamped beside it). A backend
  content release no longer needs a paired sapiom-js PR to keep this package green; the
  backend's matching `SAPIOM_JS_FALLBACK_DIGEST` pin is removed in sapiom/Sapiom separately.
