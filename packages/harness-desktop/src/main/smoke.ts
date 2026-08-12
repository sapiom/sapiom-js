/**
 * `--smoke`: unattended verification that a **packaged** build actually runs.
 *
 * Why this exists: half the bugs this app has shipped were invisible to any
 * test that didn't launch the built artifact — asar path resolution, a native
 * module compiled against the wrong ABI, a dependency that wasn't unpacked, a
 * `package.json` mangled by cmd.exe quoting. CI built installers on three OSes
 * and never once launched them, so those only surfaced on a user's machine.
 *
 * The checks below are deliberately network-free, human-free and fast (a few
 * seconds), so they can run on every OS's runner right after packaging. Each
 * one maps to a real failure we've had:
 *
 *   http-spa        SPA is served from inside app.asar (express static + fs patch)
 *   host-terminology desktop title and CLI banner use the same product identity
 *   http-state      the REST surface answers with the boot token …
 *   http-authz      … and rejects a request without it
 *   preload-bridge  the setup window's preload actually loaded (an ESM/sandbox
 *                   mismatch once made onboarding hang forever with no error),
 *                   and that window resolved its design-system layer in the
 *                   STUDIO brand — that layer is a build-time COPY, so a path
 *                   regression silently reverts the first screen's entire look
 *                   (it shipped in the retired teal brand for months)
 *   node-pty        the native module loads under Electron's ABI and can spawn
 *                   (covers the rebuild AND the +x spawn-helper) — no agent needed
 *   unpacked-deps   what the plain-Node Canvas subprocess imports exists ON DISK,
 *                   not just inside the archive
 *   runtime-shims   node/npm/npx shims exist AND execute (npx was missing for the
 *                   app's whole life, silently breaking the sapiom-dev MCP server)
 *   run-local       POST /api/runs/local's child process really starts (its cwd,
 *                   its script path and ELECTRON_RUN_AS_NODE were all wrong, so
 *                   every local run answered `spawn ENOTDIR`)
 *   deploy-bundle   agent-core's in-process bundler can actually SPAWN esbuild's
 *                   native binary (a path inside app.asar gave `spawn ENOTDIR`,
 *                   so every deploy from the packaged app failed)
 *   desktop-bridge  the main window's preload exposed window.sapiomDesktop — the
 *                   SPA feature-detects it, so a broken preload just makes the
 *                   "Check for updates" button silently absent
 *   update-config   the auto-update metadata is baked in and electron-updater
 *                   loads — otherwise the app runs fine and never updates again
 *
 * Exit code is 0 only if every check passes; each result is printed as one line
 * so a CI log shows exactly which layer broke.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { app } from "electron";
import { AGENT_STUDIO_PRODUCT_NAME, resolveSpawnTarget } from "@sapiom/harness";
import { createSetupWindow } from "./windows.js";
import { resolveWebDir } from "./paths.js";
import { shimDir } from "./runtime-shims.js";
import { CHANNEL_ENV_VAR, resolveUpdateChannel } from "./update-policy.js";
import type { BootResult } from "./boot.js";

const require = createRequire(import.meta.url);

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** A path inside app.asar can't be read by a plain-Node child process; the
 *  packaged app unpacks node_modules, so translate to the on-disk twin. Same
 *  transformation the harness applies (see harness/src/core/example-seed.ts). */
