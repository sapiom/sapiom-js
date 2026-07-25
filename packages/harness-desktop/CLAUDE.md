# harness-desktop — instructions for agents working in this package

Electron host for `@sapiom/harness`: `src/main/boot.ts` is a native mirror of the harness CLI's
`bin.ts` (doctor → agent install → auth → consent → workspace → `startServer` → window). It ships as
installers, not to npm.

**Harness-side rules — what a *feature* must do to work here — live in `../harness/CLAUDE.md`.**
This file is the other half: the OS, packaging, and toolchain differences you have to respect when
touching this package, and how to tell whether a change actually works on the OSes we ship.

## Know which platform you have actually proved

| OS | Role | Artifacts | node-pty |
| --- | --- | --- | --- |
| Linux | dev/proof platform | `AppImage`, `deb` | **prebuilt binary — never compiles** |
| **macOS** | **required deliverable** (signed + notarized) | `dmg`, `zip` (arm64 today) | compiled from source |
| Windows | in scope, lower priority | `nsis` `.exe` | compiled from source |

> **A green Linux build proves almost nothing about the other two.** Linux uses node-pty's prebuilt
> binary, so node-gyp never runs — which is exactly why Linux passed through every CI failure that
> macOS and Windows hit. Don't infer cross-platform health from it.

## Main-process code that survives all three OSes

- **Never build paths with string concatenation or `/`** — `path.join`. The PATH *separator* differs
  too: `;` on Windows, `:` elsewhere (`src/main/env.ts:50`).
- **npm's global bin layout differs**: shims land in `<prefix>` on Windows, `<prefix>/bin` on POSIX
  (`src/main/boot.ts:82`). The doctor's lookup follows suit — it shells `where` on Windows, `which`
  elsewhere (`harness/src/cli/doctor.ts:9`).
- **Executables aren't interchangeable**: `claude` vs `claude.cmd`. A shim must be a `.cmd` batch file
  on Windows, and `#!/bin/sh` + `chmod 0755` on POSIX (`src/main/runtime-shims.ts`).
- **Spawning a `.cmd`/`.bat` requires `shell: true`** — Node refuses otherwise (CVE-2024-27980), and
  `execFileSync` does no `PATHEXT` lookup, so a bare `pnpm` is `ENOENT` on Windows. Pattern:
  `shell: isWindows` (`scripts/pack.mjs:45`).
- **Keep the Electron-as-Node shim dir LAST on PATH.** It exists only for a machine with no Node at
  all. Putting it first hijacked `node` for the agent (which runs via `#!/usr/bin/env node`) and
  destabilized it and every subprocess it spawned (`src/main/env.ts:52`).
- **macOS `os.tmpdir()` is behind a symlink** (`/var/…` → `/private/var/…`). Any path that something
  else will later `realpath` must be canonicalized first (`scripts/pack.mjs:34`).
- **mac and Windows filesystems are case-insensitive** — never rely on case to distinguish files.
- **Paths contain spaces** (`C:\Program Files`, `/Users/x/My Drive`): prefer argv arrays over shell
  strings, and don't hand-quote.
- Use `os.homedir()` / `app.getPath("userData")`, never a literal `~` or `%USERPROFILE%`.

## Packaging pitfalls, per OS — each one cost a CI cycle

### All platforms

`pack.mjs` runs `pnpm deploy --prod --legacy` into a throwaway dir because electron-builder needs
every packed file under the app dir, then runs electron-builder there. That deploy materializes
node_modules with **relative** symlinks, which is why the deploy dir's *location* keeps breaking
things (see mac/Windows below). `asarUnpack: **/node_modules/**` is deliberate: subprocesses run as
plain Node with no asar support, so their whole import tree must exist on disk. `npmRebuild`
recompiles node-pty against the Electron ABI **on the packaging OS** — there is no cross-compiling
here, each OS builds on its own runner.

### macOS

- Canonicalize the tmpdir or electron-builder fails with `ENOENT .pnpm/node_modules/@sapiom/…`: it
  realpaths the dir, and a non-canonical base leaves the relative symlinks' `../` chains one level
  short.
- **Python 3.12+ removed `distutils`** (PEP 632) and node-gyp@9 imports it → the rebuild dies. CI
  pins Python 3.11.
- **Only arm64 is built today.** `macos-14` is Apple Silicon and electron-builder defaults to the
  host arch, so **Intel Macs get no artifact**. Add an `x64`/universal target before GA if Intel users
  are in scope.
