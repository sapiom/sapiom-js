import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SETTINGS_GUARD_TIMEOUT_MS = 5_000;
const SETTINGS_GUARD_MODULE_ENV = "SAPIOM_MANAGED_AGENT_SETTINGS_SDK_URL";
const SETTINGS_GUARD_SCRIPT = `
const moduleUrl = process.env.${SETTINGS_GUARD_MODULE_ENV};
if (!moduleUrl) throw new Error("missing sdk module url");
const { resolveSettings } = await import(moduleUrl);
const resolved = await resolveSettings({ cwd: process.cwd(), settingSources: [] });
const isRecord = (candidate) =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
if (
  !isRecord(resolved) ||
  !isRecord(resolved.effective) ||
  !Array.isArray(resolved.sources) ||
  !resolved.sources.every((source) => isRecord(source) && isRecord(source.settings))
) {
  throw new Error("malformed resolved settings");
}
const value = resolved?.effective?.disableAllHooks;
const settings = [resolved.effective, ...resolved.sources.map((source) => source.settings)];
const policyHelperConfigured = settings.some((candidate) =>
  candidate && (candidate.policyHelper !== undefined || candidate.policyHelpers !== undefined)
);
if (value !== undefined && typeof value !== "boolean") {
  throw new Error("malformed disableAllHooks setting");
}
process.stdout.write(JSON.stringify({
  contractVersion: 1,
  disableAllHooks: value === true,
  policyHelperConfigured,
}));
`;

const CREDENTIAL_AND_GATEWAY_ENVIRONMENT = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BASE_URL",
]);

export class ManagedAgentSettingsGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedAgentSettingsGuardError";
  }
}

export interface ManagedAgentSettingsGuardInput {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Explicit Node executable seam for future packaged hosts. E0.4 intentionally
   * does not certify Electron-as-Node; E0.7 owns that packaging proof.
   */
  readonly nodeExecutable?: string;
}

export interface ManagedAgentSettingsGuardDependencies {
  readonly run?: (input: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly nodeExecutable?: string;
  }) => Promise<{ readonly stdout: string }>;
}

export function buildManagedAgentSettingsGuardEnvironment(
  childEnvironment: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(childEnvironment).filter(
      ([name]) => !CREDENTIAL_AND_GATEWAY_ENVIRONMENT.has(name),
    ),
  );
}

async function runSettingsResolver(input: {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly nodeExecutable?: string;
}): Promise<{ readonly stdout: string }> {
  const sdkModulePath = createRequire(import.meta.url).resolve(
    "@anthropic-ai/claude-agent-sdk",
  );
  const environment = {
    ...input.environment,
    [SETTINGS_GUARD_MODULE_ENV]: pathToFileURL(sdkModulePath).href,
  };
  try {
    const result = await execFileAsync(
      input.nodeExecutable ?? process.execPath,
      ["--input-type=module", "--eval", SETTINGS_GUARD_SCRIPT],
      {
        cwd: input.cwd,
        env: environment,
        timeout: SETTINGS_GUARD_TIMEOUT_MS,
        maxBuffer: 4_096,
        windowsHide: true,
      },
    );
    return { stdout: result.stdout };
  } catch {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hook settings could not be resolved",
    );
  }
}

/**
 * Resolve managed settings in an isolated, credential-free subprocess before
 * query construction. Any uncertain result fails closed.
 */
export async function assertManagedAgentHooksEnabled(
  input: ManagedAgentSettingsGuardInput,
  dependencies: ManagedAgentSettingsGuardDependencies = {},
): Promise<void> {
  if (process.versions.electron && !input.nodeExecutable) {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent settings guard requires an explicit Node executable in Electron",
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await (dependencies.run ?? runSettingsResolver)(input));
  } catch (error) {
    if (error instanceof ManagedAgentSettingsGuardError) throw error;
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hook settings could not be resolved",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hook settings result was malformed",
    );
  }
  const result =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (
    !result ||
    result.contractVersion !== 1 ||
    typeof result.disableAllHooks !== "boolean" ||
    typeof result.policyHelperConfigured !== "boolean" ||
    Object.keys(result).some(
      (key) =>
        key !== "contractVersion" &&
        key !== "disableAllHooks" &&
        key !== "policyHelperConfigured",
    )
  ) {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hook settings result was malformed",
    );
  }
  if (result.disableAllHooks) {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hooks are disabled by managed settings",
    );
  }
  if (result.policyHelperConfigured) {
    throw new ManagedAgentSettingsGuardError(
      "Managed-agent hook settings use an unresolved policy helper",
    );
  }
}
