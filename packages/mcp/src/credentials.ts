import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_APP_URL = "https://app.sapiom.ai";
const DEFAULT_API_URL = "https://api.sapiom.ai";
const DEFAULT_ENVIRONMENT = "production";

/** Stored credentials for a single Sapiom environment. */
export interface CredentialEntry {
  /** Sapiom API key used to authenticate requests. */
  apiKey: string;
  /** Tenant ID the credentials belong to. */
  tenantId: string;
  /** Human-readable organization name. */
  organizationName: string;
  /** Unique identifier of the API key (not the secret itself). */
  apiKeyId: string;
}

/** Configuration for a single Sapiom environment as stored on disk. */
export interface EnvironmentConfig {
  /** Sapiom web app URL (e.g. `https://app.sapiom.ai`). */
  appURL: string;
  /** Sapiom API URL (e.g. `https://api.sapiom.ai`). */
  apiURL: string;
  /** Optional map of service name to base URL overrides. */
  services?: Record<string, string>;
  /** Stored credentials, if the user has authenticated in this environment. */
  credentials?: CredentialEntry;
}

/** On-disk shape of `~/.sapiom/credentials.json`. */
export interface CredentialsFile {
  /** Name of the currently active environment. */
  currentEnvironment: string;
  /** Map of environment name to its configuration. */
  environments: Record<string, EnvironmentConfig>;
}

/** Fully resolved environment configuration used at runtime. */
export interface ResolvedEnvironment {
  /** Environment name (e.g. `"production"`). */
  name: string;
  /** Sapiom web app URL. */
  appURL: string;
  /** Sapiom API URL. */
  apiURL: string;
  /** Service URL overrides (empty object when none are configured). */
  services: Record<string, string>;
  /** Stored credentials, or `null` if not yet authenticated. */
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
 * Priority: SAPIOM_ENVIRONMENT env var > file's currentEnvironment > "production"
 *
 * If the file doesn't exist and environment is "production", returns hardcoded defaults.
 * If the file doesn't exist and environment is custom, throws (file must define custom envs).
 */
export async function resolveEnvironment(
  envOverride?: string,
): Promise<ResolvedEnvironment> {
  const file = await readCredentialsFile();
  const name = envOverride ?? file?.currentEnvironment ?? DEFAULT_ENVIRONMENT;

  // Look up in file
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

  // Environment not in file — use production defaults or error
  if (name === DEFAULT_ENVIRONMENT) {
    return {
      name,
      appURL: DEFAULT_APP_URL,
      apiURL: DEFAULT_API_URL,
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

/**
 * Read stored credentials for the given environment.
 *
 * @param envName - Environment name to look up.
 * @returns The stored credentials, or `null` if none exist.
 */
export async function readCredentials(
  envName: string,
): Promise<CredentialEntry | null> {
  const file = await readCredentialsFile();
  return file?.environments[envName]?.credentials ?? null;
}

/**
 * Persist credentials for the given environment to `~/.sapiom/credentials.json`.
 *
 * Creates the file and directory if they don't exist. Sets the active
 * environment to {@link envName}.
 *
 * @param envName - Environment name to write to.
 * @param appURL - Sapiom web app URL for this environment.
 * @param apiURL - Sapiom API URL for this environment.
 * @param entry - Credentials to store.
 */
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

/**
 * Remove stored credentials for the given environment.
 *
 * No-op if no credentials are stored for the environment.
 *
 * @param envName - Environment name whose credentials should be cleared.
 */
export async function clearCredentials(envName: string): Promise<void> {
  const existing = await readCredentialsFile();
  if (!existing?.environments[envName]?.credentials) return;

  delete existing.environments[envName].credentials;

  await writeCredentialsFile(existing);
}