- **Signing is credential-driven, not code-driven.** The CI wiring is done: add the five secrets and
  the next tag produces a signed + notarized `.dmg`; with no secrets the same job still produces a
  working unsigned build (a `::warning::` says so) rather than failing. That's why `notarize` is
  passed as `-c.mac.notarize=true` on the command line instead of being hardcoded in
  `electron-builder.yml`, and why `CSC_IDENTITY_AUTO_DISCOVERY` is `${{ secrets.CSC_LINK != '' }}` —
  left on without a cert, electron-builder grabs any keychain identity and half-signs.
  Secrets: `CSC_LINK` (base64 of the Developer ID `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- **You do not need a Mac to create the certificate.** Generate the CSR with openssl, upload it at
  developer.apple.com (Certificates → Developer ID Application), then bundle the `.cer` with the key
  into a `.p12`. On OpenSSL 3 add `-legacy` to `pkcs12 -export`, or macOS refuses the resulting file.
- An unsigned `.dmg` needs `xattr -dr com.apple.quarantine` before it opens — which is exactly what
  signing removes, and the reason a tester build is worth signing.

### Windows

- **The deploy dir must be on the same drive as the repo.** Relative paths can't span drive letters;
  runners check out to `D:` while `os.tmpdir()` is on `C:`, which corrupts symlink targets into
  `D:\…\harness-desktop\C:\Users\…` (`scripts/pack.mjs:35`).
- **Pinned to `windows-2022`.** `windows-latest` rolled to a Visual Studio 18 image that node-gyp's
  VS detection reports as "unknown version undefined" → no usable compiler.
- The `@electron/rebuild: ^3.7.0` override in `pnpm-workspace.yaml` is what gets a VS2022-aware
  node-gyp. **Do not instead override `node-gyp` itself** — that hung the rebuild on *every*
  platform.
- **`cmd.exe` does not strip single quotes.** A script doing `echo '{"type":"module"}' > pkg.json`
  writes literal quotes → invalid JSON → the packaged app dies at launch with
  `ERR_INVALID_PACKAGE_CONFIG`. Use `node -e "require('fs').writeFileSync(…)"`. This applies to
  **every workspace package's** build scripts, not just this one, because their output gets bundled.

### Linux

- Run the `.AppImage` directly. An extracted `squashfs-root/AppRun` won't run standalone (it needs
  `APPDIR`); use `APPIMAGE_EXTRACT_AND_RUN=1` in sandboxless environments.
- Inspect what actually shipped:
  `./sapiom-*.AppImage --appimage-extract 'resources/app.asar'` then `grep -a` it. The packaged
  bundle is the source of truth — not your `dist/`.
- Node 26 on a dev box breaks Electron's binary extraction and `electron-rebuild`; CI uses Node 22.

## CI

`.github/workflows/desktop-release.yml` — one job per OS (`ubuntu-latest`, `macos-14`,
`windows-2022`), `fail-fast: false`, Windows `continue-on-error` while Phase 6 is open. Tag
`harness-desktop-v*` builds all three and publishes a prerelease Release; `workflow_dispatch` builds
artifacts only (14-day retention). There is a **TEMP branch trigger on `ewan/feat/harness-desktop`
that must be removed before merge.** Keep the runner pins and the Python pin: each has a comment
explaining the failure it prevents — don't "modernize" them without reproducing that failure.

## Before claiming an OS works

Run the automated check first — it covers the packaging-specific layers and takes seconds:

```bash
HOME=$(mktemp -d) SAPIOM_TELEMETRY_DISABLED=1 \
  ./release/sapiom-*.AppImage --smoke     # or Sapiom.app/Contents/MacOS/Sapiom, win-unpacked/Sapiom.exe
```

`--smoke` (`src/main/smoke.ts`) boots the app and asserts the SPA is served from inside the asar, the
REST surface answers and rejects an untokened request, the setup window's preload bridge loaded,
node-pty loads under Electron's ABI and can spawn, and the plain-Node subprocess's imports exist on
disk. Exit code is the signal; CI runs it per OS after packaging. **Add a check here whenever you fix
a packaging bug** — that's what stops it recurring silently.

Then, for anything it can't cover (a real agent, a real workflow, a human flow):

- [ ] Tested the **packaged** artifact, not `pnpm dev` (dev mode also skips the consent prompt)
- [ ] App launches from a clean state (`mv ~/.sapiom/harness/settings.json` aside to re-arm onboarding)
- [ ] A terminal session opens — proves the node-pty rebuild and an executable `spawn-helper`
- [ ] A workflow runs / Canvas renders — proves the plain-Node subprocess against unpacked asar
- [ ] Quit leaves no orphaned `claude`/pty processes
- [ ] For a code change, confirmed it's *inside* the artifact (`--appimage-extract` + `grep -a`), since
      a stale `dist/` or `tsbuildinfo` can silently ship the old code
