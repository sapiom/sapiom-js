---
"@sapiom/harness-desktop": minor
---

Ship the current Agent Studio experience on the stable desktop channel again, by
removing the temporary `@sapiom/harness@0.8.9` pin. The app now bundles the
workspace Harness, so the Project rail rebuild and the dependency graph reach
stable users for the first time.

**Correcting the record for 0.3.8.** That release's changelog claims
`@sapiom/harness@0.10.0`, and it did not ship it. The entry was generated from the
workspace dependency graph, which could not see the `pnpm` override pinning the
desktop app to `0.8.9` — so `0.3.8` carried the same Agent Studio SPA as `0.3.7`
despite what its notes said. Nothing was wrong with the build; the pin was
deliberate (see `0.3.7`) and only its removal was missed. This release is the one
that actually delivers the newer Studio.

**Rows you had may disappear on upgrade, and no files are touched.** The rail now
derives its project list from one rule: a project is a directory you chose that
holds agents. Remembered folders that were an agent's own directory, and folders
known only because a session once ran there, stop being drawn. On one real install
this cut 42 project rows to 3 with all 89 agents still visible. Nothing is
deleted — any folder is one **Add a project** away from coming back.
