/**
 * Agent auto-install (Phase 3) — the "one-click" part of the one-click app.
 *
 * A non-technical user who double-clicks the app may have no coding agent (and
 * possibly no Node/npm) on their machine. Electron bundles Node but NOT npm, so
 * we bundle the `npm` package as a real dependency and drive its CLI with
 * Electron-as-Node (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) — the same
 * trick the harness uses for its Canvas subprocess.
 *
 * The agent installs into a per-user, writable prefix (`userData/npm-global`)
 * so no root/sudo is needed. `boot.ts` prepends that prefix's bin dir to PATH
 * BEFORE `runDoctor()`, so a freshly-installed `claude` is discoverable on the
 * same launch — both to doctor and to the node-pty-spawned agent.
 *
 * This module is deliberately free of BrowserWindow/IPC concerns: it exposes a
 * pure install primitive that streams output through a callback. `boot.ts` owns
 * the setup-window progress plumbing and the guided-install fallback.
 */
import { app } from "electron";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { CLAUDE_INSTALL_COMMAND } from "@sapiom/harness";

const require = createRequire(import.meta.url);

/**
 * Absolute path to the bundled npm CLI. npm's `exports` map does NOT expose
 * `./bin/npm-cli.js`, so we resolve its (exported) `package.json`, read the
 * `bin.npm` field, and join it onto npm's dir — robust to npm changing its bin
 * layout.
 *
 * This path DOES name `app.asar` in a packaged build (measured:
 * `…/resources/app.asar/node_modules/npm/bin/npm-cli.js`) — the previous comment
 * here claimed `require.resolve` hands back the unpacked path, and that is simply
 * false. It works regardless, for a different reason: the child below is spawned
 * with `ELECTRON_RUN_AS_NODE`, so it is still the Electron binary and keeps the
 * asar `fs` patch, and reading an in-archive file succeeds (real `node` would get
 * ENOTDIR). Deliberately left as-is rather than "fixed", because first-run agent
 * install is the highest-stakes path in the app and this is empirically working.
 *
 * What that does NOT cover: paths npm derives from this location and hands to a
 * NON-Electron process — `npm_config_node_gyp` and the node-gyp bin dir it puts
 * on PATH, consumed by python/make/cc when a dependency has a native addon.
 * Unverified (it needs a real native-addon install to reproduce); see
 * `unpackedPath()` in `@sapiom/harness`'s `core/asar-path.ts` if it turns out to
 * need translating.
 */
export function resolveNpmCli(): string {
  const pkgJsonPath = require.resolve("npm/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    bin?: { npm?: string };
  };
  const relBin = pkg.bin?.npm ?? "bin/npm-cli.js";
  return path.join(path.dirname(pkgJsonPath), relBin);
}

/**
 * The npm `--prefix` target: a writable, per-user dir under the app's userData.
 * Global installs land their package under `<prefix>/lib/node_modules` and the
 * executable shim under `<prefix>/bin` (POSIX) / `<prefix>` (Windows) — which is
 * exactly what `boot.ts`'s `agentBinDir()` adds to PATH. Keep the two in sync.
 */
export function agentPrefixDir(): string {
  return path.join(app.getPath("userData"), "npm-global");
}

/**
 * Extract the npm package spec from the harness's install-command constant
 * (e.g. "npm i -g @anthropic-ai/claude-code" → "@anthropic-ai/claude-code").
 * Parsing the constant instead of hardcoding the name keeps the desktop
 * installer from drifting from what the CLI itself tells users to run.
 */
export function packageSpecFromInstallCommand(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  const spec = tokens[tokens.length - 1];
  if (!spec || spec.startsWith("-")) {
    throw new Error(
      `Could not parse a package spec from install command: "${cmd}"`,
    );
  }
  return spec;
}

export interface InstallResult {
  ok: boolean;
  /** The npm spec we attempted to install (e.g. "@anthropic-ai/claude-code"). */
  packageSpec: string;
  /** The `--prefix` dir the agent installed into. */
  prefix: string;
  /** Combined stdout+stderr tail, for surfacing diagnostics on failure. */
  log: string;
  /** npm's exit code (null if the process was killed / failed to spawn). */
  code: number | null;
}

/** How many trailing output lines to keep for the failure diagnostic. */
const LOG_TAIL_LINES = 40;

/**
 * Install the default coding agent (Claude Code) into the per-user npm prefix.
 * Streams npm's line-buffered output through `onLine` so the setup window can
 * show live progress. Resolves (never rejects) with an `InstallResult`; callers
 * decide fatal-vs-fallback by re-running `runDoctor()`.
 */
export function installClaudeCode(
  onLine: (line: string) => void,
): Promise<InstallResult> {
  const npmCli = resolveNpmCli();
  const prefix = agentPrefixDir();
  const packageSpec = packageSpecFromInstallCommand(CLAUDE_INSTALL_COMMAND);

  // `--no-audit --no-fund` keep the run quiet/fast; `--loglevel=info` gives us
  // meaningful progress lines to stream. `--prefix` makes it a per-user install
  // (no root). We invoke npm's CLI directly rather than shelling a string.
  const args = [
    npmCli,
    "install",
    "--global",
    packageSpec,
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--loglevel=info",
  ];

  return new Promise<InstallResult>((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        packageSpec,
        prefix,
        log: `failed to start npm: ${message}`,
        code: null,
      });
      return;
    }

    const tail: string[] = [];
    const pushLines = (chunk: Buffer): void => {
      for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        tail.push(line);
        if (tail.length > LOG_TAIL_LINES) tail.shift();
        onLine(line);
      }
    };

    child.stdout?.on("data", pushLines);
    child.stderr?.on("data", pushLines);
    child.on("error", (err) => {
      resolve({
        ok: false,
        packageSpec,
        prefix,
        log: `${tail.join("\n")}\n${err.message}`,
        code: null,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        packageSpec,
        prefix,
        log: tail.join("\n"),
        code,
      });
    });
  });
}
