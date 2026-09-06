import { access, readFile } from "node:fs/promises";
import * as path from "node:path";

export const AGENT_PACKAGES = {
  "claude-code": { binary: "claude", package: "@anthropic-ai/claude-code" },
  codex: { binary: "codex", package: "@openai/codex" },
} as const;
export type AgentKind = keyof typeof AGENT_PACKAGES;

export interface AgentCommand {
  binary: string;
  binaryArgs: string[];
  binaryEnv: Record<string, string>;
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
