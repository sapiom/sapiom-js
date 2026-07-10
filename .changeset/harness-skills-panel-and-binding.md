---
"@sapiom/harness": patch
---

Fix the Skills panel and stale workflow bindings.

- Skills panel: the package-skill scan now resolves `@sapiom/agent-core` via
  Node's module search list, so bundled Sapiom skills (e.g. sapiom-agent-authoring)
  appear under any install layout — previously `npx @sapiom/harness` hoisted the
  packages into a shared `node_modules` and the scan (which only looked in the
  harness package's own nested `node_modules`) found nothing.
- The panel now lists only Sapiom package skills by default; a developer's
  personal `~/.claude/skills` are opt-in (`showUserSkills`) so they don't clutter
  the product's skill list.
- Sessions now drop a persisted workflow binding that points outside their own
  workspace on load, so the canvas never renders a stale workflow left over from
  an earlier session in a different directory.
