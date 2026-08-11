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
- **You cannot spawn an npm-installed agent by name on Windows.** node-pty uses `CreateProcess`, which
  does no `PATHEXT` lookup and cannot execute a `.cmd` at all — so a bare `claude` fails with
  `Cannot create process, error code: 2` while `doctor` reports it present (detection shells `where`,
  which *does* resolve PATHEXT). `harness/src/core/spawn-target.ts` resolves the shim instead. Three
  facts that cost a day between them:
  - npm installs **three** files — `claude.cmd`, `claude.ps1`, and an extensionless `claude` that is a
    POSIX sh script for Git Bash. Try PATHEXT variants **before** the literal name, or you find the sh
    script and refuse a perfectly good `.cmd`.
  - A shim's target is **not always a script**: Claude Code ships `bin\claude.exe`. Match on the
    structure (the quoted token on the line ending in `%*`) and let the filesystem decide, never on a
    `.js` extension.
  - Do **not** "fix" this by wrapping in `cmd.exe /d /s /c`. node-pty escapes `"` as `\"` for
    `CreateProcess`, but cmd only counts raw quotes, so one embedded quote desynchronises its parser
    and any `&`/`|` after it becomes a command separator — command injection, CVE-2024-27980's class,
    reachable on every session (codex passes `JSON.stringify(prompt)`). Resolve the target; don't shell.
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
- **A test harness is part of the system under test.** `smoke.sh` exported `HOME`/`USERPROFILE`/
  `APPDATA` from `mktemp -d`, which under git-bash is a POSIX path (`/tmp/…`) with no drive letter.
  Electron uses `APPDATA` to compute `userData`, so it died creating those directories *before logging
  existed* — an exit code and total silence on every channel, including a redirect. Six CI rounds went
  into diagnosing the app for a fault in the harness, while the developer's own machine (real env
  vars) launched fine the whole time. Every app-facing path now goes through `cygpath -w` (`native()`
  in smoke.sh). When CI and a real machine disagree, suspect the harness first.

## Packaging pitfalls, per OS — each one cost a CI cycle

### All platforms

**`pnpm dist` does NOT rebuild the workspace packages it bundles.** It runs *this* package's `build`
and then packs, and `pnpm deploy --prod` copies `@sapiom/harness`'s **`dist/`** — so a harness-side fix
you have not built is silently absent from the artifact, and the app runs the old code. This is not
hypothetical: two new smoke checks were written against fixed source, packaged, and both failed with
the exact pre-fix errors (`spawn ENOTDIR`, the leaked esbuild pin) because only the desktop package had
been rebuilt. Before packaging anything that depends on a harness change:
`pnpm --filter @sapiom/harness build`. When a check fails on an artifact and the source looks right,
verify the code is *in* the bundle before debugging the code (`grep -c <symbol> packages/harness/dist/...`).

`pack.mjs` runs `pnpm deploy --prod --legacy` into a throwaway dir because electron-builder needs
every packed file under the app dir, then runs electron-builder there. That deploy materializes
node_modules with **relative** symlinks, which is why the deploy dir's *location* keeps breaking
things (see mac/Windows below). `asarUnpack: **/node_modules/**` is deliberate: subprocesses run as
plain Node with no asar support, so their whole import tree must exist on disk. `npmRebuild`
recompiles node-pty against the Electron ABI **on the packaging OS** — there is no cross-compiling
here, each OS builds on its own runner.

**A dependency that execs a sidecar binary needs more than `asarUnpack`.** Unpacking puts the file on
disk but leaves every path `require.resolve` reports pointing at `app.asar`, and `spawn` — unlike
`fs` — is not patched, so it fails with `ENOTDIR`. This shipped in 0.1.0: deploying a workflow died
with `Failed to bundle the agent for deploy. (spawn ENOTDIR)` on macOS *and* Linux (Windows escaped it
only because we set `asar: false` there), because the harness runs agent-core's esbuild bundler
in-process. `configureEsbuildBinary()` (`env.ts`) points `ESBUILD_BINARY_PATH` at the unpacked twin —
**from `index.ts`'s first import**, via `esbuild-binary.ts`. That ordering is the whole fix: esbuild
snapshots the variable into a module-level constant when its own module is evaluated, so the first
attempt at this — setting it inside `boot()` — logged the correct path and changed nothing, because
`import … from "@sapiom/harness"` had already loaded agent-core → esbuild. `index.test.ts` pins the
import order and the `deploy-bundle` smoke check catches it packaged. node-pty is the same class of
problem solved a different way (its spawn-helper path comes from the module itself, already unpacked).
Any new dependency of this shape needs its own path hook or a child process.

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
  `scripts/mac-signing-secrets.sh` does all of that and sets the secrets; only an **Account Holder**
  can issue the certificate, and it must be bound to *our* CSR or the private key won't match it.
