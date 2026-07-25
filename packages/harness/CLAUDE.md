# Harness — instructions for agents working in this package

## Intent: the desktop app is the surface users get

The harness has **two hosts over one server**:

| Host | Entry | Audience |
| --- | --- | --- |
| `npx @sapiom/harness` (CLI) | `src/cli/bin.ts` | developers; the unchanged backup path |
| **`@sapiom/harness-desktop`** (Electron) | `packages/harness-desktop/src/main/boot.ts` | **non-technical users — the shipping deliverable** (signed/notarized `.dmg`) |

`boot.ts` is a *native mirror* of `bin.ts`: same `startServer()`, same setup helpers, no fork.
A feature that only works under `npx` is **not done** — it has to work in the Electron host too,
because that host is what we ship. Nothing here asks you to write Electron code: it asks you to
keep harness features host-agnostic, and to know which habits break inside Electron.

**If you change setup-time behavior, change both hosts in the same commit.**

## Why a harness feature breaks in Electron (each one is a bug we shipped)

### 1. There is no TTY — and the UI reads the *file*, not your variable

No prompts, no `process.stdin.isTTY`, no `console.log` a user will ever see. Setup-time input must
be a `HarnessServerOptions` field the host supplies (`telemetryOptIn`, `consentSource`, `firstRun`,
`launchDir`, `availableHarnesses`, …), and the helper that *persists* it must be exported from
`src/index.ts` so a native host can persist it the way `ensureConsent` does for the CLI.

Persisting is the half that gets forgotten. `GET /api/state` and `GET /api/settings` re-read
`settings.json` — the SPA never sees the in-memory option. When a native host prompted for telemetry
consent and only passed the answer to `startServer`, telemetry ran **on** while the UI displayed
"analytics off", and the answer was dropped from the next launch (fixed in `86393cb`). If a value has
both a live and a persisted representation, wire them together (`onTelemetryOptInChange` is the
reconciler for the live emitter) and make the UI and the next boot read the same store.

`ensureConsent`/`printDoctorReport` are deliberately **not** exported: they are TTY-shaped. Don't add
callers of that shape to code the server reaches.

### 2. Your files may be inside `app.asar`

Packaged, this package lives in an archive. `require.resolve` / `import.meta.url` hand back a *virtual*
path: `readFile` works (Electron patches fs), but `cpSync`, `opendir`, a child process `cwd`, and
`chmod +x` all fail — `ENOTDIR` is the usual symptom. Translate to the unpacked twin, as
`core/example-seed.ts:50` and `core/canvas-manifest-check.ts:43` already do:

```ts
dir.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
```

Any **new** code that resolves a path relative to this package (templates, fixtures, scaffolds,
binaries) needs that translation, or the file has to be covered by
`packages/harness-desktop/electron-builder.yml`'s `asarUnpack`.

### 3. `process.execPath` is Electron, not `node`

Spawning "node" means spawning the Electron binary. It only behaves like Node with
`ELECTRON_RUN_AS_NODE: "1"`, and that subprocess is **plain Node with no asar support** — so
everything it imports must exist unpacked on disk (this is why `asarUnpack` is `**/node_modules/**`).
Guard on `process.versions.electron` so the CLI path stays untouched; see
`core/canvas-manifest-check.ts:99`.

### 4. `npm`, `npx`, and PATH are not there

A GUI app inherits the desktop session's environment, not your shell's — no `nvm`, no
`~/.local/bin`, and Electron ships Node **without npm**. Never shell out to `npm`/`npx`, and never
assume a tool is on PATH. The desktop host bundles npm, installs the agent into a per-user prefix,
writes `node`/`npm` shims, and augments PATH (`harness-desktop/src/main/{agent-install,runtime-shims,env}.ts`)
— but only for things that go through it. A new `npx some-tool` inside the harness is a crash on a
user's machine.

### 5. Options are consumed before the socket binds

`ingestUrl` is built from the *requested* `options.port` (`src/server/index.ts:472`), so a host
passing `port: 0` bakes `http://127.0.0.1:0/ingest` into the agent's env; its `SessionStart` hook
POSTs into the void and the session never reaches `ready` — the UI accepts terminal typing but
refuses every programmatic inject. If you derive anything from the port, derive it **after** listen.

### 6. The design-system seam is shared with the desktop onboarding window

