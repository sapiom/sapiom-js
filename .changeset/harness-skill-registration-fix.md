---
"@sapiom/agent-core": patch
"@sapiom/harness": patch
---

Fix Sapiom skill registration in harness sessions. `@sapiom/agent-core` now
exposes its `package.json` through the `exports` map so consumers can resolve
its bundled `skills/` directory; previously `require.resolve` threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` and the skill silently never loaded. The harness
skill-plugin resolver also gains a fallback that locates the skills directory by
resolving the package's main entry when the `package.json` subpath isn't
exported. Skills register under the `sapiom` plugin namespace, so the
agent-authoring skill is available as `/sapiom:sapiom-agent-authoring`.
