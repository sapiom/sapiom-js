# @sapiom/sandbox-preview

## 0.1.19

### Patch Changes

- Updated dependencies [db81e32]
- Updated dependencies [9165f18]
- Updated dependencies [6fb3273]
  - @sapiom/tools@0.33.0

## 0.1.18

### Patch Changes

- Updated dependencies [065c9ca]
  - @sapiom/tools@0.32.0

## 0.1.17

### Patch Changes

- Updated dependencies [d7d480a]
  - @sapiom/tools@0.31.0

## 0.1.16

### Patch Changes

- Updated dependencies [5a8eeea]
- Updated dependencies [5a8eeea]
  - @sapiom/tools@0.30.0

## 0.1.15

### Patch Changes

- Updated dependencies [04b7df5]
  - @sapiom/tools@0.29.0

## 0.1.14

### Patch Changes

- Updated dependencies [b768b18]
- Updated dependencies [beb0f6f]
  - @sapiom/tools@0.28.0

## 0.1.13

### Patch Changes

- Updated dependencies [2b133e2]
- Updated dependencies [beb3139]
  - @sapiom/tools@0.27.0

## 0.1.12

### Patch Changes

- Updated dependencies [cc1ac0c]
  - @sapiom/tools@0.26.0

## 0.1.11

### Patch Changes

- Updated dependencies [27a1079]
  - @sapiom/tools@0.25.0

## 0.1.10

### Patch Changes

- Updated dependencies [a1e0e4f]
  - @sapiom/tools@0.24.0

## 0.1.9

### Patch Changes

- Updated dependencies [55cde7f]
  - @sapiom/tools@0.23.0

## 0.1.8

### Patch Changes

- Updated dependencies [68d2352]
  - @sapiom/tools@0.22.0

## 0.1.7

### Patch Changes

- Updated dependencies [d00b9e3]
  - @sapiom/tools@0.21.0

## 0.1.6

### Patch Changes

- Updated dependencies [4cf0156]
  - @sapiom/tools@0.20.0

## 0.1.5

### Patch Changes

- Updated dependencies [e446a4a]
  - @sapiom/tools@0.19.0

## 0.1.4

### Patch Changes

- Updated dependencies [afc77e3]
  - @sapiom/tools@0.18.0

## 0.1.2

### Patch Changes

- 41e9ecd: New package: the client flow for deploying a web-app preview to a Sapiom sandbox and getting a live URL.

  Reads the project's `sapiom.json` (`type: "sandbox"` resource), provisions the sandbox if needed, ships the code — either a local directory upload or a Sapiom git repository — and calls the server-side deploy op to build, start, and expose a public preview URL. Returns `{ name, url, status, logs }`; a non-`deployed` status carries the build/start log tail so a crash-on-boot is visible to fix and retry.

  Includes a zod-validated `sapiom.json` schema carrying a config version, so a malformed or hand-edited file fails with an actionable message rather than a confusing downstream error. Exposes `configureSandbox` (validate typed input and write the resource) and `checkSandboxes` (validate a project's sandbox resources without deploying) for building tooling on top.

- Updated dependencies [41e9ecd]
  - @sapiom/tools@0.17.2
