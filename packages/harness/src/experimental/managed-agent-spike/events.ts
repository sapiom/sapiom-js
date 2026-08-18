import { createHash } from "node:crypto";

import { MANAGED_AGENT_CONTRACT } from "./contract.js";
import type {
  ManagedAgentEventNormalizationFailureReason,
  ManagedAgentPermissionEvidence,
  ManagedAgentProbeEvent,
  ManagedAgentSdkModelEvidence,
  ManagedAgentSdkUsageEstimate,
  ManagedAgentTerminalClassification,
  ManagedAgentToolEvidence,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeSubtype(value: unknown): string | undefined {
  const subtype = optionalString(value);
  return subtype && /^[a-z0-9_-]{1,80}$/i.test(subtype) ? subtype : undefined;
}

const SAFE_TOOL_NAMES = new Set([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "mcp__sapiom-managed-agent-spike__echo_nonce",
  "mcp__sapiom-managed-agent-spike__fail_once",
]);
const NORMALIZED_TOOL_USE_ID_PATTERN = /^tool_[0-9a-f]{64}$/;
const SDK_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ASSISTANT_MESSAGE_ID_LENGTH = 512;
export const MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH = 512;

export class ManagedAgentEventError extends Error {
  public constructor(
    public readonly reason: ManagedAgentEventNormalizationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ManagedAgentEventError";
  }
}

export function sanitizeManagedAgentToolName(value: unknown): string {
  const toolName = optionalString(value);
  return toolName && SAFE_TOOL_NAMES.has(toolName) ? toolName : "unknown";
}

export function isBoundedManagedAgentToolUseId(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH
  );
}

export function normalizeManagedAgentToolUseId(value: unknown): string {
  if (!isBoundedManagedAgentToolUseId(value)) {
    throw new ManagedAgentEventError(
      "tool_request_id_invalid",
      "Managed-agent event has no bounded string tool-use id",
    );
  }
  if (NORMALIZED_TOOL_USE_ID_PATTERN.test(value)) {
    return value;
  }
  return `tool_${createHash("sha256")
    .update("sapiom-managed-agent-tool-use-id\0")
    .update(value)
    .digest("hex")}`;
}

function safeSdkSessionId(value: unknown): string | undefined {
  const sessionId = optionalString(value);
  return sessionId && SDK_SESSION_ID_PATTERN.test(sessionId)
    ? sessionId
    : undefined;
}

function normalizeAssistantMessageId(value: unknown): string {
  const messageId = optionalString(value);
  if (!messageId || messageId.length > MAX_ASSISTANT_MESSAGE_ID_LENGTH) {
    throw new ManagedAgentEventError(
      "assistant_message_id_invalid",
      "Assistant event has no bounded string message id",
    );
  }
  return createHash("sha256")
    .update("sapiom-managed-agent-assistant-message-id\0")
    .update(messageId)
    .digest("hex");
}

function boundedSdkNumTurns(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MANAGED_AGENT_CONTRACT.maxTurns
  ) {
    throw new ManagedAgentEventError(
      "sdk_num_turns_invalid",
      `SDK num_turns must be an integer between 0 and ${MANAGED_AGENT_CONTRACT.maxTurns}`,
    );
  }
  return Number(value);
}

function contentBlocks(message: JsonRecord | undefined): readonly JsonRecord[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((value) => {
    const block = asRecord(value);
    return block ? [block] : [];
  });
}

