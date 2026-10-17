---
"@sapiom/agent-core": patch
---

Fix invalid `file://` URL on Windows when dynamically importing a bundled
agent

`check` and `local/load` both bundle an agent to a temp file, then
`import()` it via a hand-built `` `file://${bundlePath}?t=${Date.now()}` ``
template. `path.join`/esbuild's output path use the platform's own
separator, so on Windows this produced an invalid URL (backslashes, and a
missing leading `/` before the drive letter), breaking `sapiom check` and
`sapiom run` for every Windows user.

Both call sites now build the URL with `pathToFileURL` (via a new shared
`bundleFileUrl` helper), which percent-encodes the path and handles both
platforms correctly. This also fixes the same class of bug for any
POSIX path containing characters a raw template leaves unencoded (e.g.
spaces), which the added regression tests cover directly.
