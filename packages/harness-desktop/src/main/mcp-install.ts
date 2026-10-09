/**
 * Install @sapiom/mcp into the per-user npm prefix and resolve its entry
 * script, so the harness can launch the `sapiom-dev` MCP server as
 * `<Sapiom.exe> <entry.js>` (ELECTRON_RUN_AS_NODE) instead of
 * `npx -y @sapiom/mcp@latest`.
 *
 * Why (Windows, the shipped failure): the npx chain's top process is cmd.exe
 * — a console-subsystem image — and Claude Code spawns it without
 * windowsHide, so a PERSISTENT blank console window sat on the user's screen
 * for the whole session. Users closed it, which killed the MCP server's
 * process tree, and every later tool call hung against the dead server. A
 * GUI-subsystem launcher (the app binary itself, acting as Node) allocates no
 * console under any spawn flags while its stdio pipes work normally — the
 * window cannot exist. Every platform also gains: no npm-registry round-trip
 * per session (npx re-resolves `@latest` on each launch), and sessions work
 * offline once installed.
 *
 * Freshness: each boot asks the npm registry for @sapiom/mcp's `latest`
 * (one small request, short timeout) and reinstalls, awaited before sessions
 * exist, only when the install is behind it. A new @sapiom/mcp therefore
 * reaches sessions on the next launch without a Studio release. The app's
 * bundled copy is the floor: an install older than it is never launched.
 * Per-session capability preflight never installs.
 *
 * No `electron` import (the caller passes the prefix + installer) — the
 * vitest tier covers the resolution and decision logic from POSIX.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";

/**
 * The installed @sapiom/mcp entry script under an npm prefix, or null.
 * Handles both global-layout shapes: `<prefix>/node_modules` (Windows) and
 * `<prefix>/lib/node_modules` (POSIX). The bin path comes from the package's
 * own package.json rather than a hardcoded `dist/index.js`, so a layout
 * change in @sapiom/mcp doesn't silently break the launcher.
 */
export function resolveSapiomMcpEntry(prefixDir: string): string | null {
  for (const modulesDir of [
    path.join(prefixDir, "node_modules"),
    path.join(prefixDir, "lib", "node_modules"),
  ]) {
    const pkgDir = path.join(modulesDir, "@sapiom", "mcp");
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        bin?: string | Record<string, string | undefined>;
      };
      const rel =
        typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {}).find(Boolean);
      if (!rel) continue;
      const entry = path.join(pkgDir, rel);
      if (existsSync(entry)) return entry;
    } catch {
      // Unparseable package.json — treat as not installed.
    }
  }
  return null;
}

/**
 * Remove a TORN @sapiom/mcp install so npm can lay down a fresh one.
 *
 * Field case: the app quit while npm was mid-extraction, leaving
 * `node_modules/@sapiom/mcp/` holding ONLY its dependency subtree — no
 * package.json, no dist. The resolver rightly returns null for that, but npm
 * cannot repair over the torn tree either (its rename-into-place semantics
 * fail on the leftovers), so every boot's reinstall failed and every session
 * fell back to the npx launch — the persistent console window, forever.
 * Since the caller only invokes this when the resolver found nothing, any
 * directory present here is by definition torn: deleting it is repair, not
 * data loss.
 */