function unpacked(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

async function check(name: string, fn: () => Promise<string>): Promise<SmokeCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** GET with the boot token, asserting status and (optionally) a body substring. */
async function fetchOk(url: string, token: string | null, expectStatus: number): Promise<string> {
  const res = await fetch(url, {
    headers: token ? { "X-Harness-Token": token } : {},
  });
  if (res.status !== expectStatus) {
    throw new Error(`${url} → ${res.status}, expected ${expectStatus}`);
  }
  return await res.text();
}

/**
 * The setup window is the pre-SPA onboarding UI, and its preload is the only
 * channel that renders progress or accepts the consent answer. When the preload
 * silently fails to load, boot LOOKS fine from the main process while the user
 * stares at a frozen window — so assert the bridge from inside the renderer.
 * Uses its own throwaway window: by the time boot() returns, the real setup
 * window has already been closed.
 */
async function checkPreloadBridge(): Promise<string> {
  const win = createSetupWindow();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("setup window did not finish loading in 15s")), 15_000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once("preload-error", (_e, _p, err) => {
        clearTimeout(timer);
        reject(new Error(`preload failed: ${err.message}`));
      });
    });
    const shape = (await win.webContents.executeJavaScript(
      "({ bridge: typeof window.sapiomSetup, onProgress: typeof window.sapiomSetup?.onProgress," +
        " submitConsent: typeof window.sapiomSetup?.submitConsent })",
    )) as { bridge: string; onProgress: string; submitConsent: string };
    if (shape.bridge !== "object") throw new Error("window.sapiomSetup is missing (preload did not run)");
    if (shape.onProgress !== "function" || shape.submitConsent !== "function") {
      throw new Error(`bridge incomplete: ${JSON.stringify(shape)}`);
    }

    // The token layer is COPIED in at build time (scripts/copy-renderer.mjs
    // resolves the design-system seam), so a packaging or path regression leaves
    // setup.css reading `var(--bg)`/`var(--brand)` against nothing — an
    // unstyled first-run window that every other check still passes. Assert the
    // tokens RESOLVE rather than that the files exist: a <link> that 404s and a
    // stylesheet that loaded but defined nothing fail identically here.
    //
    // Each probe names a token exactly ONE file defines, so nothing here
    // hardcodes a brand value — the design system owns those and this gate must
    // not pin them. Three layers, three independent silent failures:
    //   --bg           tokens.css loaded
    //   --type-display studio.css loaded AND its [data-product] scope matched,
    //                  i.e. the window is in the Studio brand and not the old
    //                  agent-cloud teal it silently shipped in for months
    //   --violet       agent-cloud.css loaded — reachable ONLY through
    //                  `@import "./agent-cloud.css"` inside themes/studio.css, so
    //                  this is the only check that themes/ was copied as a
    //                  directory rather than flattened. A failed CSS @import
    //                  throws nothing, anywhere.
    // Geist is REPORTED, not asserted: --font falls through to system-ui, so a
    // face the renderer refuses to fetch over file:// is a legible window, not a
    // broken one — and this line is how we learn, per OS, whether it fetches.
    const theme = (await win.webContents.executeJavaScript(
      "(async () => { const s = getComputedStyle(document.documentElement);" +
        " const faces = [...document.fonts].map((f) => f.family).join(',');" +
        " const geist = await document.fonts.load('600 1rem Geist').then((f) => f.length" +
        " ? 'loaded' : 'no-match', (e) => 'error: ' + e.message);" +
        " return { sheets: document.styleSheets.length," +
        " product: document.documentElement.dataset.product || ''," +
        " mode: document.documentElement.dataset.theme || ''," +
        " bg: s.getPropertyValue('--bg').trim(), brand: s.getPropertyValue('--brand').trim()," +
        " display: s.getPropertyValue('--type-display').trim()," +
        " violet: s.getPropertyValue('--violet').trim(), faces, geist }; })()",
    )) as {
      sheets: number;
      product: string;
      mode: string;
      bg: string;
      brand: string;
      display: string;
      violet: string;
      faces: string;
      geist: string;
    };
    if (!theme.bg || !theme.brand) {
      throw new Error(
        `design-system tokens did not resolve (--bg="${theme.bg}", --brand="${theme.brand}", ` +
          `${theme.sheets} stylesheet(s) loaded) — check copy-renderer.mjs`,
      );
    }
    if (theme.product !== "sapiom-studio" || !theme.display) {
      throw new Error(
        `the Studio preset is not applied (data-product="${theme.product}", ` +
          `--type-display="${theme.display}") — setup.html must carry ` +
          `data-product="sapiom-studio" on <html> and link ./themes/studio.css`,
      );
    }
    if (!theme.violet) {
      throw new Error(
        'themes/studio.css loaded but its `@import "./agent-cloud.css"` did not ' +
          "(--violet is unset) — copy-renderer.mjs must copy themes/ as a directory",
      );
    }

    return (
      "window.sapiomSetup exposes onProgress + submitConsent; Studio tokens resolve " +
      `(${theme.mode}, --bg ${theme.bg}, --brand ${theme.brand}); Geist ${theme.geist}` +
      `${theme.faces.includes("Geist") ? "" : ` (WARNING: no Geist @font-face registered — faces: ${theme.faces || "none"})`}`
    );
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * node-pty is the only native module and the one thing that has to be rebuilt
 * against Electron's ABI per platform. Loading it proves the rebuild; spawning
 * proves the unpacked spawn-helper is present and executable.
 *
 * Deliberately spawns a SCRIPT (`.cmd` on Windows, a `#!/bin/sh` file elsewhere)
 * rather than the OS shell binary, and routes it through the harness's own
 * `resolveSpawnTarget` — because a coding agent installed by npm IS a script
 * (`claude.cmd`), and that is the case that broke. Spawning `cmd.exe` directly
 * passed happily on Windows while every real session failed with
 * `Cannot create process, error code: 2`: CreateProcess does no PATHEXT lookup
 * and cannot execute a .cmd. This check now exercises the same path a session
 * does, still without needing an agent installed.
 */
