---
"@sapiom/sandbox-preview": patch
"@sapiom/tools": patch
"@sapiom/mcp": patch
"@sapiom/agent-core": patch
---

Keep sandbox preview and App Link uploads inside the project directory. A sandbox `source.path` must now be a relative path that stays inside the project (a symlinked source folder must point inside it too); an absolute or escaping path fails with `SOURCE_OUTSIDE_PROJECT`, and `sapiom_dev_sandbox_configure` refuses it. Git-source previews no longer push dotfiles (`.env`, `.npmrc`, `.babelrc`, ...), matching upload mode. `Sandbox.uploadDir` now skips symlinks instead of uploading what they point at.
