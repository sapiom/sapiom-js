---
"@sapiom/agent-core": minor
---

Deploy by uploading a source archive instead of pushing to git.

`deploy()` now packs the agent's raw source into a gzipped tar, uploads it, and
builds the exact digest the server computed. No git repository, no push
credential handed to the client, and no force-push erasing history — and
`DeployOptions.message` finally lets a version carry a real label instead of the
hardcoded `deploy` every push produced.

Transport selection is **server-driven**: the archive path is tried first, and a
409 from the upload route (the engine's own switch being off) is the one signal
that falls back to the git push. A client-side toggle would be a second source of
truth able to disagree with the engine. `DeployOptions.transport` pins one path
for tests or a rollback.

Two properties of the old path are deliberately preserved, because losing either
would change what customers actually run: dependency versions are still pinned
from the author's installed tree rather than shipped as ranges, and the archive
contains exactly the files the entry reaches — read from esbuild's metafile, not
a directory sweep.

`packSource` refuses source that imports from outside the agent's own directory.
esbuild inlined those files for the push path; a raw archive cannot, because
relative imports must still resolve after extraction. It fails with
`UNSUPPORTED_LAYOUT` rather than building an agent whose shared code is missing.

Adds `createTarGz` — a minimal ustar writer, hand-rolled so a published SDK gains
no dependency and does not shell out to a `tar` binary Windows lacks.