async function checkNodePty(): Promise<string> {
  const pty = (await import("node-pty")) as typeof import("node-pty");
  const isWindows = process.platform === "win32";

  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-smoke-pty-"));
  // Shaped like the real thing: on Windows an npm shim (a `.cmd` that runs
  // `node <script>`), which is what `claude.cmd` is and what resolveSpawnTarget
  // must see through; elsewhere a shebang script. Spawning `cmd.exe`/`/bin/sh`
  // directly — as this check used to — passed on Windows while every real
  // session failed, because those are executable images and an agent is not.
  const script = path.join(dir, isWindows ? "agent-probe.cmd" : "agent-probe.sh");
  if (isWindows) {
    writeFileSync(path.join(dir, "agent-probe.js"), "process.exit(0);\n");
    writeFileSync(script, '@echo off\r\n"%dp0%\\node.exe" "%dp0%\\agent-probe.js" %*\r\n');
  } else {
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
  }

  try {
    const target = resolveSpawnTarget(script, []);
    const proc = pty.spawn(target.command, target.args, {
      cwd: dir,
      env: process.env as Record<string, string>,
    });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pty process did not exit in 10s")), 10_000);
      proc.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    if (code !== 0) throw new Error(`pty child exited ${code}`);
    return `spawned ${path.basename(script)} via node-pty (as ${target.command}), exit 0`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Can we resolve a REAL npm-generated agent shim?
 *
 * The session-create check spawns a stub shim that we wrote ourselves — which
 * proves the mechanism but validates our own assumption about npm's shim format.
 * If a real `claude.cmd` is shaped differently than resolveSpawnTarget's parser
 * expects, that check passes while every real user still fails. This closes the
 * loop: CI installs Claude Code for real (installing needs no auth) and we assert
 * the actual file on disk resolves to an interpreter plus a script.
 *
 * Windows-only by nature — POSIX spawns the binary directly, so there is no shim
 * to see through. Skips rather than fails when no agent is installed, so the
 * check is meaningful where it runs and silent where it can't.
 */
async function checkAgentShim(): Promise<string> {
  if (process.platform !== "win32") {
    return "SKIPPED — Windows-only (POSIX spawns the agent binary directly)";
  }
  // CI installs a real agent before smoking precisely so this check has a genuine
  // shim to read, and it is the ONLY thing validating the parser against npm's
  // actual output. Skipping silently there would ship a green release with zero
  // real-shim coverage, so on CI a missing agent is a FAILURE, not a skip.
  const required = process.env.SAPIOM_SMOKE_REQUIRE_AGENT === "1";
  let target;
  try {
    target = resolveSpawnTarget("claude", ["--version"]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found on PATH/i.test(message) && !required) {
      return "SKIPPED — no agent installed on this machine";
    }
    throw err;
  }
  // resolveSpawnTarget throws rather than returning an unspawnable command, so
  // describe what it DID resolve to: a native launcher (claude.exe, no script) or
  // an interpreter plus a script.
  const script = target.args[0];
  return script
    ? `real npm shim → ${path.basename(target.command)} + ${path.basename(script)}`
    : `real npm shim → ${path.basename(target.command)} (native launcher, spawned directly)`;
}

/**
 * Create a REAL session through the REAL server: POST /api/sessions, which
 * scaffolds/binds the workspace and spawns the agent in a pty. This is the step
 * a user hits when they click "Start session" or "Use template" — both funnel
 * through this one endpoint — and it is where Windows failed with a 500
 * (`Cannot create process, error code: 2`) while every test tier stayed green:
 * the mock-mode e2e never reaches a server, the integration tests inject a fake
 * pty spawner, and CI ran the real thing on Linux only.
 *
 * Needs no coding agent installed: smoke.sh writes a stub script and boot.ts
 * points the claude-code adapter at it (SAPIOM_SMOKE_STUB_AGENT), so the whole
 * path — HTTP, session record, pty spawn — is exercised for real on every OS.
 * Skipped, loudly, if the stub wasn't provided rather than silently passing.
 */
async function checkSessionCreate(base: string, token: string | null): Promise<string> {
  if (!token) throw new Error("boot url carried no token");
  const stub = process.env.SAPIOM_SMOKE_STUB_AGENT;
  if (!stub) return "SKIPPED — no SAPIOM_SMOKE_STUB_AGENT (run via scripts/smoke.sh)";

  const cwd = mkdtempSync(path.join(tmpdir(), "sapiom-smoke-ws-"));
  try {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "X-Harness-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ cwd, harness: "claude-code" }),
    });
    const body = await res.text();
    if (res.status !== 201) {
      throw new Error(`POST /api/sessions → ${res.status}: ${body.slice(0, 200)}`);
    }
    const session = JSON.parse(body) as { id?: string; status?: string; cwd?: string };
    if (!session.id) throw new Error(`no session id in response: ${body.slice(0, 120)}`);

    // The record must be visible in state too — a session that spawned but never
    // registered would leave the UI with nothing to attach to.
    const readState = async () =>
      (await (
        await fetch(`${base}/api/state`, { headers: { "X-Harness-Token": token } })
      ).json()) as { sessions?: Array<{ id: string; status?: string; ready?: boolean }> };
    let found = (await readState()).sessions?.find((s) => s.id === session.id);
    if (!found) throw new Error(`session ${session.id} missing from /api/state`);

    // Hook delivery — the readiness chain end-to-end. The stub agent executes
    // its --settings file's SessionStart hook command the way Claude Code
    // would (Git Bash on Windows, /bin/sh on POSIX; scripts/smoke.sh), and
    // that command's POST to /ingest is the ONLY thing that flips `ready`
    // within this window (the server's own hook-timeout fallback sits at 20s,
    // outside this 10s deadline, so a pass here can't be the fallback). This
    // is the seam that broke silently on Windows: sessions looked fine while
    // `ready` never flipped and every held first prompt was dropped.
    const deadline = Date.now() + 10_000;
    while (!found?.ready && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      found = (await readState()).sessions?.find((s) => s.id === session.id);
    }
    if (!found?.ready) {
      throw new Error(
        `session ${session.id} never became ready — the SessionStart hook command did not reach /ingest ` +
          `(is \`node\` resolvable from the hook shell? see runtime-shims)`,
      );
    }

    const inherited = await checkAgentEnvironment(session.id);
    return `spawned a session in ${path.basename(cwd)} (status ${found.status ?? session.status ?? "?"}, ready via SessionStart hook); ${inherited}`;
  } finally {
    // Best-effort ONLY, and deliberately so: this directory is the live pty's
    // cwd, and Windows refuses to delete a directory that is a running
    // process's current directory. A throw here would fail the very check it is
    // cleaning up after — reporting a Windows bug that doesn't exist. The
    // server's own shutdown kills the pty, and the OS reclaims its temp dir.
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* the pty still holds it; nothing to do and nothing worth reporting */
    }
  }
}

