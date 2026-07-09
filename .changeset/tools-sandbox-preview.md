---
"@sapiom/tools": patch
---

Add sandbox preview primitives to the `sandbox` capability.

- `deployPreview({ source, build, start, port, env })` triggers the server-side deploy op and returns the live preview URL. `source` is either a local upload or a Sapiom git repository (`{ kind: 'git', repo, ref? }`), so an in-process caller with an existing repo can deploy in one call.
- `uploadDir(localDir, { ignore })` ships a local directory to the sandbox (ignore-aware walk), the companion to the upload source.
- Renames `createPreview` to `createPublicUrl` — the method exposes a sandbox port at a public URL and is not a 1:1 wrapper of any single provider's naming.
