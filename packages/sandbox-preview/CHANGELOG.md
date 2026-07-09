# @sapiom/sandbox-preview

## 0.1.2

### Patch Changes

- 41e9ecd: New package: the client flow for deploying a web-app preview to a Sapiom sandbox and getting a live URL.

  Reads the project's `sapiom.json` (`type: "sandbox"` resource), provisions the sandbox if needed, ships the code — either a local directory upload or a Sapiom git repository — and calls the server-side deploy op to build, start, and expose a public preview URL. Returns `{ name, url, status, logs }`; a non-`deployed` status carries the build/start log tail so a crash-on-boot is visible to fix and retry.

  Includes a zod-validated `sapiom.json` schema carrying a config version, so a malformed or hand-edited file fails with an actionable message rather than a confusing downstream error. Exposes `configureSandbox` (validate typed input and write the resource) and `checkSandboxes` (validate a project's sandbox resources without deploying) for building tooling on top.

- Updated dependencies [41e9ecd]
  - @sapiom/tools@0.17.2