function sdkUsage(event: JsonRecord): ManagedAgentSdkUsageEstimate | undefined {
  const usage = asRecord(event.usage);
  const inputTokens = optionalNumber(usage?.input_tokens);
  const outputTokens = optionalNumber(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const estimatedCostUsd = optionalNumber(event.total_cost_usd);
  return {
    authority: "sdk_non_authoritative",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens:
      optionalNumber(usage?.cache_creation_input_tokens) ?? 0,
    cacheReadInputTokens: optionalNumber(usage?.cache_read_input_tokens) ?? 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

export class ManagedAgentEventRecorder {
  readonly #events: ManagedAgentProbeEvent[] = [];
  readonly #toolEvidence: ManagedAgentToolEvidence[] = [];
  readonly #permissionEvidence: ManagedAgentPermissionEvidence[] = [];
  readonly #inferenceMessageIds = new Set<string>();
  readonly #runId: string;
  readonly #expectedModelAlias: string;
  #terminalRecorded = false;
  #sessionId: string | undefined;
  #usage: ManagedAgentSdkUsageEstimate | undefined;
  #sdkNumTurns: number | undefined;
  #initModelObserved = false;
  #initModelMatchesExpectedAlias = false;
  #resultModelUsageObserved = false;
  #resultModelUsageMatchesExpectedAlias = false;
  #resultModelCount = 0;
  #sdkResult:
    | { readonly isError: boolean; readonly subtype?: string }
    | undefined;

  public constructor(runId: string, expectedModelAlias: string) {
    this.#runId = runId;
    this.#expectedModelAlias = expectedModelAlias;
  }

  public get events(): readonly ManagedAgentProbeEvent[] {
    return this.#events;
  }

  public get toolEvidence(): readonly ManagedAgentToolEvidence[] {
    return this.#toolEvidence;
  }

  public get permissionEvidence(): readonly ManagedAgentPermissionEvidence[] {
    return this.#permissionEvidence;
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public get usage(): ManagedAgentSdkUsageEstimate | undefined {
    return this.#usage;
  }

  public get modelEvidence(): ManagedAgentSdkModelEvidence {
    return {
      authority: "sdk_non_authoritative",
      initModelObserved: this.#initModelObserved,
      initModelMatchesExpectedAlias: this.#initModelMatchesExpectedAlias,
      resultModelUsageObserved: this.#resultModelUsageObserved,
      resultModelUsageMatchesExpectedAlias:
        this.#resultModelUsageMatchesExpectedAlias,
      resultModelCount: this.#resultModelCount,
    };
  }

  public get inferenceTurns(): number {
    return this.#inferenceMessageIds.size;
  }

  public get sdkNumTurns(): number | undefined {
    return this.#sdkNumTurns;
  }

  public get result():
    | { readonly isError: boolean; readonly subtype?: string }
    | undefined {
    return this.#sdkResult;
  }

  #append(event: Omit<ManagedAgentProbeEvent, "sequence" | "runId">): void {
    this.#events.push({
      sequence: this.#events.length + 1,
      runId: this.#runId,
      ...event,
    });
  }

  public recordLifecycle(subtype: string): void {
    this.#append({
      type: "lifecycle",
      subtype: safeSubtype(subtype) ?? "unknown",
    });
  }

  public recordPermission(evidence: ManagedAgentPermissionEvidence): void {
    const normalizedEvidence = {
      ...evidence,
      toolUseId: normalizeManagedAgentToolUseId(evidence.toolUseId),
      toolName: sanitizeManagedAgentToolName(evidence.toolName),
    } satisfies ManagedAgentPermissionEvidence;
    this.#permissionEvidence.push(normalizedEvidence);
    this.#append({
      type: "permission",
      toolUseId: normalizedEvidence.toolUseId,
      toolName: normalizedEvidence.toolName,
      permissionDecision: normalizedEvidence.decision,
      permissionReason: normalizedEvidence.reason,
      permissionSource: normalizedEvidence.source,
      operationId: normalizedEvidence.operationId,
    });
  }

  public observeSdkEvent(rawEvent: unknown): void {
    const event = asRecord(rawEvent);
    const type = optionalString(event?.type);
    if (!event || !type) return;
    const subtype = safeSubtype(event.subtype);
    const sessionId = safeSdkSessionId(event.session_id);
    if (sessionId && !this.#sessionId) this.#sessionId = sessionId;

    if (type === "system" && subtype === "init") {
      const initModel = optionalString(event.model);
      this.#initModelObserved = initModel !== undefined;
      this.#initModelMatchesExpectedAlias =
        initModel === this.#expectedModelAlias;
      this.#append({ type: "lifecycle", subtype: "sdk_init", sessionId });
      return;
    }

    const message = asRecord(event.message);
    const blocks = contentBlocks(message);
    if (type === "assistant") {
      this.#inferenceMessageIds.add(normalizeAssistantMessageId(message?.id));
      if (this.#inferenceMessageIds.size > MANAGED_AGENT_CONTRACT.maxTurns) {
        throw new ManagedAgentEventError(
          "inference_turn_limit_exceeded",
          `Distinct assistant message ids exceed ${MANAGED_AGENT_CONTRACT.maxTurns}`,
        );
      }
    }
    if (type === "assistant" || type === "user") {
      this.#append({ type: "message", subtype: type, sessionId });
    }
    if (type === "assistant") {
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        let toolUseId: string;
        try {
          toolUseId = normalizeManagedAgentToolUseId(block.id);
        } catch (error) {
          if (error instanceof ManagedAgentEventError) {
            throw new ManagedAgentEventError(
              "tool_request_id_invalid",
              error.message,
            );
          }
          throw error;
        }
        const toolName = sanitizeManagedAgentToolName(block.name);
        this.#toolEvidence.push({ toolUseId, toolName, status: "requested" });
        this.#append({
          type: "tool_requested",
          toolUseId,
          toolName,
          sessionId,
        });
      }
    }
    if (type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        let toolUseId: string;
        try {
          toolUseId = normalizeManagedAgentToolUseId(block.tool_use_id);
        } catch (error) {
          if (error instanceof ManagedAgentEventError) {
            throw new ManagedAgentEventError(
              "tool_result_id_invalid",
              error.message,
            );
          }
          throw error;
        }
        const isError = block.is_error === true;
        const matchingTool = [...this.#toolEvidence]
          .reverse()
          .find((tool) => tool.toolUseId === toolUseId);
        const toolName = matchingTool?.toolName ?? "unknown";
        this.#toolEvidence.push({
          toolUseId,
          toolName,
          status: isError ? "error" : "success",
        });
        this.#append({
          type: "tool_completed",
          toolUseId,
          toolName,
          isError,
          sessionId,
        });
      }
    }
    if (type === "result") {
      this.#sdkNumTurns = boundedSdkNumTurns(event.num_turns);
      const isError = event.is_error === true || subtype !== "success";
      this.#sdkResult = { isError, ...(subtype ? { subtype } : {}) };
      this.#usage = sdkUsage(event);
      const modelUsage = asRecord(event.modelUsage);
      const resultModels = modelUsage ? Object.keys(modelUsage) : [];
      this.#resultModelCount = resultModels.length;
      this.#resultModelUsageObserved = resultModels.length > 0;
      this.#resultModelUsageMatchesExpectedAlias =
        resultModels.length === 1 &&
        resultModels[0] === this.#expectedModelAlias;
      this.#append({
        type: "sdk_result",
        subtype,
        isError,
        sessionId,
      });
    }
  }

  public recordTerminal(terminal: ManagedAgentTerminalClassification): boolean {
    if (this.#terminalRecorded) return false;
    this.#terminalRecorded = true;
    this.#append({ type: "terminal", terminal, sessionId: this.#sessionId });
    return true;
  }
}
