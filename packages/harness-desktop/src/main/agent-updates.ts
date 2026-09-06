import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const AGENT_PACKAGES = {
  "claude-code": { binary: "claude", package: "@anthropic-ai/claude-code" },
  codex: { binary: "codex", package: "@openai/codex" },
} as const;
export type AgentKind = keyof typeof AGENT_PACKAGES;

/** Mirrors the adapter's optional interpreter prefix. npm's Codex entry is JS;
 * on Windows a Node-less desktop cannot launch its .cmd through node-pty. */
export interface AgentCommand {
  binary: string;
  binaryArgs: string[];
  binaryEnv: Record<string, string>;
}
export interface ManagedAgent {
  prefix: string;
  version: string;
  command: AgentCommand;
}
interface Selection {
  version: string;
  directory: string;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INSTALL_DIRECTORY = /^\d+\.\d+\.\d+-[a-f0-9-]{36}$/;

export function cliVersion(line: string | null): string | null {
  return line?.match(/\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?/)?.[0] ?? null;
}

/** The registry target is stable. Keep a newer local/beta build; promote a
 * pre-release only when the same core version has reached stable. */
export function isNewerStable(latest: string, current: string): boolean {
  if (!STABLE_VERSION.test(latest)) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return current.includes("-");
}

export async function latestAgentVersion(kind: AgentKind): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${AGENT_PACKAGES[kind].package}/latest`,
    {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new Error(`Registry returned HTTP ${response.status}`);
  const data = (await response.json()) as { version?: unknown };
  if (typeof data.version !== "string" || !STABLE_VERSION.test(data.version)) {
    throw new Error("Registry did not return a stable CLI version");
  }
  return data.version;
}

export async function resolveAgentCommand(
  prefix: string,
  kind: AgentKind,
  runtime: AgentCommand,
): Promise<AgentCommand | null> {
  const agent = AGENT_PACKAGES[kind];
  for (const modules of ["node_modules", path.join("lib", "node_modules")]) {
    try {
      const packageDir = path.join(prefix, modules, agent.package);
      const pkg = JSON.parse(
        await readFile(path.join(packageDir, "package.json"), "utf8"),
      ) as {
        bin?: string | Record<string, string>;
      };
      const bin =
        typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[agent.binary];
      if (!bin) continue;
      const entry = path.resolve(packageDir, bin);
      const relative = path.relative(packageDir, entry);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        continue;
      await access(entry);
      const binaryEnv: Record<string, string> =
        kind === "claude-code" ? { DISABLE_AUTOUPDATER: "1" } : {};
      return /\.[cm]?js$/i.test(entry)
        ? {
            binary: runtime.binary,
            binaryArgs: [...runtime.binaryArgs, entry],
            binaryEnv: { ...runtime.binaryEnv, ...binaryEnv },
          }
        : { binary: entry, binaryArgs: [], binaryEnv };
    } catch {
      /* Try the other global npm layout. */
    }
  }
  return null;
}

async function loadSelection(
  root: string,
  kind: AgentKind,
): Promise<Selection | null> {
  try {
    const value = JSON.parse(
      await readFile(path.join(root, kind, "active.json"), "utf8"),
    ) as Selection;
    return typeof value.version === "string" &&
      STABLE_VERSION.test(value.version) &&
      typeof value.directory === "string" &&
      INSTALL_DIRECTORY.test(value.directory) &&
      value.directory.startsWith(`${value.version}-`)
      ? value
      : null;
  } catch {
    return null;
  }
}

export interface AgentUpdateOptions {
  root: string;
  runtime: AgentCommand;
  /** Dev/smoke may reuse a selected install but never ask the registry or install. */
  enabled: boolean;
  signal?: AbortSignal;
  probe: (command: AgentCommand) => Promise<string | null>;
  install: (
    packageSpec: string,
    prefix: string,
    onLine: (line: string) => void,
  ) => Promise<boolean>;
  latest?: (kind: AgentKind) => Promise<string>;
  onLine?: (line: string) => void;
}

/** Check each detected CLI on every normal boot, before any session exists.
 * Install into a fresh, immutable prefix, verify the actual executable, then
 * atomically select it. Never mutate a working global or managed installation.
 * Old versions are retained: an external process may still be using one. */
export async function ensureAgentUpdates(
  options: AgentUpdateOptions,
): Promise<Partial<Record<AgentKind, ManagedAgent>>> {
  const selected: Partial<Record<AgentKind, ManagedAgent>> = {};
  const log = options.onLine ?? (() => {});
  for (const kind of Object.keys(AGENT_PACKAGES) as AgentKind[]) {
    if (options.signal?.aborted) break;
    try {
      const agent = AGENT_PACKAGES[kind];
      const existing = await loadSelection(options.root, kind);
      const external = await options.probe({
        binary: agent.binary,
        binaryArgs: [],
        binaryEnv: {},
      });
      let currentVersion = cliVersion(external);
      if (existing) {
        const prefix = path.join(options.root, kind, existing.directory);
        const command = await resolveAgentCommand(
          prefix,
          kind,
          options.runtime,
        );
        const managedVersion = command
          ? cliVersion(await options.probe(command))
          : null;
        if (
          managedVersion === existing.version &&
          (!external ||
            (currentVersion &&
              (managedVersion === currentVersion ||
                isNewerStable(managedVersion, currentVersion))))
        ) {
          selected[kind] = {
            prefix,
            command: command!,
            version: managedVersion,
          };
          currentVersion = managedVersion;
        }
      }
      // Missing agents still use boot's existing default-agent installation flow.
      // An unknown local version is not evidence that replacing it is an upgrade.
      if (
        !options.enabled ||
        (!existing && external === null) ||
        (external !== null && !currentVersion)
      )
        continue;
      log(
        `Checking ${agent.binary} updates${currentVersion ? ` (installed ${currentVersion})` : ""}…`,
      );
      const latest = await (options.latest ?? latestAgentVersion)(kind);
      if (!STABLE_VERSION.test(latest))
        throw new Error("Invalid registry version");
      if (currentVersion && !isNewerStable(latest, currentVersion)) {
        log(`${agent.binary} ${currentVersion} is current.`);
        continue;
      }
      const directory = `${latest}-${randomUUID()}`;
      const parent = path.join(options.root, kind);
      const prefix = path.join(parent, directory);
      options.signal?.throwIfAborted();
      await mkdir(prefix, { recursive: true });
      log(`Updating ${agent.binary} to ${latest}…`);
      if (!(await options.install(`${agent.package}@${latest}`, prefix, log)))
        throw new Error("Installation failed or timed out");
      const command = await resolveAgentCommand(prefix, kind, options.runtime);
      if (!command || cliVersion(await options.probe(command)) !== latest)
        throw new Error("New CLI failed its version check");
      // The selection is the commit point. Interrupted downloads/installs cannot
      // replace it, and no version's files move after npm writes its launchers.
      const temp = path.join(parent, `active-${randomUUID()}.json`);
      options.signal?.throwIfAborted();
      await writeFile(
        temp,
        JSON.stringify({ version: latest, directory } satisfies Selection),
        { flag: "wx" },
      );
      options.signal?.throwIfAborted();
      await rename(temp, path.join(parent, "active.json"));
      selected[kind] = { prefix, version: latest, command };
      log(`${agent.binary} updated to ${latest}.`);
    } catch (err) {
      log(
        `${AGENT_PACKAGES[kind].binary} update deferred; keeping the installed version. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return selected;
}
