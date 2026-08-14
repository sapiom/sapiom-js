# Status: New-session file uploads

- Gate 1 — Product: APPROVED 2026-08-14
- Gate 2 — Architecture: APPROVED 2026-08-14
- Gate 3 — Program Design: APPROVED 2026-08-14
- Gate 4 — Slice plan: APPROVED 2026-08-14

## Slices

- [x] Slice 1 — tracer bullet: one queued file travels from the create-new composer through session creation into the mock agent's first request.
- [x] Slice 2 — real happy path: picker, Finder-style drop, clipboard file/image, zero-copy paths, and local inline materialization work end to end.
- [x] Slice 3 — safety and recovery: validation, limits, path confinement, deduplication, removal, busy state, and rollback keep incomplete prompts from sending.
- [x] Slice 4 — proof and polish: accessibility/responsive states, cross-platform path cases, full regression suites, macOS packaged smoke, and release note.

## Notes for a fresh session

- Source request: Slack thread `C09SDAQS3T3`, parent `1786728554.835109`.
- Users can already give files to an agent from a live session, but the create-new screen has no corresponding interaction or QA coverage.
- Worktree: `/Users/ewan/projects/sapiom/sapiom-js-worktree-new-session-file-uploads`.
- Branch: `codex/new-session-file-uploads`, based on `origin/main` at `90d4fa7`.
- The current checkout at `/Users/ewan/projects/sapiom/sapiom-js` has unrelated user work and must not be modified.
- Gate 1 approved by the user on 2026-08-14.
- Gate 1 reopened on 2026-08-14 to add clipboard image/file paste requested during Gate 2 review; normal text paste must remain unchanged.
- Revised Gate 1, including clipboard attachments, approved by the user on 2026-08-14.
- Gate 2 approved by the user on 2026-08-14. Live-session terminal drag/drop and copy/paste are an explicit regression boundary and remain unchanged.
- Gate 3 approved by the user on 2026-08-14, including the macOS/Windows/Linux verification matrix.
- Gate 4 approved by the user on 2026-08-14.
- Slice 1 completed on 2026-08-14: production build, harness typecheck, 15 focused unit/regression tests, and the focused Chromium tracer test all pass.
- Slice 2 completed on 2026-08-14: path-backed files stay zero-copy; picker, drag/drop, pathless clipboard files, the boot-token local materialization client/route, mixed ordering, and ordinary text paste are wired end to end. Harness typecheck and production build pass; 83 focused unit/server regressions and all 10 create-new Chromium tests pass. `Terminal.tsx` and `terminal-drop.ts` remain unchanged.
- Slice 3 completed on 2026-08-14: 10 MiB per-file and 50 MiB aggregate inline limits, linear base64 validation, server-owned filenames, realpath/symlink confinement, 30/min client rate limiting, SHA-256 inline deduplication, removal, serialized queueing, synchronous submit locking, and provisional-session rollback are implemented. A failed materialization kills the blank session, retains the exact queue, sends no prompt, and retries cleanly. Full typecheck and production build pass; 100 focused unit/server regressions and all 13 create-new Chromium tests pass. Harness lint reports zero errors and one pre-existing warning from `origin/main`.
- Slice 4 completed on 2026-08-14: tokenized dragging/queued/busy states, live ARIA status, filename-safe analytics redaction, reduced motion, visible keyboard focus, and 44 px narrow-screen controls are implemented. Harness typecheck/build pass; 2,095 unit/integration tests, 4 performance tests, all 319 Chromium tests (including 15 create-new cases), and all 152 desktop tests pass. Lint has zero errors and the same pre-existing warning from `origin/main`.
- The unsigned macOS arm64 package builds under Node 22/Python 3.11 and its isolated packaged smoke reports 13 passed, 1 intentionally skipped Windows-only check. Packaged UI validation proved real Finder copy/paste, ordinary text paste, removal, and the exact zero-copy macOS path returned by `pathForFile`; a packaged DevTools probe also proved drag/drop and clipboard-file queueing for pathless files. The system picker itself is native OS UI and the ScreenCaptureKit driver could not snapshot its modal, so its product callback remains covered by Playwright rather than a recorded pointer interaction.
- macOS is the only packaged OS exercised locally. Fast tests cover explicit POSIX and Windows quoting/path cases; Linux and Windows packaged smoke remain evidence for their existing CI runners and must not be claimed until that CI runs on a pushed PR.
