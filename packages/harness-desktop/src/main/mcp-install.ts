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
 * Freshness: an existing install is used immediately and refreshed in the
 * background (fire-and-forget npm install), so sessions never wait on the
 * network but track the published package within one launch.
 *
 * No `electron` import (the caller passes the prefix + installer) — the
 * vitest tier covers the resolution and decision logic from POSIX.
 */
import { existsSync, readFileSync } from "node:fs";
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

export interface EnsureSapiomMcpOptions {
  /** The per-user npm prefix (agent-install's agentPrefixDir()). */
  prefix: string;
  smoke: boolean;
  devMode: boolean;
  /** Runs `npm install -g @sapiom/mcp@latest` into the prefix (agent-install). */
  install: (onLine: (line: string) => void) => Promise<{ ok: boolean }>;
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
 * - existing install: returned immediately, refreshed in the background so
 *   boot never waits on the registry.
 */
export async function ensureSapiomMcp(options: EnsureSapiomMcpOptions): Promise<string | null> {
  const onLine = options.onLine ?? (() => {});
  try {
    const existing = resolveSapiomMcpEntry(options.prefix);
    if (options.smoke) return existing;
    if (existing) {
      void options.install(() => {}).catch(() => {});
      return existing;
    }
    if (options.devMode) return null;
    const result = await options.install(onLine);
    if (!result.ok) {
      onLine("@sapiom/mcp install failed — sessions fall back to the npx launch.");
      return null;
    }
    return resolveSapiomMcpEntry(options.prefix);
  } catch (err) {
    onLine(`@sapiom/mcp setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
