import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CanUseTool,
  HookCallback,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ManagedAgentOperationId,
  ManagedAgentPathRole,
  ManagedAgentPathRoleBinding,
  ManagedAgentPermissionEvidence,
  ManagedAgentPermissionReason,
  ManagedAgentPermissionSource,
  ManagedAgentPreToolUseGuardRejectionReason,
} from "./types.js";
import {
  MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH,
  isBoundedManagedAgentToolUseId,
  normalizeManagedAgentToolUseId,
  sanitizeManagedAgentToolName,
} from "./events.js";

export const MANAGED_AGENT_BUILTIN_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
] as const;

export const MANAGED_AGENT_DISALLOWED_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "NotebookEdit",
  "SendMessage",
  "Skill",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
] as const;

export class ManagedAgentPathError extends Error {
  public constructor(
    public readonly reason:
      | "invalid_input"
      | "path_outside_workspace"
      | "path_symlink_escape",
  ) {
    super(reason);
    this.name = "ManagedAgentPathError";
  }
}

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const pathRelative = relative(
    comparisonPath(root),
    comparisonPath(candidate),
  );
  if (pathRelative === "") return true;
  return (
    !isAbsolute(pathRelative) &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`)
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
      ? Promise.reject(error)
      : false;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let cursor = path;
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new ManagedAgentPathError("path_outside_workspace");
    }
    cursor = parent;
  }
  return cursor;
}

/**
 * Resolve an SDK tool target through the filesystem before authorizing it.
 * Existing symlinks are followed with realpath; new targets are authorized
 * only when their nearest existing parent resolves inside the canonical root.
 */
export async function resolveManagedAgentToolPath(
  canonicalWorkspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new ManagedAgentPathError("invalid_input");
  }
  const candidate = resolve(canonicalWorkspaceRoot, requestedPath);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, candidate)) {
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  const existing = await nearestExistingParent(candidate);
  const canonicalExisting = await realpath(existing);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, canonicalExisting)) {
    throw new ManagedAgentPathError("path_symlink_escape");
  }
  if (existing === candidate) return canonicalExisting;

  const unresolvedTail = relative(existing, candidate);
  const resolvedCandidate = resolve(canonicalExisting, unresolvedTail);
  if (!isPathWithinRoot(canonicalWorkspaceRoot, resolvedCandidate)) {
    throw new ManagedAgentPathError("path_outside_workspace");
  }
  return resolvedCandidate;
}

export interface ManagedAgentPolicyBoundaryOptions {
  readonly canonicalWorkspaceRoot: string;
  /** Scenario-specific built-ins; L2 deliberately exposes only exact Bash. */
  readonly allowedBuiltinTools?: readonly string[];
  readonly allowedBashCommands: readonly string[];
  readonly allowedMcpTools: readonly string[];
  /** Exact prompt literals mapped to content-free evidence roles. */
  readonly pathRoleBindings?: readonly ManagedAgentPathRoleBinding[];
  /** Certification mode denies file paths without a predeclared role. */
  readonly requireRegisteredFilePaths?: boolean;
  readonly onDecision: (evidence: ManagedAgentPermissionEvidence) => void;
  readonly onGuardRejection?: (
    diagnostic: ManagedAgentPreToolUseGuardRejection,
  ) => void;
  /** Test seam for proving cancellation after asynchronous path validation. */
  readonly resolveToolPath?: typeof resolveManagedAgentToolPath;
}

/** Internal correlation is normalized immediately and is removed from output. */
export interface ManagedAgentPreToolUseGuardRejection {
  readonly reason: ManagedAgentPreToolUseGuardRejectionReason;
  readonly toolName: string;
  readonly normalizedToolUseId?: string;
}

export interface ManagedAgentPolicyBoundary {
  /** Primary boundary: the SDK runs this before its own permission evaluation. */
  readonly preToolUseHook: HookCallback;
  /** Defense in depth when the SDK still surfaces an unresolved permission. */
  readonly canUseToolFallback: CanUseTool;
}

interface ManagedAgentPolicyDecision {
  readonly decision: "allow" | "deny";
  readonly reason: ManagedAgentPermissionReason;
  readonly operationId: ManagedAgentOperationId;
  readonly updatedInput?: Record<string, unknown>;
}

interface ManagedAgentRecordedPolicyDecision extends ManagedAgentPolicyDecision {
  readonly source: ManagedAgentPermissionSource;
}

function toolUseIdIssue(
  value: unknown,
  role: "input" | "callback",
): ManagedAgentPreToolUseGuardRejectionReason | undefined {
  if (role === "input" && value === undefined) {
    return "input_tool_use_id_missing";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return role === "input"
      ? "input_tool_use_id_invalid"
      : "callback_tool_use_id_invalid";
  }
  if (value.length > MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH) {
    return role === "input"
      ? "input_tool_use_id_too_long"
      : "callback_tool_use_id_too_long";
  }
  return undefined;
}

function permissionResult(
  policy: ManagedAgentPolicyDecision,
  toolUseID: string,
): PermissionResult {
  return policy.decision === "allow"
    ? {
        behavior: "allow",
        toolUseID,
        ...(policy.updatedInput
          ? { updatedInput: { ...policy.updatedInput } }
          : {}),
      }
    : {
        behavior: "deny",
        message: `Managed-agent permission denied: ${policy.reason}`,
        interrupt: false,
        toolUseID,
      };
}

function filePathFromInput(input: Record<string, unknown>): string | undefined {
  return typeof input.file_path === "string" && input.file_path.length > 0
    ? input.file_path
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MANAGED_AGENT_BASH_INPUT_KEYS = new Set([
  "command",
  "timeout",
  "description",
  "run_in_background",
  "dangerouslyDisableSandbox",
]);
const MANAGED_AGENT_BASH_TIMEOUT_MAX_MS = 600_000;

interface ManagedAgentNormalizedBashInput {
  readonly command: string;
}

/**
 * Accept the pinned SDK's Bash input shape, but retain only the exact command
 * that the host authorizes and executes. Model-authored execution controls are
 * either harmless metadata that is stripped or unsafe values that fail closed.
 */
function normalizeManagedAgentBashInput(
  rawInput: unknown,
): ManagedAgentNormalizedBashInput | undefined {
  const input = asRecord(rawInput);
  if (
    !input ||
    !Object.prototype.hasOwnProperty.call(input, "command") ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" || !MANAGED_AGENT_BASH_INPUT_KEYS.has(key),
    )
  ) {
    return undefined;
  }

  const command = input.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  if (
    input.description !== undefined &&
    typeof input.description !== "string"
  ) {
    return undefined;
  }
  if (
    input.timeout !== undefined &&
    (typeof input.timeout !== "number" ||
      !Number.isInteger(input.timeout) ||
      input.timeout <= 0 ||
      input.timeout > MANAGED_AGENT_BASH_TIMEOUT_MAX_MS)
  ) {
    return undefined;
  }
  if (
    (input.run_in_background !== undefined &&
      input.run_in_background !== false) ||
    (input.dangerouslyDisableSandbox !== undefined &&
      input.dangerouslyDisableSandbox !== false)
  ) {
    return undefined;
  }

  return { command };
}

function denied(
  reason: ManagedAgentPermissionReason,
  operationId: ManagedAgentOperationId = "unknown",
): ManagedAgentPolicyDecision {
  return { decision: "deny", reason, operationId };
}

function fileOperationId(
  toolName: "Read" | "Edit" | "Write",
  role: ManagedAgentPathRole,
): ManagedAgentOperationId {
  return `${toolName.toLowerCase()}:${role}` as ManagedAgentOperationId;
}

function lexicalPathRoleKey(
  canonicalWorkspaceRoot: string,
  requestedPath: string,
): string {
  return comparisonPath(resolve(canonicalWorkspaceRoot, requestedPath));
}

function classifyManagedAgentOperation(
  canonicalWorkspaceRoot: string,
  toolName: string,
  rawInput: unknown,
  allowedCommands: ReadonlySet<string>,
  pathRoles: ReadonlyMap<string, ManagedAgentPathRole>,
): ManagedAgentOperationId {
  const input = asRecord(rawInput);
  if (toolName === "Bash") {
    const normalizedInput = normalizeManagedAgentBashInput(rawInput);
    return normalizedInput && allowedCommands.has(normalizedInput.command)
      ? "bash:exact_command"
      : "bash:unregistered";
  }
  if (toolName.endsWith("__echo_nonce")) return "mcp:echo_nonce";
  if (toolName.endsWith("__fail_once")) return "mcp:fail_once";
  if (toolName.startsWith("mcp__")) return "mcp:managed";
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    const requestedPath = input ? filePathFromInput(input) : undefined;
    const role = requestedPath
      ? (pathRoles.get(
          lexicalPathRoleKey(canonicalWorkspaceRoot, requestedPath),
        ) ?? "unregistered")
      : "unregistered";
    return fileOperationId(toolName, role);
  }
  return "unknown";
}

async function evaluateManagedAgentPolicy(
  options: ManagedAgentPolicyBoundaryOptions,
  allowedBuiltinTools: ReadonlySet<string>,
  allowedCommands: ReadonlySet<string>,
  allowedMcpTools: ReadonlySet<string>,
  pathRoles: ReadonlyMap<string, ManagedAgentPathRole>,
  toolName: string,
  rawInput: unknown,
  signal: AbortSignal,
): Promise<ManagedAgentPolicyDecision> {
  const operationId = classifyManagedAgentOperation(
    options.canonicalWorkspaceRoot,
    toolName,
    rawInput,
    allowedCommands,
    pathRoles,
  );
  if (signal.aborted) return denied("policy_aborted", operationId);
  if (!allowedBuiltinTools.has(toolName) && !allowedMcpTools.has(toolName)) {
    return denied("tool_not_allowed", operationId);
  }
  const input = asRecord(rawInput);
  if (!input) return denied("invalid_input", operationId);

  if (allowedMcpTools.has(toolName)) {
    return signal.aborted
      ? denied("policy_aborted", operationId)
      : {
          decision: "allow",
          reason: "managed_mcp_tool",
          operationId,
          updatedInput: { ...input },
        };
  }
  if (toolName === "Bash") {
    const normalizedInput = normalizeManagedAgentBashInput(input);
    if (!normalizedInput) return denied("invalid_input", operationId);
    if (!allowedCommands.has(normalizedInput.command)) {
      return denied("bash_command_not_allowed", operationId);
    }
    return signal.aborted
      ? denied("policy_aborted", operationId)
      : {
          decision: "allow",
          reason: "exact_bash_command",
          operationId,
          updatedInput: { command: normalizedInput.command },
        };
  }
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    const requestedPath = filePathFromInput(input);
    if (!requestedPath) return denied("invalid_input", operationId);
    if (
      options.requireRegisteredFilePaths &&
      operationId.endsWith(":unregistered")
    ) {
      return denied("path_role_not_allowed", operationId);
    }
    try {
      const canonicalPath = await (
        options.resolveToolPath ?? resolveManagedAgentToolPath
      )(options.canonicalWorkspaceRoot, requestedPath);
      if (signal.aborted) return denied("policy_aborted", operationId);
      return {
        decision: "allow",
        reason: "fixture_path",
        operationId,
        updatedInput: { ...input, file_path: canonicalPath },
      };
    } catch (error) {
      if (signal.aborted) return denied("policy_aborted", operationId);
      return denied(
        error instanceof ManagedAgentPathError ? error.reason : "invalid_input",
        operationId,
      );
    }
  }
  return denied("tool_not_allowed", operationId);
}

/**
 * Build one universal host policy shared by the primary PreToolUse hook and a
 * canUseTool fallback. Decisions are deduplicated by raw tool-use ID so one
 * attempted tool produces exactly one normalized evidence record.
 */
export function createManagedAgentPolicyBoundary(
  options: ManagedAgentPolicyBoundaryOptions,
): ManagedAgentPolicyBoundary {
  const allowedBuiltinTools = new Set(
    options.allowedBuiltinTools ?? MANAGED_AGENT_BUILTIN_TOOLS,
  );
  const allowedCommands = new Set(options.allowedBashCommands);
  const allowedMcpTools = new Set(options.allowedMcpTools);
  const pathRoles = new Map<string, ManagedAgentPathRole>();
  for (const binding of options.pathRoleBindings ?? []) {
    const key = lexicalPathRoleKey(
      options.canonicalWorkspaceRoot,
      binding.path,
    );
    if (pathRoles.has(key)) {
      throw new Error(
        "Managed-agent path role bindings must resolve to unique lexical paths",
      );
    }
    pathRoles.set(key, binding.role);
  }
  const decisions = new Map<
    string,
    {
      readonly source: ManagedAgentPermissionSource;
      readonly pending: Promise<ManagedAgentRecordedPolicyDecision>;
    }
  >();

  const recordGuardRejection = (
    reason: ManagedAgentPreToolUseGuardRejectionReason,
    toolName: unknown,
    inputToolUseID?: unknown,
  ): void => {
    options.onGuardRejection?.({
      reason,
      toolName: sanitizeManagedAgentToolName(toolName),
      ...(isBoundedManagedAgentToolUseId(inputToolUseID)
        ? {
            normalizedToolUseId: normalizeManagedAgentToolUseId(inputToolUseID),
          }
        : {}),
    });
  };

  const decide = async (
    toolUseID: string,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
    source: ManagedAgentPermissionSource,
  ): Promise<ManagedAgentRecordedPolicyDecision> => {
    const attemptedOperationId = classifyManagedAgentOperation(
      options.canonicalWorkspaceRoot,
      toolName,
      input,
      allowedCommands,
      pathRoles,
    );
    const existing = decisions.get(toolUseID);
    if (existing) {
      if (signal.aborted) {
        return { ...denied("policy_aborted", attemptedOperationId), source };
      }
      // The only valid duplicate is the SDK consulting canUseTool after the
      // primary hook. A repeated primary ID or fallback-first sequence is
      // ambiguous and must never inherit an earlier allow decision.
      return source === "can_use_tool_fallback" &&
        existing.source === "pre_tool_use"
        ? existing.pending
        : { ...denied("invalid_input", attemptedOperationId), source };
    }
    const pending = evaluateManagedAgentPolicy(
      options,
      allowedBuiltinTools,
      allowedCommands,
      allowedMcpTools,
      pathRoles,
      toolName,
      input,
      signal,
    ).then((policy) => {
      const recorded = { ...policy, source };
      options.onDecision({
        toolUseId: normalizeManagedAgentToolUseId(toolUseID),
        toolName: sanitizeManagedAgentToolName(toolName),
        decision: recorded.decision,
        reason: recorded.reason,
        source,
        operationId: recorded.operationId,
      });
      return recorded;
    });
    decisions.set(toolUseID, { source, pending });
    return pending;
  };

  const preToolUseHook: HookCallback = async (
    input,
    callbackToolUseID,
    { signal },
  ) => {
    const isPreToolUse = input.hook_event_name === "PreToolUse";
    if (!isPreToolUse) {
      recordGuardRejection("unexpected_hook_event", undefined);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Managed-agent policy: invalid_input",
        },
      };
    }
    const inputToolUseID = input.tool_use_id;
    const inputIssue = toolUseIdIssue(inputToolUseID, "input");
    if (inputIssue || !isBoundedManagedAgentToolUseId(inputToolUseID)) {
      recordGuardRejection(
        inputIssue ?? "input_tool_use_id_invalid",
        input.tool_name,
      );
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Managed-agent policy: invalid_input",
        },
      };
    }
    if (callbackToolUseID !== undefined) {
      const callbackIssue = toolUseIdIssue(callbackToolUseID, "callback");
      if (callbackIssue || !isBoundedManagedAgentToolUseId(callbackToolUseID)) {
        recordGuardRejection(
          callbackIssue ?? "callback_tool_use_id_invalid",
          input.tool_name,
          inputToolUseID,
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Managed-agent policy: invalid_input",
          },
        };
      }
      if (callbackToolUseID !== inputToolUseID) {
        recordGuardRejection(
          "callback_tool_use_id_mismatch",
          input.tool_name,
          inputToolUseID,
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Managed-agent policy: invalid_input",
          },
        };
      }
    }
    const toolUseID = inputToolUseID;
    const policy = await decide(
      toolUseID,
      input.tool_name,
      input.tool_input,
      signal,
      "pre_tool_use",
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: policy.decision,
        permissionDecisionReason: `Managed-agent policy: ${policy.reason}`,
        ...(policy.decision === "allow" && policy.updatedInput
          ? { updatedInput: { ...policy.updatedInput } }
          : {}),
      },
    };
  };

  const canUseToolFallback: CanUseTool = async (
    toolName,
    input,
    permission,
  ) => {
    if (!isBoundedManagedAgentToolUseId(permission.toolUseID)) {
      return permissionResult(denied("invalid_input"), permission.toolUseID);
    }
    return permissionResult(
      await decide(
        permission.toolUseID,
        toolName,
        input,
        permission.signal,
        "can_use_tool_fallback",
      ),
      permission.toolUseID,
    );
  };

  return { preToolUseHook, canUseToolFallback };
}
