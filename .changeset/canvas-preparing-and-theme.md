---
"@sapiom/harness": patch
---

Fix the Canvas showing a raw "Render failed" esbuild dump (`Could not resolve
"@sapiom/agent"` / `"zod/v4"`) on a freshly scaffolded agent, before its
`npm install` has run. Studio now shows a calm "Preparing your agent…"
placeholder while dependencies are missing and auto-renders the step graph the
moment they land — no Retry click. Readiness waits for the whole declared
dependency set (walking `node_modules` up the tree as esbuild does), so a
partial install can't flash the error. The Canvas empty-state and "rendering…"
pages are now theme-aware, matching the app's light/dark theme instead of always
painting a white panel.
