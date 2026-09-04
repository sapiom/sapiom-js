import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { LaunchOpts, SpawnSpec } from "../../shared/types.js";

type TomlValue = string | string[] | { [key: string]: TomlValue };

/** JSON string escaping also works for TOML basic strings, except that TOML
 * requires DEL to be escaped as well. Inline-table keys are always quoted. */
function toml(value: TomlValue): string {
  if (typeof value === "string")
    return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${toml(key)} = ${toml(item)}`)
    .join(", ")} }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (
    !isRecord(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid string map");
  }
  return value as Record<string, string>;
}

/**
 * Adapt Studio's generated Claude-shaped MCP file to Codex's per-process
 * config overrides. Codex deep-merges even whole-table overrides, so stable
 * session aliases prevent existing same-name transport/auth fields from
 * bleeding into Studio's servers. All user servers remain unchanged and no
 * config.toml is written. The prompt identifies Studio's aliases explicitly.
 *
 * Header/stdio environment values stay in the child environment, never argv.
 * `env_http_headers` and stdio `env_vars` are Codex config keys; neither needs
 * persistent `codex mcp add` registration.
 */
export function buildCodexMcpConfig(
  opts: Pick<LaunchOpts, "harnessSessionId" | "mcpConfigFile" | "agentMapMcp">,
): Pick<SpawnSpec, "args" | "env"> & { instructions?: string } {
  const args: string[] = [];
  const aliases: string[] = [];
  const suffix = createHash("sha256")
    .update(opts.harnessSessionId)
    .digest("hex")
    .slice(0, 12);
  const env: Record<string, string> = {};
  const bindEnv = (name: string, value: string): void => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "__proto__") {
      throw new Error("Invalid environment name");
    }
    if (
      Object.prototype.hasOwnProperty.call(env, name) &&
      env[name] !== value
    ) {
      throw new Error("Conflicting environment values");
    }
    env[name] = value;
  };
  const addServer = (name: string, config: Record<string, TomlValue>): void => {
    // Codex -c paths split on dots; restricting generated server names also
    // prevents a name from addressing another part of the user's config.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid server name");
    const alias = `${name}-${suffix}`;
    aliases.push(alias);
    args.push("-c", `mcp_servers.${alias}=${toml(config)}`);
  };

  try {
    if (opts.mcpConfigFile) {
      const parsed: unknown = JSON.parse(
        readFileSync(opts.mcpConfigFile, "utf8"),
      );
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
        throw new Error("Invalid MCP configuration");
      }
      for (const [index, [name, server]] of Object.entries(
        parsed.mcpServers,
      ).entries()) {
        // A freshly issued capability supplied separately wins over a copy
        // in the generated file. Keep compatibility with callers using only
        // agentMapMcp as well.
        if (name === "agent-map" && opts.agentMapMcp) continue;
        if (!isRecord(server)) throw new Error("Invalid server");
        if (server.type === "http") {
          if (
            typeof server.url !== "string" ||
            !/^https?:\/\//.test(server.url)
          ) {
            throw new Error("Invalid HTTP URL");
          }
          if (
            Object.keys(server).some(
              (key) => !["type", "url", "headers"].includes(key),
            )
          ) {
            throw new Error("Unsupported HTTP configuration");
          }
          const config: Record<string, TomlValue> = { url: server.url };
          if (server.headers !== undefined) {
            const headers = stringRecord(server.headers);
            config.env_http_headers = Object.fromEntries(
              Object.entries(headers).map(([header, value], headerIndex) => {
                const variable = `SAPIOM_CODEX_MCP_${index}_HEADER_${headerIndex}`;
                bindEnv(variable, value);
                return [header, variable];
              }),
            );
          }
          addServer(name, config);
        } else {
          if (
            (server.type !== undefined && server.type !== "stdio") ||
            typeof server.command !== "string" ||
            !server.command ||
            (server.args !== undefined &&
              (!Array.isArray(server.args) ||
                server.args.some((arg) => typeof arg !== "string"))) ||
            Object.keys(server).some(
              (key) => !["type", "command", "args", "env"].includes(key),
            )
          ) {
            throw new Error("Invalid stdio configuration");
          }
          const config: Record<string, TomlValue> = {
            command: server.command,
            ...(server.args !== undefined
              ? { args: server.args as string[] }
              : {}),
          };
          if (server.env !== undefined) {
            const values = stringRecord(server.env);
            for (const [variable, value] of Object.entries(values))
              bindEnv(variable, value);
            config.env_vars = Object.keys(values);
          }
          addServer(name, config);
        }
      }
    }
    if (opts.agentMapMcp) {
      bindEnv("SAPIOM_AGENT_MAP_CAPABILITY", opts.agentMapMcp.bearerToken);
      addServer("agent-map", {
        url: opts.agentMapMcp.url,
        bearer_token_env_var: "SAPIOM_AGENT_MAP_CAPABILITY",
      });
    }
  } catch {
    // JSON parser errors can include fragments of the file, which carries
    // credentials. Fail the launch visibly without exposing raw contents.
    throw new Error(
      "Could not load the generated Codex MCP configuration. Start a new session to regenerate it.",
    );
  }
  return {
    args,
    env,
    ...(aliases.length > 0
      ? {
          instructions: `Studio's per-session Sapiom MCP servers are: ${aliases.join(", ")}. Use these session-specific servers for Sapiom tools; they carry this session's configuration and credentials.`,
        }
      : {}),
  };
}
