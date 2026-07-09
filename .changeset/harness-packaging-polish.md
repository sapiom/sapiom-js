---
"@sapiom/harness": patch
---

Packaging polish: LICENSE file, explicit exports map, and pack-contents audit.

Adds a per-package LICENSE file (MIT, matching repo root) so published tarballs include it. Adds an explicit `exports` map with a main entry (`"."`) and `"./package.json"` sub-path — the latter is required by `@sapiom/cli`'s `createRequire().resolve('@sapiom/harness/package.json')` resolution path; without it a conditional-exports package would fire `ERR_PACKAGE_PATH_NOT_EXPORTED` and break `sapiom dev`. Updates `files` to include `LICENSE`, `CHANGELOG.md`, and `README.md` alongside `dist`. Excludes `src/test-setup.ts` from the build tsconfig so `dist/test-setup.*` no longer appears in the published tarball. Stays ESM-only (`"type": "module"`) — the harness is an app-style bin package, not a library; a dual CJS+ESM build would introduce the dual-package hazard for the typed error hierarchy (`instanceof` dispatch) with no user benefit.
