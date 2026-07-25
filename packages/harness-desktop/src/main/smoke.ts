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
 *   http-state      the REST surface answers with the boot token …
 *   http-authz      … and rejects a request without it
 *   preload-bridge  the setup window's preload actually loaded (an ESM/sandbox
 *                   mismatch once made onboarding hang forever with no error)
 *   node-pty        the native module loads under Electron's ABI and can spawn
 *                   (covers the rebuild AND the +x spawn-helper) — no agent needed
 *   unpacked-deps   what the plain-Node Canvas subprocess imports exists ON DISK,
 *                   not just inside the archive
 *
 * Exit code is 0 only if every check passes; each result is printed as one line
 * so a CI log shows exactly which layer broke.
 */
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { createSetupWindow } from "./windows.js";
import { resolveWebDir } from "./paths.js";
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
    const theme = (await win.webContents.executeJavaScript(
      "(() => { const s = getComputedStyle(document.documentElement);" +
        " return { sheets: document.styleSheets.length, bg: s.getPropertyValue('--bg').trim()," +
        " brand: s.getPropertyValue('--brand').trim() }; })()",
    )) as { sheets: number; bg: string; brand: string };
    if (!theme.bg || !theme.brand) {
      throw new Error(
        `design-system tokens did not resolve (--bg="${theme.bg}", --brand="${theme.brand}", ` +
          `${theme.sheets} stylesheet(s) loaded) — check copy-renderer.mjs`,
      );
    }

    return `window.sapiomSetup exposes onProgress + submitConsent; tokens resolve (--bg ${theme.bg})`;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * node-pty is the only native module and the one thing that has to be rebuilt
 * against Electron's ABI per platform. Loading it proves the rebuild; spawning
 * a trivial process proves the unpacked spawn-helper is present and executable.
 * Uses the OS's own shell, so this needs no coding agent installed.
 */
async function checkNodePty(): Promise<string> {
  const pty = (await import("node-pty")) as typeof import("node-pty");
  const isWindows = process.platform === "win32";
  const [file, args] = isWindows ? ["cmd.exe", ["/c", "exit", "0"]] : ["/bin/sh", ["-c", "exit 0"]];
  const proc = pty.spawn(file, args, { cwd: process.cwd(), env: process.env as Record<string, string> });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pty process did not exit in 10s")), 10_000);
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`pty child exited ${code}`);
  return `spawned ${file} via node-pty, exit 0`;
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
    await check("preload-bridge", checkPreloadBridge),
    await check("node-pty", checkNodePty),
    await check("unpacked-deps", checkUnpackedDeps),
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
  const lines = [
    ...checks.map((c) => `[smoke] ${c.ok ? "PASS" : "FAIL"} ${c.name} — ${c.detail}`),
    failed.length === 0
      ? `[smoke] OK — ${checks.length}/${checks.length} checks passed`
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