- **Notarization takes ~35 minutes on this account**, not the 5–15 Apple's docs suggest, and
  `notarytool submit --wait` blocks with no timeout of its own. Hence `timeout-minutes: 45` on the
  packaging step and **75 on the job** — the job cap must exceed the step cap, or the step timeout
  can never fire and the job dies first, taking the diagnostic with it. Three early runs were killed
  at 25–33 minutes; `notarytool history` later showed every one had come back **Accepted**. If a
  build appears to hang in signing, read that diagnostic before touching entitlements: the app was
  never the problem, the timeout was.
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

`.github/workflows/desktop-release.yml` — a `prepare` job (resolves version + channel, fails fast on
a tag that disagrees with `package.json`), then one build job per OS (`ubuntu-latest`, `macos-14`,
`windows-2022`), `fail-fast: false`, Windows `continue-on-error` while Phase 6 is open.
`workflow_dispatch` builds artifacts only (14-day retention). Keep the runner pins and the Python
pin: each has a comment explaining the failure it prevents — don't "modernize" them without
reproducing that failure.

Tag conventions, which drive everything downstream:

| Tag | Release | Channel | Who gets it |
| --- | --- | --- | --- |
| `harness-desktop-v1.2.3` | final | `latest` | everyone, and `/releases/latest/download/…` resolves |
| `harness-desktop-v1.2.3-beta.1` | pre-release | `beta` | only installs already following betas |

The tag **must** equal `package.json`'s version. `prepare` enforces it, because that field is what
names every artifact and what the app reports as its own version; a mismatch publishes a manifest
advertising a version no asset matches, and clients then re-offer the same update forever.

## Auto-update

`electron-updater` replaces the whole app, so an update also carries Electron and node-pty — not just
our JS. Policy lives in `src/main/update-policy.ts` (pure, unit-tested), wiring in
`src/main/updater.ts` (electron-facing, covered by `--smoke`). That split is required: `vitest.config.ts`
only tests modules that don't import `electron`.

Things that will bite you:

- **`import { autoUpdater } from "electron-updater"` does not work.** It's CommonJS and `autoUpdater`
  is a *getter*, invisible to `cjs-module-lexer`, so ESM link fails with
  `SyntaxError: Named export 'autoUpdater' not found`. Default-import and read the property — lazily,
  since the getter constructs a platform updater on first read.
- **Close the harness server before `quitAndInstall()`** — it can hand off to the NSIS installer
  before an async `before-quit` finishes, leaving live `claude` processes holding files the installer
  wants. `index.ts` exposes a memoized `shutdownServer()`; use it, don't add a second path.
- **…but check `isUpdaterActive()` FIRST.** Closing the server kills every agent session, and
  `quitAndInstall` is not guaranteed to quit: Squirrel.Mac refuses an update it can't verify (and the
  mac build is unsigned whenever `CSC_LINK` is absent), an extracted AppImage can't self-update, nor
  can a `.deb` with no usable package manager. Doing the irreversible half first meant the user lost
  their work *and* stayed on the old version, staring at a dead SPA. Refuse up front, and if the
  handoff still doesn't happen within `HANDOFF_GRACE_MS`, `app.relaunch()` rather than leave a hollow
  app. Clear `pending` on any failed apply, or the button wedges on "ready to install" forever.
- **macOS needs the `zip` target and a valid signature.** Squirrel.Mac cannot consume a `.dmg`, and
  `latest-mac.yml` is only written when a zip target exists. It also refuses to apply an unsigned
  update — so auto-update on macOS depends on the Developer ID cert, not just on this code.