The SPA resolves `@sapiom/design-system` through a build seam (`web/vite.config.ts`,
`designSystemAlias()`): the private branded package when it's installed, else the committed
`web/src/styles/ds-neutral` token set — this repo is public, so a clone with no private assets must
still build and render. `harness-desktop/scripts/copy-renderer.mjs` runs the **same probe** and copies
the resolved `tokens.css` / `themes/agent-cloud.css` into the Electron setup window as
`ds-tokens.css` / `ds-agent-cloud.css` (that window has no bundler — `setup.html` links plain
stylesheets — so a copy replaces the alias). Change the probe or the file layout in one and you must
change the other; nothing else fails first.

- Never redefine a design-system token. Read tokens with `var()`; a local snapshot of token VALUES
  drifts the moment a token changes, which is exactly what the seam exists to prevent.
- `--accent` is the system's hover WASH, not the product accent. `styles.css` remaps it in its bridge;
  anything that doesn't load `styles.css` (i.e. the onboarding window) must say `--brand`.
- App-specific styling → `styles.css`. Onboarding-window styling → `harness-desktop`'s `setup.css`,
  which addresses system tokens directly since it can't load the SPA's bridge.
- Dark mode keys on `[data-theme="dark"]`, not `prefers-color-scheme` alone — the onboarding window
  sets the attribute itself before first paint.
- Compose stylesheets through JS imports in `web/src/main.tsx`, not CSS `@import` (an `@import`
  triggers a stricter re-parse that chokes on our CSS nesting).

### 7. Packaging trips over host differences

Package scripts run under `cmd.exe` on Windows, which does not strip single quotes — `echo '{"type":"module"}'`
writes invalid JSON and the app dies on launch with `ERR_INVALID_PACKAGE_CONFIG`. Use
`node -e "…writeFileSync…"`. Adding a native dependency, or a runtime that must exist on disk, means
updating `electron-builder.yml`.

## Checklist: adding setup-time behavior

- [ ] Value arrives as a `HarnessServerOptions` field, with a default that keeps the CLI unchanged
- [ ] Any persistence helper the host needs is exported from `src/index.ts` (+ noted in the changeset)
- [ ] Both `src/cli/bin.ts` and `packages/harness-desktop/src/main/boot.ts` updated
- [ ] What the SPA displays is read from the same store the next launch resolves from
- [ ] No new TTY prompt, `npx`, PATH assumption, or package-relative path without asar translation

## Verifying the desktop app really behaves

Dev loop (from the repo root — never `cd`):

```bash
pnpm --filter @sapiom/harness build          # SPA + server; desktop consumes dist/
pnpm --filter @sapiom/harness-desktop dev    # Electron, dev mode (skips the consent prompt)
```

Packaged check — the only one that proves asar, native modules, and PATH:

```bash
pnpm --filter @sapiom/harness-desktop dist   # → packages/harness-desktop/release/
packages/harness-desktop/release/sapiom-*.AppImage --smoke   # automated layer checks, exits non-zero
packages/harness-desktop/release/sapiom-*.AppImage           # or launch it for real
```

`--smoke` asserts the layers a harness change can break from a distance — SPA served from inside the
asar, REST surface + boot-token gate, preload bridge, node-pty spawn, and the on-disk existence of
what the plain-Node Canvas subprocess imports. If your change adds something the packaged app must
resolve at runtime, add a check to `harness-desktop/src/main/smoke.ts`.

Simulate a genuine first run (state is **shared with the npx CLI** under `~/.sapiom` — back it up):

```bash
mv ~/.sapiom/harness/settings.json ~/.sapiom/harness/settings.json.bak   # re-arms onboarding
```

Then walk it: agent auto-install → sign-in → consent → workspace → SPA loads → open a terminal
session (proves the node-pty rebuild + executable spawn-helper) → run a workflow (proves the Canvas
subprocess) → quit and confirm no orphaned `claude`/pty processes. To inspect what actually shipped:
`./sapiom-*.AppImage --appimage-extract 'resources/app.asar'`, then `grep -a` it — the packaged
bundle is the source of truth, not your `dist/`.

## Also

- Don't write literal NUL (or other control) bytes into source files: grep and ripgrep classify the
  file as binary and skip it **silently**, which hid all 1177 lines of `src/server/index.ts` from
  every code search until `61c5ee8`. Use the escape.
- The server binds `127.0.0.1` only, and `/api` + WS upgrades are gated on the per-boot token. Keep
  new endpoints behind the same middleware.
- `~/.sapiom` is shared by both hosts on purpose: one identity, one session history, whether the user
  came in through the app or `npx`. Don't add a state location that only one host knows about.
