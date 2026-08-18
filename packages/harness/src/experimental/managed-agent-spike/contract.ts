import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ManagedAgentL1FinalByteRole,
  ManagedAgentModelTarget,
  ManagedAgentModelTargetId,
  ManagedAgentProbeConfig,
  ManagedAgentRegisteredPathRole,
} from "./types.js";

/**
 * Pinned to the Epic 0 certification manifest in the Sapiom gateway repo:
 * llm-gateway/streaming-replay/certification/manifest.v1.json.
 */
export const MANAGED_AGENT_CONTRACT = {
  contractVersion: 1,
  agentSdkVersion: "0.3.228",
  claudeCodeRuntimeVersion: "2.1.228",
  certificationNodeVersion: "22.23.2",
  suiteVersion: "0.1.0",
  directGatewayOrigin: "https://litellm.services.sapiom.ai",
  maxBudgetUsd: 1,
  maxTurns: 20,
} as const;

export const MANAGED_AGENT_L1_CERTIFICATION_CONTRACT = Object.freeze({
  contractVersion: 2 as const,
  promptVersion: "managed-agent-l1-prompt-v2" as const,
  promptMarker: "SAPIOM_MANAGED_AGENT_L1_PROMPT_V2" as const,
  evaluatorVersion: "managed-agent-l1-evaluator-v2" as const,
});

export const MANAGED_AGENT_L1_REGISTERED_PATH_ROLES = Object.freeze([
  "clean_target",
  "dirty_sentinel",
  "untracked_sentinel",
  "managed_output",
  "outside_sentinel",
  "escape_link",
] as const satisfies readonly ManagedAgentRegisteredPathRole[]);

export const MANAGED_AGENT_L1_FINAL_BYTE_ROLES = Object.freeze([
  "clean_target",
  "managed_output",
] as const satisfies readonly ManagedAgentL1FinalByteRole[]);

export const MANAGED_AGENT_MODEL_TARGETS: Readonly<
  Record<ManagedAgentModelTargetId, ManagedAgentModelTarget>
> = {
  "sonnet-5": {
    id: "sonnet-5",
    alias: "claude-sonnet-5-anthropic-anthropic-eval",
    upstreamProvider: "anthropic",
    upstreamModel: "claude-sonnet-5",
  },
  "minimax-m3": {
    id: "minimax-m3",
    alias: "minimax-m3-fireworks-sapiom-fireworks_ai-eval",
    upstreamProvider: "fireworks_ai",
    upstreamModel: "accounts/sapiom-o7kbok9g48o6/routers/minimax-m3",
  },
};

export const MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export const MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SAPIOM_API_KEY",
] as const;

