# Vertical Slices: New-session file uploads

1. **Tracer bullet — one file reaches the first request.** Add the minimal queue contract and attachment row/button, wire one path-backed file through `NewSessionComposer` → `App` → the existing readiness hold, and prove in the mock browser that the agent's first request contains the path while the project name still comes from typed text.
2. **Real happy path — every ingest surface and clipboard fallback.** Implement picker, Finder-style drop, composer-scoped file paste, path resolution, pathless-file conversion, the local materialization endpoint/client, and mixed-attachment ordering; prove path-backed and clipboard-only files arrive together while text-only paste stays native.
3. **Safety and recovery — never lose context or send a partial request.** Add decoded/aggregate size validation, rate limiting, safe server-owned filenames, cwd confinement, queue deduplication/removal, submit locking, and provisional-session rollback; prove failures retain the queue and send no prompt.
4. **Proof and polish — shippable across Studio hosts.** Finish tokenized drag/queued/busy/responsive states and ARIA behavior, add the changeset, run focused-to-full unit/integration/Playwright/desktop checks, package and smoke the macOS app, manually exercise the real Finder/paste flow, and record Linux/Windows evidence boundaries.

Every slice ends with a running UI path and its own focused automated proof. Existing `Terminal.tsx` and `terminal-drop.ts` remain unchanged through all four slices, and their regression tests run before completion.
