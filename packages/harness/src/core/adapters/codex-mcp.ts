import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { LaunchOpts, SpawnSpec } from "../../shared/types.js";

type TomlValue = string | string[] | { [key: string]: TomlValue };

class InvalidMcpConfigError extends Error {}

// Studio emits these non-secret values to configure the authoring process.
// They belong on that server, especially Electron's process-mode flag.
const STDIO_SETTINGS = new Set([
  "ELECTRON_RUN_AS_NODE",
  "SAPIOM_ENVIRONMENT",
  "SAPIOM_HARNESS_VERSION",
]);

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
    throw new InvalidMcpConfigError("Invalid string map");
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
 * Known stdio settings stay on the MCP server. Credentials and other stdio
 * values reach Codex through its environment, never argv, and are cleared
 * from shell-tool environments. Per-variable overrides preserve the user's
 * other shell settings. No persistent `codex mcp add` registration is needed.
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
      throw new InvalidMcpConfigError("Invalid environment name");
    }
    if (
      Object.prototype.hasOwnProperty.call(env, name) &&
      env[name] !== value
    ) {
      throw new InvalidMcpConfigError("Conflicting environment values");
    }
    env[name] = value;
  };
  const addServer = (name: string, config: Record<string, TomlValue>): void => {
    // Codex -c paths split on dots; restricting generated server names also
    // prevents a name from addressing another part of the user's config.
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new InvalidMcpConfigError("Invalid server name");
    const alias = `${name}-${suffix}`;
    aliases.push(`${name} is registered as ${alias}`);
    args.push("-c", `mcp_servers.${alias}=${toml(config)}`);
  };

  try {
    if (opts.mcpConfigFile) {
      const parsed: unknown = JSON.parse(
        readFileSync(opts.mcpConfigFile, "utf8"),
      );
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
        throw new InvalidMcpConfigError("Invalid MCP configuration");
      }
      for (const [index, [name, server]] of Object.entries(
        parsed.mcpServers,
      ).entries()) {
        // A freshly issued capability supplied separately wins over a copy
        // in the generated file. Keep compatibility with callers using only
        // agentMapMcp as well.
        if (name === "agent-map" && opts.agentMapMcp) continue;
        if (!isRecord(server))
          throw new InvalidMcpConfigError("Invalid server");
        if (server.type === "http") {
          if (
            typeof server.url !== "string" ||
            !/^https?:\/\//.test(server.url)
          ) {
            throw new InvalidMcpConfigError("Invalid HTTP URL");
          }
          if (
            Object.keys(server).some(
              (key) => !["type", "url", "headers"].includes(key),
            )
          ) {
            throw new InvalidMcpConfigError("Unsupported HTTP configuration");
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
            throw new InvalidMcpConfigError("Invalid stdio configuration");
          }
          const config: Record<string, TomlValue> = {
            command: server.command,
            ...(server.args !== undefined
              ? { args: server.args as string[] }
              : {}),
          };
          if (server.env !== undefined) {
            const values = stringRecord(server.env);
            const local: Record<string, string> = {};
            const forwarded: string[] = [];
            for (const [variable, value] of Object.entries(values)) {
              if (STDIO_SETTINGS.has(variable)) local[variable] = value;
              else {
                bindEnv(variable, value);
                forwarded.push(variable);
              }
            }
            if (Object.keys(local).length > 0) config.env = local;
            if (forwarded.length > 0) config.env_vars = forwarded;
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
  } catch (error) {
    // Parser and filesystem messages can contain credentials or private paths.
    const reason =
      error instanceof InvalidMcpConfigError
        ? error.message
        : error instanceof SyntaxError
          ? "Invalid JSON"
          : isRecord(error) &&
              ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
            ? String(error.code)
            : "Read failure";
    console.error(`[codex adapter] generated MCP configuration: ${reason}`);
    throw new Error(
      "Could not load the generated Codex MCP configuration. Start a new session to regenerate it.",
    );
  }
  // Codex's MCP clients read its process env; shell tools use a separate
  // policy. Blank only our forwarded values there, without replacing any
  // existing exclusions or unrelated user-provided environment settings.
  for (const variable of Object.keys(env)) {
    args.push("-c", `shell_environment_policy.set.${variable}=""`);
  }
  return {
    args,
    env,
    ...(aliases.length > 0
      ? {
          instructions: `Studio MCP server names for this session: ${aliases.join("; ")}. References to the original server names in your other instructions mean these session-specific registrations. Use their Sapiom tools; they carry this session's configuration and credentials.`,
        }
      : {}),
  };
}
