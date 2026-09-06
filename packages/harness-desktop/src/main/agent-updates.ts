import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_PACKAGES,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from "./managed-agent.js";

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

// Promote prereleases once stable, without downgrading newer local builds.
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

/** Install and verify each update before atomically selecting its immutable prefix. */
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
      // An unrecognized local build is not evidence that an update is needed.
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
      // Publish only after verification; preserve the previous selection on failure.
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