- **The `publish:` block in `electron-builder.yml` is load-bearing even though we never publish from
  electron-builder** (`pack.mjs` passes `--publish never` so it can't race the release job). Without a
  publish provider, no `latest*.yml` is generated and no `resources/app-update.yml` is baked in — the
  app then runs perfectly and never updates. The `update-config` smoke check exists for that, and it
  also cross-checks the *baked* channel against the one the app resolves at runtime.
- **Don't derive the channel in a workflow.** `pack.mjs` imports `resolveUpdateChannel` from the built
  `dist/` and passes the flag itself, so the release workflow, the PR smoke job and a local
  `pnpm dist` cannot disagree.
- **Artifact globs must include `latest*.yml` / `beta*.yml` / `*.blockmap`** (and macOS `*.zip`).
  They're `latest*`/`beta*` rather than `*.yml` on purpose — `builder-debug.yml` also lands in
  `release/`. Drop these and the metadata is built and then thrown away.
- A build **before** this feature cannot update *to* anything: only installs from the first
  auto-update-capable release onward will ever update themselves.

Dev loop without cutting tags: `SAPIOM_FORCE_UPDATER=1` runs the updater from an unpackaged build
against a hand-written `dev-app-update.yml`. `SAPIOM_UPDATE_CHANNEL=latest|beta` repoints one machine;
`SAPIOM_DISABLE_UPDATER=1` turns it off. A smoke run ignores the force flag — CI must never depend on
the network.

### The "Check for updates" button, and the main-window preload

There are two ways an update reaches the user, and they are not interchangeable:

- **Scheduled** (30 s after boot, then every 4 h) → silent, and only ever surfaces the
  main-process-owned update window (`update-window.ts`, our bundled `update.html` — never remote or
  agent content). It stays main-process-owned because it fires whenever a background download
  finishes and must work regardless of what the main window is showing; its "Restart / Later / Skip
  this version" answers ride two IPC channels sender-gated to that exact window.
- **On demand** → the profile menu's "Check for updates" item, via
  `window.sapiomDesktop.checkForUpdates()`. Note WHICH menu: the rail's profile drawer has a
  Disconnect button and so does the Settings popover one level deeper — the item belongs in the
  drawer, which is what users mean by "where Disconnect is". It
  differs in three ways that each matter: it *reports* an outcome (a button that appears to do
  nothing is broken), it clears the per-run "Later" set (asking is undeclining), and it answers
  `downloaded` for an update already on disk instead of the true-but-useless "up to date".

A third surface rides the second: the rail's **"Update now" card** (`UpdateCard` in the SPA).
`updater.ts` pushes `UPDATE_STATE` (receive-only, `onUpdateState` on the bridge) when a download
finishes, when a failed apply clears `pending`, and on every `did-finish-load` — the card mirrors
`pending` and survives a page reload because of that re-send. Its click is just
`checkForUpdates()`: the pending branch re-raises the update window, so the card adds **no**
install channel and the no-apply-channel rule below is untouched. A version the user chose "Skip
this version" for never raises the card (and clears a staged auto-install), and choosing skip
retracts an already-shown card — the card mirrors `pending`, and skip empties it.

The main window carries a preload (`src/preload/desktop.mts`) — it did not before. Watch out for:

- **The SPA is not ours alone.** The identical bundle is served to a plain browser by
  `npx @sapiom/harness`. Everything exposed here must be feature-detected on the SPA side
  (`harness/web/src/lib/desktop.ts`), and the contract is *mirrored* there, not imported: the
  dependency runs desktop → harness, never back.
- **`sandbox: false` is required**, as for the setup window — Electron will not load an ESM preload
  in a sandboxed renderer. `contextIsolation` stays on; the page never gets `ipcRenderer`.
- **Never `{ action: "allow" }` a window from the main window.** An allowed child window INHERITS the
  parent's `webPreferences`, preload included — and "local" is not "ours": the harness serves
  agent-authored files at `/canvas/:sessionId/*` on the same origin, and xterm linkifies whatever the
  agent prints. That made an agent-printed URL one click from a window holding `restartToUpdate()`,
  i.e. an agent could kill every live session. Local pop-outs go through `createPreviewWindow`
  (no preload, `sandbox: true`), which is explicit rather than dependent on override-merge semantics.
- **There is no "apply the update" channel reachable from the main window, and there must not
  be.** A restart ends every running agent session, and page code shares an origin with
  agent-authored files. The confirmation lives in the separate update window (whose own two
  channels are gated on the sender being exactly that window's `webContents`); an on-demand check
  with something already downloaded re-raises it. The
  `desktop-bridge` smoke check asserts the bridge exposes NOTHING beyond `appVersion`,
  `checkForUpdates`, `chooseDirectory` (the read-only native folder picker behind the SPA's
  Browse button — it returns only a path and opens no file), and the two receive-only
  subscriptions `onDeepLink` / `onUpdateState` (main → renderer pushes; nothing to invoke), so a
  future addition has to be deliberate.
- **Validate the IPC sender.** `isTrustedSender` (`trusted-sender.ts`, shared by the updater and the
  folder-picker channels) requires the main window's `webContents` *and* a top frame at `/`, because
  the main window could itself navigate to agent content on the same origin. It reads the window set
  once at boot by `index.ts` via `setTrustedWindow`, so it works even in a build with updates disabled
  — deriving it from the updater's `active` state once made a disabled build reject every sender and
  report "not available here" instead of the real reason.
- **The app version reaches the preload via `webPreferences.additionalArguments`**, not `process.env`.
  Setting env in main and reading it in a renderer depends on inheriting a variable mutated after
  startup. The `desktop-bridge` smoke check fails on an empty `appVersion` precisely so this stays
  honest.
- **Register `ipcMain` handlers regardless of the updater gate, and before any early return.**
  `ipcRenderer.invoke` on an unhandled channel *rejects*, so a build with updates off must still
  answer (with `{kind:"disabled"}`) rather than throw at the renderer. This was wrong once: `index.ts`
  returned in `--smoke` before `initUpdater`, and the packaged check failed with
  `No handler registered for 'update:check'` against an app that worked fine in production. Handler
  registration must not depend on which branch of boot we exit through.
- The `desktop-bridge` check **invokes** the channel, it doesn't just look for the function. Shape
  alone would pass with no handler registered — and the only place that shows up otherwise is a user
  clicking the button.

## What the app installs for the user

Three shims (`runtime-shims.ts`, PATH-prepended) plus two npm installs into
`userData/npm-global` (`agent-install.ts`, on PATH via `agentBinDir()`):

| Provided | Why |
| --- | --- |
| `node`, `npm`, **`npx`** shims | Electron bundles Node but not npm, and the machine may have neither |
| Claude Code (if no agent on PATH) | the app is useless without an agent |
| `@sapiom/cli` (if `sapiom` not on PATH) | macros and templates hand the agent `sapiom agents …` |

`npx` and the CLI were both missing until they were added together, and both failed
**silently**: the per-session MCP config launches the sapiom-dev server with
`command: "npx"`, so a Node-less machine simply got no Sapiom tools, and the agent
that was told to run `sapiom agents deploy` got `command not found` and improvised.
Neither showed up as an error anywhere. If you add a door that shells out to a
binary, it belongs in this table or in the doctor — the direct in-app actions
(Deploy, Local Run) need none of it, which is why the gap survived so long.

The CLI install is gated by `install-policy.ts`: never in `--smoke` (CI must not
depend on the network), never in dev, and never when the user already has their own
`sapiom` — that last one is also what makes it one-shot rather than once-per-launch,
since the prefix is on PATH by the time the check runs.

> `userData` is `$XDG_CONFIG_HOME/@sapiom/harness-desktop` on Linux (and
> `~/Library/Application Support/@sapiom/harness-desktop` on macOS) — `app.getName()`
> falls back to the *scoped npm name*, so the scope becomes a directory. It works,
> but it litters, and changing it later orphans everything installed above. Decide
> before wide release, not after.

## Before claiming an OS works

Run the automated check first — it covers the packaging-specific layers and takes seconds:

```bash
HOME=$(mktemp -d) SAPIOM_TELEMETRY_DISABLED=1 \
  ./release/sapiom-*.AppImage --smoke     # or Sapiom.app/Contents/MacOS/Sapiom, win-unpacked/Sapiom.exe
```

`--smoke` (`src/main/smoke.ts`) boots the app and asserts the SPA is served from inside the asar, the
REST surface answers and rejects an untokened request, a real session spawns, the setup window's
preload bridge loaded and that window resolved its design-system layer in the Studio brand (tokens, the
`themes/studio.css` preset and its nested agent-cloud import), node-pty loads under Electron's ABI and
can spawn, the plain-Node subprocess's
imports exist on disk, a deploy can bundle and a local run's child really starts (both spawn-from-asar
bugs — see below), the agent inherits a clean environment, and the auto-update config is baked in. Exit
code is the signal; CI runs it per OS after packaging.

Two properties of the harness itself, learned the hard way:

- **A check that cannot run must FAIL, not pass.** `--smoke` used to `app.quit()` — exit **0** — when it
  lost the single-instance lock, so a stale app on the machine turned the packaging gate into a green
  light over zero checks. `single-instance.ts` makes that a loud exit 1.
- **Assert on what the child received, not on what the parent meant to send.** The esbuild-pin leak into
  every agent process was invisible to every parent-side test; it took having the stub agent dump its own
  environment (`SAPIOM_SMOKE_AGENT_ENV` in `scripts/smoke.sh`) for a check to see it. **Add a check here whenever you fix a packaging bug** — that's what stops it
recurring silently.

Then, for anything it can't cover (a real agent, a real workflow, a human flow):

- [ ] Tested the **packaged** artifact, not `pnpm dev` (dev mode also skips the consent prompt)
- [ ] App launches from a clean state (`mv ~/.sapiom/harness/settings.json` aside to re-arm onboarding)
- [ ] A terminal session opens — proves the node-pty rebuild and an executable `spawn-helper`
- [ ] A workflow runs / Canvas renders — proves the plain-Node subprocess against unpacked asar
- [ ] Quit leaves no orphaned `claude`/pty processes
- [ ] For a code change, confirmed it's *inside* the artifact (`--appimage-extract` + `grep -a`), since
      a stale `dist/` or `tsbuildinfo` can silently ship the old code
