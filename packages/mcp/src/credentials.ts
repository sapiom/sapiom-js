import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_APP_URL = "https://app.sapiom.ai";
const DEFAULT_API_URL = "https://api.sapiom.ai";
const DEFAULT_ENVIRONMENT = "production";

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
