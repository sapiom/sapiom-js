import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_ENVIRONMENT = "production";

/** Friendly aliases → canonical environment name. */
const ENVIRONMENT_ALIASES: Record<string, string> = {
  prod: "production",
  dev: "staging",
};

/**
 * Built-in environment presets, so the common targets resolve to the right URLs
 * without anyone hand-editing `~/.sapiom/credentials.json`. A matching
 * environment defined in the file always takes precedence over a preset (so a
 * custom override, or one carrying credentials, still wins).
 */
const ENVIRONMENT_PRESETS: Record<string, { appURL: string; apiURL: string }> = {
  production: { appURL: "https://app.sapiom.ai", apiURL: "https://api.sapiom.ai" },
  staging: { appURL: "https://app.sapiom.dev", apiURL: "https://api.sapiom.dev" },
};

function canonicalEnvironmentName(name: string): string {
  return ENVIRONMENT_ALIASES[name] ?? name;
}

export interface CredentialEntry {
  apiKey: string;
  tenantId: string;
  organizationName: string;
  apiKeyId: string;
}

export interface EnvironmentConfig {
  appURL: string;
  apiURL: string;
  services?: Record<string, string>;
  credentials?: CredentialEntry;
}

export interface CredentialsFile {
  currentEnvironment: string;
  environments: Record<string, EnvironmentConfig>;
}

export interface ResolvedEnvironment {
  name: string;
  appURL: string;
  apiURL: string;
  services: Record<string, string>;
  credentials: CredentialEntry | null;
}

function getCredentialsPath(): string {
  return path.join(os.homedir(), ".sapiom", "credentials.json");
}

async function readCredentialsFile(): Promise<CredentialsFile | null> {
  try {
    const content = await fs.readFile(getCredentialsPath(), "utf-8");
    return JSON.parse(content) as CredentialsFile;
  } catch {
    return null;
  }
}

async function writeCredentialsFile(file: CredentialsFile): Promise<void> {
  const filePath = getCredentialsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Resolve the active environment configuration.
 *
 * Priority: SAPIOM_ENVIRONMENT env var > file's currentEnvironment > "production".
 * The names `prod` and `dev` are accepted as aliases for `production` and
 * `staging`.
 *
 * Resolution order for the chosen environment:
 *   1. A matching entry in `~/.sapiom/credentials.json` (carries URLs + creds).
 *   2. A built-in preset (`production`, `staging`) — no file edit required.
 *   3. Otherwise throws (a custom environment must be defined in the file).
 */
export async function resolveEnvironment(
  envOverride?: string,
): Promise<ResolvedEnvironment> {
  const file = await readCredentialsFile();
  const name = canonicalEnvironmentName(
    envOverride ?? file?.currentEnvironment ?? DEFAULT_ENVIRONMENT,
  );

  // A matching environment in the file always wins.
  const envConfig = file?.environments[name];
  if (envConfig) {
    return {
      name,
      appURL: envConfig.appURL,
      apiURL: envConfig.apiURL,
      services: envConfig.services ?? {},
      credentials: envConfig.credentials ?? null,
    };
  }

  // Otherwise fall back to a built-in preset (no creds file needed).
  const preset = ENVIRONMENT_PRESETS[name];
  if (preset) {
    return {
      name,
      appURL: preset.appURL,
      apiURL: preset.apiURL,
      services: {},
      credentials: null,
    };
  }

  throw new Error(
    `Unknown environment "${name}". Define it in ~/.sapiom/credentials.json:\n` +
      JSON.stringify(
        {
          currentEnvironment: name,
          environments: {
            [name]: {
              appURL: "http://localhost:2999",
              apiURL: "http://localhost:3000",
              services: {
                prelude: "http://localhost:3002",
              },
            },
          },
        },
        null,
        2,
      ),
  );
}

export async function readCredentials(
  envName: string,
): Promise<CredentialEntry | null> {
  const file = await readCredentialsFile();
  return file?.environments[envName]?.credentials ?? null;
}

export async function writeCredentials(
  envName: string,
  appURL: string,
  apiURL: string,
  entry: CredentialEntry,
): Promise<void> {
  const existing = (await readCredentialsFile()) ?? {
    currentEnvironment: envName,
    environments: {},
  };

  existing.currentEnvironment = envName;
  existing.environments[envName] = {
    ...existing.environments[envName],
    appURL,
    apiURL,
    credentials: entry,
  };

  await writeCredentialsFile(existing);
}

export async function clearCredentials(envName: string): Promise<void> {
  const existing = await readCredentialsFile();
  if (!existing?.environments[envName]?.credentials) return;

  delete existing.environments[envName].credentials;

  await writeCredentialsFile(existing);
}