/**
 * What did the AGENT actually inherit?
 *
 * Asserting on what the main process *meant* to pass is not the same as asserting
 * on what arrived: `SessionManager.spawn` copies the whole parent environment into
 * the pty, and the desktop host puts `ESBUILD_BINARY_PATH` in that environment so
 * its own in-process bundler can exec a binary outside app.asar. The agent — and
 * every tool the agent runs in the USER'S repo — inherited a pin to our esbuild
 * build, so any project on a different version died with
 * `Cannot start service: Host version "0.25.12" does not match binary version
 * "0.28.1"` on a repo that builds fine outside the app. A fix in the harness is
 * invisible from here unless the check reads the child's real environment.
 *
 * The stub agent writes it (scripts/smoke.sh). Skips loudly when run without that
 * harness rather than passing silently, and keys on the new session's own id so a
 * stale file from an earlier run can never be mistaken for this one's.
 */
async function checkAgentEnvironment(sessionId: string): Promise<string> {
  const file = process.env.SAPIOM_SMOKE_AGENT_ENV;
  if (!file) return "agent env NOT CHECKED (no SAPIOM_SMOKE_AGENT_ENV — run via scripts/smoke.sh)";

  // The pty spawns asynchronously; give the stub a moment to write.
  const deadline = Date.now() + 5_000;
  let lines: string[] = [];
  for (;;) {
    if (existsSync(file)) {
      lines = readFileSync(file, "utf8").split("\n");
      if (lines.some((l) => l === `SAPIOM_HARNESS_SESSION_ID=${sessionId}`)) break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        existsSync(file)
          ? `agent env dump is not this session's (no SAPIOM_HARNESS_SESSION_ID=${sessionId})`
          : `agent never wrote ${file} — the stub did not run`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const leaked = lines.filter((l) => /^ESBUILD_BINARY_PATH=/.test(l));
  if (leaked.length) {
    throw new Error(`agent inherited the host's esbuild pin: ${leaked[0]!.slice(0, 160)}`);
  }
  // PATH must still be there — this is a targeted strip, not a clean env.
  if (!lines.some((l) => /^PATH=/.test(l))) {
    throw new Error("agent inherited no PATH — the env strip took too much");
  }
  return `agent env clean (${lines.length} vars, no esbuild pin)`;
}

/**
 * The Canvas step-graph check runs as a plain-Node subprocess (Electron with
 * ELECTRON_RUN_AS_NODE=1), which has NO asar support: every module it imports
 * must exist as a real file. asarUnpack covers node_modules, but a regression
 * there is invisible until a user clicks Visualize — so verify the entry points
 * on disk instead.
 */
async function checkUnpackedDeps(): Promise<string> {
  const harnessPkg = unpacked(require.resolve("@sapiom/harness/package.json"));
  // Resolve agent-core the way the HARNESS does — from its own module, not from
  // this package (agent-core is the harness's dependency, and under pnpm's
  // isolated node_modules it isn't visible from here at all).
  const fromHarness = createRequire(harnessPkg);
  const agentCoreEntry = unpacked(fromHarness.resolve("@sapiom/agent-core"));

  const targets: Array<[string, string]> = [
    ["@sapiom/harness", harnessPkg],
    ["web SPA", resolveWebDir()],
    // The ESM entry the Canvas subprocess imports (a stale/absent dist/esm here
    // is exactly the ERR_MODULE_NOT_FOUND crash we hit).
    ["@sapiom/agent-core entry", agentCoreEntry],
    // The seed's template tree: cpSync can't opendir inside the archive, which
    // is what made POST /api/sample-project 500 with ENOTDIR in the packaged app.
    ["agent-core templates", path.resolve(path.dirname(agentCoreEntry), "..", "..", "templates")],
  ];
  const missing = targets.filter(([, p]) => !existsSync(p)).map(([name, p]) => `${name} (${p})`);
  if (missing.length) throw new Error(`not on disk: ${missing.join(", ")}`);
  return `${targets.length} entry points present on disk (asar-translated)`;
}

type BundleForDeploy = (sourceDir: string) => Promise<{
  code: string;
  dependencies: Record<string, string>;
}>;

/**
 * Load agent-core's `bundleForDeploy` the way the harness server loads it.
 *
 * agent-core is the HARNESS's dependency, not ours — under pnpm's isolated
 * node_modules it isn't visible from this package at all, hence the two-step
 * resolve and the structural type above rather than an `import type`. It also
 * ships dual CJS/ESM, and the harness (ESM) gets the `import` condition while
 * `createRequire().resolve` would hand back the CJS copy — a different module
 * instance, and named-export interop we don't want to be testing here. So read
 * the ESM entry out of the exports map and import that.
 */
async function loadBundleForDeploy(): Promise<BundleForDeploy> {
  const fromHarness = createRequire(require.resolve("@sapiom/harness/package.json"));
  const pkgPath = fromHarness.resolve("@sapiom/agent-core/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    exports?: { ".": { import?: string } };
    module?: string;
    main?: string;
  };
  const rel = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main;
  if (!rel) throw new Error(`@sapiom/agent-core (${pkgPath}) declares no entry point`);
  const entry = path.resolve(path.dirname(pkgPath), rel);

  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const fn = mod.bundleForDeploy ?? mod.default?.bundleForDeploy;
  if (typeof fn !== "function") {
    throw new Error(`${entry} exports no bundleForDeploy (got ${Object.keys(mod).join(", ") || "nothing"})`);
  }
  return fn as BundleForDeploy;
}

/**
 * Do the runtime shims exist AND run?
 *
 * The app bundles Node (as Electron) and npm, and exposes them to the agent as
 * `node`/`npm`/`npx` shims on PATH so a machine with no system Node can still
 * work. `npx` was missing for the app's whole life, and nothing noticed: the
 * per-session MCP config launches the sapiom-dev server with `command: "npx"`, so
 * on a Node-less machine that server silently never started and the agent quietly
 * had none of the Sapiom tools. Existence is not enough — a shim that points at
 * the wrong CLI path or lost its +x bit is equally dead — so each one is executed.
 *
 * Offline and deterministic: `--version` on all three touches no network.
 */
async function checkRuntimeShims(): Promise<string> {
  const dir = shimDir();
  const exec = promisify(execFile);
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const reports: string[] = [];

  for (const name of ["node", "npm", "npx"] as const) {
    const shim = path.join(dir, `${name}${suffix}`);
    if (!existsSync(shim)) throw new Error(`no ${name} shim at ${shim}`);
    try {
      // shell on Windows: a .cmd cannot be spawned directly (CVE-2024-27980).
      const { stdout } = await exec(shim, ["--version"], { shell: process.platform === "win32" });
      const version = stdout.trim().split("\n")[0] ?? "";
      if (!version) throw new Error("no version output");
      reports.push(`${name} ${version}`);
    } catch (err) {
      throw new Error(`${name} shim did not run: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Windows also needs the EXTENSIONLESS sh flavor beside the .cmd: Claude
    // Code runs hook commands through Git Bash, which never resolves a `.cmd`
    // for a bare `node` — a .cmd-only shim dir meant zero hooks ran on a
    // machine with no system Node, so sessions never reached "ready" and held
    // prompts were silently dropped. (npm itself ships three shim flavors for
    // exactly this reason.) Bash isn't guaranteed here, so assert shape, not
    // execution — the hook-delivery poll in session-create covers execution.
    if (process.platform === "win32") {
      const shShim = path.join(dir, name);
      if (!existsSync(shShim)) throw new Error(`no extensionless (Git Bash) ${name} shim at ${shShim}`);
      const body = readFileSync(shShim, "utf8");
      if (!body.startsWith("#!/bin/sh")) {
        throw new Error(`${shShim} is not a #!/bin/sh script (starts: ${JSON.stringify(body.slice(0, 20))})`);
      }
      if (body.includes("\\")) {
        throw new Error(`${shShim} embeds backslash paths — sh-unsafe, must be forward-slashed`);
      }
    }
  }
  return reports.join(", ") + (process.platform === "win32" ? " (+ extensionless Git Bash shims)" : "");
}

/**
 * Can `POST /api/runs/local` actually reach its child process?
 *
 * The "Local Run" button was dead in every packaged build, answering with
 * `{"kind":"error","error":"spawn ENOTDIR"}` — three packaging defects in one
 * four-line spawn (asar cwd, asar script path, and no `ELECTRON_RUN_AS_NODE`, so
 * `process.execPath` would have booted a SECOND COPY OF THE APP). Unit tests pin
 * the path math; only a packaged launch proves the child really starts.
 *
 * The trick is asserting on a child that we can make fail *for a known domain
 * reason*: point it at an empty directory and agent-core answers "No index.ts
 * found". That single line proves the whole chain — cwd valid, bootstrap script
 * readable off disk, the child ran as Node rather than relaunching the app, and
 * its `import "@sapiom/agent-core"` resolved unpacked. No workflow project, no
 * dependencies, no network, and deterministic. A packaging regression cannot
 * produce that error; it produces ENOTDIR, ERR_MODULE_NOT_FOUND, or silence.
 */
async function checkRunLocal(base: string, token: string | null): Promise<string> {
  if (!token) throw new Error("boot url carried no token");

  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-smoke-runlocal-"));
  try {
    const res = await fetch(`${base}/api/runs/local`, {
      method: "POST",
      headers: { "X-Harness-Token": token, "content-type": "application/json" },
      body: JSON.stringify({ sourceDir: dir }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`POST /api/runs/local → ${res.status}: ${body.slice(0, 200)}`);

    const lines = body.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      // No NDJSON at all is the signature of the child never running — e.g. the
      // app relaunching itself instead of executing the bootstrap.
      throw new Error("no NDJSON from the run-local child (did it spawn at all?)");
    }
    const terminal = JSON.parse(lines[lines.length - 1]) as { kind?: string; error?: string };
    const message = terminal.error ?? "";
    if (/ENOTDIR|ENOENT|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/i.test(message)) {
      throw new Error(`packaging failure reached the child: ${message.slice(0, 300)}`);
    }
    if (!/index\.ts/i.test(message)) {
      throw new Error(
        `expected agent-core's "No index.ts found" from a real child, got ${terminal.kind}: ${message.slice(0, 300)}`,
      );
    }
    return `child ran and answered from agent-core (${lines.length} NDJSON line(s), terminal kind "${terminal.kind}")`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Can a deploy bundle anything?
 *
 * `POST /api/workflows/:id/deploy` runs agent-core's `bundleForDeploy()` in the
 * main process, and esbuild shells out to a native binary it locates with
 * `require.resolve` — which under Electron names the virtual `app.asar/…` path.
 * Reads through it work (Electron patches fs), `spawn` does not, so every deploy
 * from the packaged app died with `Failed to bundle the agent for deploy.
 * (spawn ENOTDIR)` while `npx` was fine. `esbuild-binary.ts` is the fix — and it
 * only works because of WHERE it is imported, which no unit test can see, so this
 * is the only thing that proves it against a real artifact.
 *
 * Bundles a throwaway two-file project rather than calling esbuild directly: the
 * relative import means a pass also covers the resolution esbuild does on the
 * author's behalf, and it exercises the exact entry point deploy uses. Network-
 * free — `bundleForDeploy` only reads the local tree.
 */
async function checkDeployBundle(): Promise<string> {
  const bundleForDeploy = await loadBundleForDeploy();

  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-smoke-bundle-"));
  try {
    writeFileSync(path.join(dir, "shared.ts"), "export const answer: number = 42;\n");
    writeFileSync(
      path.join(dir, "index.ts"),
      'import { answer } from "./shared.js";\nexport default { answer };\n',
    );
    // agent-core puts the real cause in `hint` (esbuild's own message) and keeps
    // `message` generic, so a bare rethrow reports "Failed to bundle the agent
    // for deploy." and nothing else — which is precisely the useless diagnostic
    // this check produced on its first run. Flatten both, plus the binary we
    // pinned, since that is the next thing anyone would ask.
    const { code } = await bundleForDeploy(dir).catch((err: unknown) => {
      const hint = (err as { hint?: unknown }).hint;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${message}${typeof hint === "string" ? ` (${hint})` : ""} ` +
          `[ESBUILD_BINARY_PATH=${process.env.ESBUILD_BINARY_PATH ?? "unset"}]`,
      );
    });
    // The relative import must have been INLINED — that's the whole job.
    if (!code.includes("42")) {
      throw new Error(`bundle did not inline ./shared.ts: ${code.slice(0, 200)}`);
    }
    const binPath = process.env.ESBUILD_BINARY_PATH;
    return `bundled a 2-file project (${code.length} bytes) via ${binPath ? path.basename(path.dirname(binPath)) + "/" + path.basename(binPath) : "esbuild's own resolution"}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Is this build actually capable of updating itself?
 *
 * This is the archetypal packaged-only invariant: nothing observable goes wrong
 * when it's broken. `resources/app-update.yml` is written by electron-builder ONLY
 * when a publish provider is configured, so dropping that config (or building with
 * a config the deploy dir didn't receive) produces an app that installs, launches,
 * passes every other check here — and then never updates, silently, forever. The
 * failure surfaces weeks later as "why is that tester still on 0.1.1?".
 *
 * It also loads electron-updater for real. That module is CommonJS inside an ESM
 * app whose `node_modules` are asar-unpacked, and `autoUpdater` is a getter that
 * constructs a platform-specific updater on first read — three things that can
 * only be confirmed against a packaged artifact on the platform in question.
 */
/**
 * Does the SPA actually get the desktop bridge?
 *
 * The "Check for updates" button in the Settings popover is rendered only when
 * `window.sapiomDesktop` exists, and the SPA feature-detects it because the same
 * bundle also runs in a plain browser. That makes a broken preload *invisible*:
 * no error, no blank screen — the button silently isn't there, and looks like a
 * missing feature rather than a bug. The setup window had exactly this failure
 * once (an ESM preload won't load in a sandboxed renderer, and onboarding hung
 * with nothing in any log).
 *
 * Asserted against the REAL main window, and asserted through the same shape check
 * the SPA uses, so a bridge that loads but is incomplete still fails here.
 */
async function checkDesktopBridge(boot: BootResult): Promise<string> {
  const win = boot.mainWindow;
  if (win.isDestroyed()) throw new Error("main window is gone");

  // `boot()` does NOT await the main window's load — it only registers a
  // `did-finish-load` handler to close the setup window (boot.ts) — so without
  // this we can execute against the initial empty document and report "the
  // preload did not run" as a pure race. It passes today only because the checks
  // ahead of this one happen to take long enough, which is not a guarantee.
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("main window did not finish loading in 15s")), 15_000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      win.webContents.once("did-finish-load", done);
      win.webContents.once("did-fail-load", (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`main window failed to load: ${desc} (${code})`));
      });
    });
  }

  const shape = (await win.webContents.executeJavaScript(
    "({ bridge: typeof window.sapiomDesktop," +
      " check: typeof window.sapiomDesktop?.checkForUpdates," +
      " choose: typeof window.sapiomDesktop?.chooseDirectory," +
      " deep: typeof window.sapiomDesktop?.onDeepLink," +
      " updateState: typeof window.sapiomDesktop?.onUpdateState," +
      " version: window.sapiomDesktop?.appVersion })",
  )) as { bridge: string; check: string; choose: string; deep: string; updateState: string; version: unknown };

  if (shape.bridge !== "object") {
    throw new Error("window.sapiomDesktop is missing — the main window's preload did not run");
  }
  if (shape.check !== "function") {
    throw new Error(`bridge incomplete — checkForUpdates missing: ${JSON.stringify(shape)}`);
  }
  // Shape-only for chooseDirectory: unlike checkForUpdates, we must NOT invoke it —
  // it opens a real OS folder sheet that would block a headless CI run forever. Its
  // ipcMain handler is registered on every boot path (dialogs.ts, alongside the
  // updater's), so presence of the wrapped method is the honest thing to assert here.
  if (shape.choose !== "function") {
    throw new Error(`bridge incomplete — chooseDirectory missing: ${JSON.stringify(shape)}`);
  }
  // Shape-only, like chooseDirectory: onDeepLink is a receive-only subscription
  // (main → renderer push), so there is nothing to invoke here — asserting the
  // wrapped method is present is the honest check.
  if (shape.deep !== "function") {
    throw new Error(`bridge incomplete — onDeepLink missing: ${JSON.stringify(shape)}`);
  }
  // Shape-only again: onUpdateState is the other receive-only subscription
  // (drives the rail's "Update now" card; the apply path stays native).
  if (shape.updateState !== "function") {
    throw new Error(`bridge incomplete — onUpdateState missing: ${JSON.stringify(shape)}`);
  }
  // The bridge must stay MINIMAL as well as present. Beyond appVersion the only
  // members allowed are checkForUpdates (no destructive counterpart — applying
  // an update is a native dialog, see ipc.ts), chooseDirectory (returns only a
  // user-picked path, opens no file, and is itself gated by isTrustedSender),
  // and the two receive-only subscriptions (onDeepLink, onUpdateState). A
  // restart method, by contrast, would let same-origin agent-authored content end
  // every running session — so anything new here has to be a deliberate addition.
  const extra = (await win.webContents.executeJavaScript(
    "Object.keys(window.sapiomDesktop).filter((k) => k !== 'appVersion' && k !== 'checkForUpdates' && k !== 'chooseDirectory' && k !== 'onDeepLink' && k !== 'onUpdateState')",
  )) as string[];
  if (extra.length > 0) {
    throw new Error(`bridge exposes unexpected members to page code: ${extra.join(", ")}`);
  }
  // Not cosmetic-only: the version arrives via `additionalArguments`, which is the
  // documented way to pass a value to a preload precisely because reading a
  // mutated `process.env` from a renderer is not dependable. An empty string here
  // means that mechanism silently failed.
  if (typeof shape.version !== "string" || shape.version.length === 0) {
    throw new Error(
      `bridge exposes no appVersion (${JSON.stringify(shape.version)}) — the ` +
        `additionalArguments hand-off did not reach the preload`,
    );
  }

  // Now actually CALL it. Shape alone would still pass if no `ipcMain` handler were
  // registered — `ipcRenderer.invoke` on an unhandled channel rejects, and the only
  // place that shows up is a user clicking the button in a real build.
  //
  // Hermetic on purpose: a smoke run has updates gated off, so this returns
  // `disabled` and short-circuits before any network call. That still exercises the
  // whole path — preload → invoke → handler → structured outcome back across the
  // boundary — which is exactly why the handlers are registered regardless of the
  // gate rather than only when updates are on.
  const outcome = (await win.webContents.executeJavaScript(
    "window.sapiomDesktop.checkForUpdates().then(" +
      "(o) => ({ ok: true, kind: o && o.kind, reason: o && o.reason })," +
      "(e) => ({ ok: false, kind: String((e && e.message) || e) }))",
  )) as { ok: boolean; kind?: string; reason?: string };
  if (!outcome.ok) {
    throw new Error(`checkForUpdates() rejected: ${outcome.kind} (is the ipcMain handler registered?)`);
  }
  if (outcome.kind !== "disabled") {
    // A smoke run must never reach the network; any other outcome means the gate
    // leaked and CI would start depending on GitHub.
    throw new Error(`expected a "disabled" outcome under --smoke, got "${outcome.kind}"`);
  }
  // The REASON is what makes this check meaningful now that senders are validated.
  // A rejected sender also answers `disabled`, so matching on the kind alone could
  // not tell "the gate is off" (correct) from "the main window is not trusted"
  // (broken button in every real build). Only the gate says "smoke run".
  if (outcome.reason !== "smoke run") {
    throw new Error(
      `expected the gate's reason ("smoke run"), got "${outcome.reason}" — ` +
        `the main window was not accepted as a trusted IPC sender`,
    );
  }

  return (
    `window.sapiomDesktop exposes checkForUpdates + chooseDirectory + onDeepLink + onUpdateState (v${shape.version}); ` +
    `trusted-sender round-trip returned "${outcome.kind}: ${outcome.reason}"`
  );
}

async function checkUpdateConfig(): Promise<string> {
  if (!app.isPackaged) {
    return "SKIPPED — unpackaged build has no app-update.yml (run scripts/smoke.sh)";
  }

  const configPath = path.join(process.resourcesPath, "app-update.yml");
  if (!existsSync(configPath)) {
    throw new Error(
      `no ${configPath} — electron-builder writes it only when a publish provider is ` +
        `configured, so auto-update is dead in this build`,
    );
  }
  // Read the few fields we care about directly rather than pulling in a YAML
  // parser: js-yaml is only a TRANSITIVE dependency here (via electron-updater),
  // and depending on one of those is how an unrelated upgrade breaks a build.
  const raw = readFileSync(configPath, "utf8");
  const field = (key: string): string | undefined =>
    raw.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"))?.[1];

  const provider = field("provider");
  const owner = field("owner");
  const repo = field("repo");
  if (provider !== "github") {
    throw new Error(`app-update.yml provider is "${provider ?? "(none)"}", expected "github"`);
  }
  if (!owner || !repo) {
    throw new Error(`app-update.yml names no owner/repo (owner="${owner}", repo="${repo}")`);
  }

  // Reading the getter is the test: it constructs the updater for THIS packaging
  // format (MacUpdater / NsisUpdater / AppImageUpdater / DebUpdater), which is
  // where a CJS-in-ESM or unpacked-module problem would surface.
  const { autoUpdater } = (await import("electron-updater")).default;
  const kind = autoUpdater.constructor.name;

  // Two independent things decide which manifest this install reads: the channel
  // electron-builder BAKED IN at package time (from `-c.publish.channel`, absent
  // meaning "latest") and the one the app RESOLVES at runtime from its own version.
  // They must agree, or the artifact was published to one channel while the app
  // that runs it looks at another — updates that exist and are never found.
  //
  // They agree by construction: CI derives the pack flag from package.json's
  // version, and update-policy.ts derives the runtime channel from the same field
  // by the same rule. This asserts that construction actually held, which is
  // exactly the kind of two-sided invariant no unit test can see.
  const bakedChannel = field("channel") ?? "latest";
  const { channel } = resolveUpdateChannel(app.getVersion(), process.env);
  // An env override is a deliberate disagreement (pin this machine to another
  // channel), so it suspends the check rather than failing it.
  const overridden = (process.env[CHANNEL_ENV_VAR] ?? "").trim() !== "";
  if (!overridden && bakedChannel !== channel) {
    throw new Error(
      `channel mismatch: packaged for "${bakedChannel}" but v${app.getVersion()} resolves to ` +
        `"${channel}" — this build would publish to one channel and look for updates on another`,
    );
  }

  // Report the channel so a CI log answers "which channel did this artifact ship
  // on?" without anyone having to reason about the tag.
  return (
    `${kind} → ${provider}:${owner}/${repo}, channel "${channel}"` +
    `${overridden ? " (env override)" : ""} (v${app.getVersion()})`
  );
}

/**
 * Runs every check against an already-booted app. Returns the results; the
 * caller decides the exit code (so index.ts owns process lifetime).
 */
export async function runSmokeChecks(boot: BootResult): Promise<SmokeCheck[]> {
  const base = `http://127.0.0.1:${boot.server.port}`;
  const token = new URL(boot.url).searchParams.get("token");

  return [
    await check("http-spa", async () => {
      const html = await fetchOk(`${base}/`, null, 200);
      if (!html.includes('id="root"')) throw new Error("served HTML has no #root — wrong webDir?");
      return `index.html served from ${resolveWebDir()}`;
    }),
    await check("host-terminology", async () => {
      const html = await fetchOk(`${base}/`, null, 200);
      const title = /<title>\s*([^<]+?)\s*<\/title>/i.exec(html)?.[1];
      if (title !== AGENT_STUDIO_PRODUCT_NAME) {
        throw new Error(
          `desktop title ${JSON.stringify(title)} does not match the CLI product name ` +
            JSON.stringify(AGENT_STUDIO_PRODUCT_NAME),
        );
      }
      return `desktop title matches CLI banner: ${AGENT_STUDIO_PRODUCT_NAME}`;
    }),
    await check("http-state", async () => {
      if (!token) throw new Error("boot url carried no token");
      const body = JSON.parse(await fetchOk(`${base}/api/state`, token, 200)) as {
        version?: string;
        sessions?: unknown[];
      };
      if (typeof body.version !== "string" || !Array.isArray(body.sessions)) {
        throw new Error(`unexpected /api/state shape: ${JSON.stringify(body).slice(0, 120)}`);
      }
      return `version ${body.version}, ${body.sessions.length} session(s)`;
    }),
    await check("http-authz", async () => {
      await fetchOk(`${base}/api/state`, null, 401);
      return "/api rejects a request with no boot token";
    }),
    await check("session-create", () => checkSessionCreate(base, token)),
    await check("agent-shim", checkAgentShim),
    await check("preload-bridge", checkPreloadBridge),
    await check("node-pty", checkNodePty),
    await check("unpacked-deps", checkUnpackedDeps),
    await check("runtime-shims", checkRuntimeShims),
    await check("run-local", () => checkRunLocal(base, token)),
    await check("deploy-bundle", checkDeployBundle),
    await check("desktop-bridge", () => checkDesktopBridge(boot)),
    await check("update-config", checkUpdateConfig),
  ];
}

/**
 * Prints one line per check plus a verdict, and returns the process exit code.
 *
 * Also writes the same report to `SAPIOM_SMOKE_OUT` when set. On Windows the
 * packaged app is a GUI-subsystem executable: it does not attach to the parent
 * console, so stdout goes nowhere and a CI log shows an exit code with no
 * explanation. A file survives that.
 */
export function reportSmoke(checks: SmokeCheck[]): number {
  const failed = checks.filter((c) => !c.ok);
  // A skip is NOT a pass. Labelling it "PASS" would hide the case this matters
  // most in: the Windows agent install failing, `agent-shim` skipping, and the
  // log claiming full coverage it didn't have. Skips don't fail the run, but they
  // are visibly distinct.
  const isSkip = (c: SmokeCheck): boolean => c.ok && c.detail.startsWith("SKIPPED");
  const skipped = checks.filter(isSkip);
  const passed = checks.filter((c) => c.ok && !isSkip(c));

  const lines = [
    ...checks.map((c) => `[smoke] ${!c.ok ? "FAIL" : isSkip(c) ? "SKIP" : "PASS"} ${c.name} — ${c.detail}`),
    failed.length === 0
      ? `[smoke] OK — ${passed.length} passed` +
        (skipped.length ? `, ${skipped.length} skipped (${skipped.map((c) => c.name).join(", ")})` : "")
      : `[smoke] FAILED — ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join(", ")}`,
  ];
  for (const line of lines) console.log(line);

  const outFile = process.env.SAPIOM_SMOKE_OUT;
  if (outFile) {
    try {
      writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
    } catch (err) {
      console.error(`[smoke] could not write ${outFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

/**
 * Deliberately NOT exported: destroying the windows here fires
 * `window-all-closed` → `app.quit()` → the `before-quit` handler's
 * `server.close()`, racing the caller's own close (the harness then logs
 * ERR_SERVER_NOT_RUNNING). `app.exit()` tears the process down without running
 * that path, so the caller closes the server and exits — nothing to clean up.
 */