export class ManagedAgentConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedAgentConfigurationError";
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  if (pathRelative === "") return true;
  return (
    !isAbsolute(pathRelative) &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`)
  );
}

function canonicalDirectory(value: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(value));
  } catch {
    throw new ManagedAgentConfigurationError(`${label} must exist`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new ManagedAgentConfigurationError(`${label} must be a directory`);
  }
  return canonical;
}

export function normalizeManagedAgentGatewayOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManagedAgentConfigurationError(
      "gatewayOrigin must be a valid HTTP(S) origin",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ManagedAgentConfigurationError(
      "gatewayOrigin must use HTTP or HTTPS",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new ManagedAgentConfigurationError(
      "gatewayOrigin must not contain credentials, a path, query parameters, or a fragment",
    );
  }
  return parsed.origin;
}

export function assertManagedAgentDirectGatewayOrigin(value: string): string {
  const normalized = normalizeManagedAgentGatewayOrigin(value);
  if (normalized !== MANAGED_AGENT_CONTRACT.directGatewayOrigin) {
    throw new ManagedAgentConfigurationError(
      "gatewayOrigin must match the pinned direct Sapiom gateway origin",
    );
  }
  return normalized;
}

export function normalizeManagedAgentHermeticGatewayOrigin(
  value: string,
): string {
  const normalized = normalizeManagedAgentGatewayOrigin(value);
  const { hostname } = new URL(normalized);
  const isTestHostname = hostname.endsWith(".test");
  const isLoopbackHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
  if (!isTestHostname && !isLoopbackHostname) {
    throw new ManagedAgentConfigurationError(
      "hermeticGatewayOrigin must use a reserved .test or loopback hostname",
    );
  }
  return normalized;
}

export function resolveManagedAgentModelTarget(
  target: ManagedAgentModelTargetId,
): ManagedAgentModelTarget {
  const resolved = MANAGED_AGENT_MODEL_TARGETS[target];
  if (!resolved) {
    throw new ManagedAgentConfigurationError(
      `Unknown managed-agent model target: ${String(target)}`,
    );
  }
  return resolved;
}

export interface ValidatedManagedAgentProbeConfig {
  readonly config: ManagedAgentProbeConfig;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalConfigRoot: string;
  readonly gatewayOrigin: string;
  readonly model: ManagedAgentModelTarget;
}

export interface ManagedAgentProbeValidationOptions {
  /**
   * Test-only escape hatch for an injected query factory. The origin must be
   * reserved under .test or use an explicit loopback hostname/address.
   */
  readonly hermeticGatewayOrigin?: string;
}

export function validateManagedAgentProbeConfig(
  config: ManagedAgentProbeConfig,
  options: ManagedAgentProbeValidationOptions = {},
): ValidatedManagedAgentProbeConfig {
  const canonicalWorkspaceRoot = canonicalDirectory(
    config.workspaceRoot,
    "workspaceRoot",
  );
  const canonicalConfigRoot = canonicalDirectory(
    config.configRoot,
    "configRoot",
  );
  if (
    pathWithin(canonicalWorkspaceRoot, canonicalConfigRoot) ||
    pathWithin(canonicalConfigRoot, canonicalWorkspaceRoot)
  ) {
    throw new ManagedAgentConfigurationError(
      "workspaceRoot and configRoot must be disjoint directories",
    );
  }
  if (!config.gatewayCredential.trim()) {
    throw new ManagedAgentConfigurationError("gatewayCredential is required");
  }
  if (!config.prompt.trim()) {
    throw new ManagedAgentConfigurationError("prompt is required");
  }
  if (config.scenario === "L1") {
    if (
      config.prompt.split("\n", 1)[0] !==
      MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.promptMarker
    ) {
      throw new ManagedAgentConfigurationError(
        "L1 prompt must use the frozen managed-agent-l1-prompt-v2 marker",
      );
    }
    const roles = config.pathRoleBindings.map(({ role }) => role);
    const paths = config.pathRoleBindings.map(({ path }) => path);
    if (
      roles.length !== MANAGED_AGENT_L1_REGISTERED_PATH_ROLES.length ||
      new Set(roles).size !== roles.length ||
      new Set(paths).size !== paths.length ||
      MANAGED_AGENT_L1_REGISTERED_PATH_ROLES.some(
        (role) => !roles.includes(role),
      ) ||
      paths.some((path) => !path || path.includes("\0") || /[\r\n]/.test(path))
    ) {
      throw new ManagedAgentConfigurationError(
        "L1 pathRoleBindings must bind each frozen fixture role exactly once",
      );
    }
    const finalByteRoles = config.expectedL1FinalBytes.map(({ role }) => role);
    if (
      finalByteRoles.length !== MANAGED_AGENT_L1_FINAL_BYTE_ROLES.length ||
      new Set(finalByteRoles).size !== finalByteRoles.length ||
      MANAGED_AGENT_L1_FINAL_BYTE_ROLES.some(
        (role) => !finalByteRoles.includes(role),
      ) ||
      config.expectedL1FinalBytes.some(
        ({ path, role, sha256 }) =>
          !/^[a-f0-9]{64}$/.test(sha256) ||
          !config.pathRoleBindings.some(
            (binding) => binding.role === role && binding.path === path,
          ),
      )
    ) {
      throw new ManagedAgentConfigurationError(
        "L1 expectedL1FinalBytes must bind exact hashes to the clean target and managed output roles",
      );
    }
  } else if (
    config.pathRoleBindings.length !== 0 ||
    config.expectedL1FinalBytes.length !== 0
  ) {
    throw new ManagedAgentConfigurationError(
      "L2 must not configure file path roles or L1 final-byte expectations",
    );
  }
  if (
    config.scenario === "L1" &&
    (!config.expectedMcpNonce ||
      config.expectedMcpNonce.length > 256 ||
      /[\r\n]/.test(config.expectedMcpNonce))
  ) {
    throw new ManagedAgentConfigurationError(
      "L1 expectedMcpNonce must be a non-empty, single-line value of at most 256 characters",
    );
  }
  if (
    !Number.isInteger(config.maxTurns) ||
    config.maxTurns < 1 ||
    config.maxTurns > MANAGED_AGENT_CONTRACT.maxTurns
  ) {
    throw new ManagedAgentConfigurationError(
      `maxTurns must be an integer between 1 and ${MANAGED_AGENT_CONTRACT.maxTurns}`,
    );
  }
  if (
    !Number.isFinite(config.maxBudgetUsd) ||
    config.maxBudgetUsd <= 0 ||
    config.maxBudgetUsd > MANAGED_AGENT_CONTRACT.maxBudgetUsd
  ) {
    throw new ManagedAgentConfigurationError(
      `maxBudgetUsd must be greater than zero and no more than ${MANAGED_AGENT_CONTRACT.maxBudgetUsd}`,
    );
  }
  if (
    config.allowedBashCommands.some(
      (command) => !command || /[\r\n]/.test(command),
    )
  ) {
    throw new ManagedAgentConfigurationError(
      "allowedBashCommands must contain non-empty, single-line commands",
    );
  }
  const gatewayOrigin = normalizeManagedAgentGatewayOrigin(
    config.gatewayOrigin,
  );
  const expectedGatewayOrigin = options.hermeticGatewayOrigin
    ? normalizeManagedAgentHermeticGatewayOrigin(options.hermeticGatewayOrigin)
    : MANAGED_AGENT_CONTRACT.directGatewayOrigin;
  if (gatewayOrigin !== expectedGatewayOrigin) {
    throw new ManagedAgentConfigurationError(
      options.hermeticGatewayOrigin
        ? "gatewayOrigin must match the explicit hermetic gateway origin"
        : "gatewayOrigin must match the pinned direct Sapiom gateway origin",
    );
  }
  return {
    config,
    canonicalWorkspaceRoot,
    canonicalConfigRoot,
    gatewayOrigin,
    model: resolveManagedAgentModelTarget(config.target),
  };
}