function removeTornInstall(prefixDir: string, onLine: (line: string) => void): void {
  for (const modulesDir of [
    path.join(prefixDir, "node_modules"),
    path.join(prefixDir, "lib", "node_modules"),
  ]) {
    const pkgDir = path.join(modulesDir, "@sapiom", "mcp");
    if (!existsSync(pkgDir)) continue;
    try {
      rmSync(pkgDir, { recursive: true, force: true });
      onLine(`removed torn @sapiom/mcp install at ${pkgDir} before reinstalling`);
    } catch (err) {
      onLine(
        `could not remove torn install at ${pkgDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The version in the package.json that owns an @sapiom/mcp entry script, or
 * null. Walks up from the entry, so it works for a prefix install and for the
 * copy bundled inside the app alike.
 */
export function sapiomMcpVersionAt(entry: string): string | null {
  let dir = path.dirname(entry);
  for (;;) {
    const pkgJsonPath = path.join(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@sapiom/mcp") return pkg.version ?? null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Whether release version `a` is older than `b`, comparing major.minor.patch.
 * Anything unparseable compares as not older, so a malformed version never
 * triggers a reinstall loop.
 */
export function isOlderVersion(a: string | null, b: string | null): boolean {
  const parse = (v: string | null) => {
    const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

/** How long a boot waits on the registry before keeping the install it has. */
export const LATEST_LOOKUP_TIMEOUT_MS = 2000;

/**
 * @sapiom/mcp's `latest` dist-tag from the public registry, or null when the
 * registry is unreachable or slow (offline boots keep the current install).
 */
export async function fetchLatestSapiomMcpVersion(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/@sapiom/mcp/latest", {
      signal: AbortSignal.timeout(LATEST_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

export interface EnsureSapiomMcpOptions {
  /** The per-user npm prefix (agent-install's agentPrefixDir()). */
  prefix: string;
  smoke: boolean;
  devMode: boolean;
  /** Runs `npm install -g @sapiom/mcp@latest` into the prefix (agent-install). */
  install: (onLine: (line: string) => void) => Promise<{ ok: boolean }>;
  /** The registry's `latest` version, or null when unknown. */
  latestVersion: () => Promise<string | null>;
  /**
   * The @sapiom/mcp entry bundled inside the app. The harness's own prompts
   * are written against this version, so a prefix install older than it is
   * passed over in its favour.
   */
  bundledEntry?: string | null;
  onLine?: (line: string) => void;
}

/**
 * Resolve (installing if needed) the @sapiom/mcp entry script. Null means
 * "no override" — the generated MCP config falls back to the npx launch,
 * i.e. exactly today's behavior. Never throws.
 *
 * - smoke: never touches the network; uses an existing install when present.
 * - dev: never installs (mirrors the sapiom-CLI policy — dev machines run
 *   the workspace copy via npx); still uses an install a packaged run left.
 * - existing install: refreshed only when it is older than the registry's
 *   `latest` — AWAITED, never in the background. An unreachable registry
 *   keeps the install as it is.
 * - floor (packaged runs): the bundled copy wins when it is newer than what
 *   resolved, including when nothing installed at all.
 *
 * The refresh must not be backgrounded: boot bakes the resolved entry path
 * into every session's MCP config for the whole run, and npm refreshes by
 * removing and re-extracting that exact directory. A background install
 * therefore races the first session's `<app binary> <entry.js>` spawn
 * (MODULE_NOT_FOUND, dead sapiom-dev for the rest of the run) and, on
 * Windows, can tear the tree against files a running MCP server holds open.
 * Awaiting it here — before any session can exist — makes the sequence
 * deterministic; the version gate keeps the common boot to one small
 * registry read and rewrites the tree only on a real release.
 */
export async function ensureSapiomMcp(options: EnsureSapiomMcpOptions): Promise<string | null> {
  const onLine = options.onLine ?? (() => {});
  const chosen = await resolveFromPrefix(options, onLine);
  // Smoke and dev keep their own policies (see resolveFromPrefix).
  if (options.smoke || options.devMode) return chosen;
  return atLeastBundled(chosen, options.bundledEntry ?? null, onLine);
}

/**
 * The bundled entry when it is newer than `chosen` (or `chosen` is null),
 * else `chosen`. Sessions launch both the same way (`<app binary> <entry>`).
 */
function atLeastBundled(
  chosen: string | null,
  bundled: string | null,
  onLine: (line: string) => void,
): string | null {
  if (!bundled || !existsSync(bundled)) return chosen;
  const bundledVersion = sapiomMcpVersionAt(bundled);
  if (chosen && !isOlderVersion(sapiomMcpVersionAt(chosen), bundledVersion)) return chosen;
  onLine(
    chosen
      ? `installed @sapiom/mcp ${sapiomMcpVersionAt(chosen) ?? "?"} is older than the bundled ${bundledVersion ?? "?"} — using the bundled copy.`
      : `no installed @sapiom/mcp — using the bundled ${bundledVersion ?? "?"}.`,
  );
  return bundled;
}

async function resolveFromPrefix(
  options: EnsureSapiomMcpOptions,
  onLine: (line: string) => void,
): Promise<string | null> {
  try {
    const existing = resolveSapiomMcpEntry(options.prefix);
    if (options.smoke) return existing;
    // Dev first: a packaged run may have left an install in the shared
    // userData prefix, and `pnpm dev` must neither hit the registry nor
    // clobber a locally-built test copy (mirrors the sapiom-CLI policy).
    if (options.devMode) return existing;
    if (existing) {
      const installed = sapiomMcpVersionAt(existing);
      const latest = await options.latestVersion().catch(() => null);
      if (!isOlderVersion(installed, latest)) return existing;
      onLine(`refreshing @sapiom/mcp ${installed ?? "?"} → ${latest}…`);
      await options.install(onLine).catch(() => ({ ok: false }));
      // Re-resolve: the refresh rewrote the tree, and a failed one can leave
      // nothing behind — fall through to the repair path when it did.
      const refreshed = resolveSapiomMcpEntry(options.prefix);
      if (refreshed) return refreshed;
      onLine("@sapiom/mcp refresh left no usable install — repairing.");
    }
    // The resolver found nothing, so whatever sits in the package dir is a
    // torn previous attempt — clear it or npm's reinstall fails forever.
    removeTornInstall(options.prefix, onLine);
    const result = await options.install(onLine);
    // Resolve regardless of npm's exit code: npm can materialize a perfectly
    // usable package and still exit non-zero (a bin-shim collision, an EPERM
    // on some unrelated file). Trusting only the exit code left one machine
    // with the package on disk and every session still on the npx launch —
    // the exact window this module exists to remove.
    const entry = resolveSapiomMcpEntry(options.prefix);
    if (!entry) {
      onLine("@sapiom/mcp install failed — sessions fall back to the npx launch.");
      return null;
    }
    if (!result.ok) onLine("@sapiom/mcp install exited non-zero but the package resolved — using it.");
    return entry;
  } catch (err) {
    onLine(`@sapiom/mcp setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
