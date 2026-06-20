/**
 * Host and API key resolution for the orchestration MCP server.
 *
 * Mirrors the CLI's resolution order exactly so that config written by
 * `sapiom login` and `sapiom target` is shared with the MCP without
 * duplication. The CLI's config helpers are in `@sapiom/cli` (a sibling
 * package that we cannot import without creating a circular dep), so we
 * replicate only the stateless resolution logic here and point at the same
 * file paths under `~/.sapiom/`.
 *
 * Resolution order for host (highest priority first):
 *   1. SAPIOM_HOST env var
 *   2. SAPIOM_TARGET env var ("local" | "prod")
 *   3. host stored in ~/.sapiom/config.json
 *   4. target stored in ~/.sapiom/config.json
 *   5. project-level host from sapiom.json in cwd
 *   6. Production default
 *
 * Resolution order for API key (highest priority first):
 *   1. SAPIOM_API_KEY env var
 *   2. accessToken / apiKey stored in ~/.sapiom/credentials.json
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  createClient,
  readConfig,
  type GatewayClient,
} from "@sapiom/orchestration-core";

const PROD_HOST = "https://api.sapiom.ai";
const LOCAL_HOST = "http://localhost:3000";

// ── Path helpers (same conventions as @sapiom/cli) ───────────────────────────

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "sapiom") : path.join(homedir(), ".sapiom");
}

function configFilePath(): string {
  return path.join(configDir(), "config.json");
}

function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

// ── Config / credentials file shapes ─────────────────────────────────────────

interface CliConfig {
  target?: "prod" | "local";
  host?: string;
}

interface StoredCredential {
  apiKey?: string;
  accessToken?: string;
}

interface CredentialsFile {
  profiles: Record<string, StoredCredential>;
}

function loadCliConfig(): CliConfig {
  const file = configFilePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function loadStoredCredential(): StoredCredential | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialsFile;
    return parsed.profiles?.["default"] ?? null;
  } catch {
    return null;
  }
}

// ── Public resolution helpers ─────────────────────────────────────────────────

/**
 * Resolve the effective API host. The optional `projectDir` lets callers pass a
 * cwd so the project-level sapiom.json host can be considered.
 */
export function resolveHost(projectDir?: string): string {
  if (process.env.SAPIOM_HOST)
    return process.env.SAPIOM_HOST.replace(/\/$/, "");

  if (process.env.SAPIOM_TARGET) {
    return process.env.SAPIOM_TARGET === "local" ? LOCAL_HOST : PROD_HOST;
  }

  const cfg = loadCliConfig();
  if (cfg.host) return cfg.host.replace(/\/$/, "");
  if (cfg.target) return cfg.target === "local" ? LOCAL_HOST : PROD_HOST;

  if (projectDir) {
    const proj = readConfig(projectDir);
    if (proj?.host) return proj.host.replace(/\/$/, "");
  }

  return PROD_HOST;
}

/**
 * Resolve the API key from environment or stored credentials.
 * Throws a descriptive error when neither source yields a key.
 */
export function resolveApiKey(): string {
  if (process.env.SAPIOM_API_KEY) return process.env.SAPIOM_API_KEY;

  const stored = loadStoredCredential();
  const token = stored?.accessToken ?? stored?.apiKey;
  if (token) return token;

  throw new Error(
    "No Sapiom credentials found. Set SAPIOM_API_KEY or run: sapiom login",
  );
}

/**
 * Build a GatewayClient from the resolved host and API key.
 *
 * @param projectDir  Optional project directory; used for sapiom.json host fallback.
 */
export function makeClient(projectDir?: string): GatewayClient {
  const host = resolveHost(projectDir);
  const apiKey = resolveApiKey();
  return createClient({ host, apiKey });
}
