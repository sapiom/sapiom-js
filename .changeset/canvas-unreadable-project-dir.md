---
"@sapiom/agent-core": patch
---

Anchor esbuild to the agent project in `check()`, local runs, and `bundleForDeploy()` (`absWorkingDir`). Given no working directory esbuild adopts the caller's cwd and enumerates that cwd's ancestor chain in addition to the project's — so for the Studio Canvas, whose caller is the harness package buried inside the app, a directory nowhere near the user's agent could fail the build: reported as `Cannot read directory "../../../../../../../..": result too large` followed by `Could not resolve <project>/index.ts` on a project that was readable, installed, and passed `check` from a terminal (where cwd _is_ the project). Diagnostics become legible as a side effect — paths print relative to the working directory, so a project error reads `index.ts` instead of `../../../../../Users/me/agents/x/index.ts`.

Also report the real cause when a bundle fails because the project directory itself can't be read. `describeBundleFailure` probed only for a missing `node_modules`, which an unreadable or vanished project directory also answers — so a failure whose esbuild error was `Cannot read directory "…": permission denied` told the user to run `npm install` in a directory nothing could list. It now names the directory and the reason (permission denied, no longer exists, not a directory) and keeps the raw esbuild detail.
