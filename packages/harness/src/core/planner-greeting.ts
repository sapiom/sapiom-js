import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ProjectBootstrapErrorCode,
  ProjectBootstrapLifecycleEvent,
  ProjectBootstrapInputReceipt,
  ProjectBootstrapQueuedInput,
  ProjectBootstrapMetadata,
  ProjectAgentSession,
} from "../shared/agent-map.js";
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import {
  SessionBackgroundInputPreemptedError,
  SessionInputGuardRejectedError,
  SessionManager,
  SessionNotReadyError,
} from "./session-manager.js";

type ProjectBootstrapAttemptPhase =
  | "claimed"
  | "dispatching"
  | "not-submitted"
  | "submitted";

interface PersistedProjectBootstrapInputReceipt extends ProjectBootstrapInputReceipt {
  payloadDigest: string;
}

interface PersistedProjectBootstrapState {
  schemaVersion: 3;
  metadata: ProjectBootstrapMetadata;
  inputs: ProjectBootstrapQueuedInput[];
  /**
   * Durable write-ahead intent for the one FIFO head that may be crossing the
   * PTY boundary. An unresolved intent is never replayed automatically after a
   * restart because the process cannot prove whether the PTY accepted it.
   */
  dispatchingInputId: string | null;
  retryCount: number;
  emptyProject: boolean;
  attempts: Array<{
    attemptId: string;
    retryOrdinal: number;
    status: "active" | "retired" | "completed";
    /** `dispatching` is written before the first PTY byte and is therefore
     * conservatively uncertain after process loss. `not-submitted` is written
     * only when SessionManager positively proves Enter was never attempted. */
    phase: ProjectBootstrapAttemptPhase;
  }>;
  /** IDs retained for schema-2 compatibility and bounded inspection. */
  uncertainInputIds: string[];
  /**
   * Durable, content-bearing tombstones for FIFO entries whose PTY acceptance
   * could not be proven. They are removed from the dispatchable FIFO so later
   * user input can progress, but are never replayed or discarded.
   */
  uncertainInputs: ProjectBootstrapQueuedInput[];
  /** Session-scoped idempotency receipts for the bounded bootstrap FIFO. */
  receipts: PersistedProjectBootstrapInputReceipt[];
}

interface AcceptedInputLedger {
  schemaVersion: 1;
  inputIds: string[];
}

interface PersistedProjectBootstrapIntent {
  schemaVersion: 1;
  projectId: string;
  userId: string;
  targetSessionId: string | null;
  status: "scheduled" | "claimed";
  createdAt: string;
  updatedAt: string;
}

interface ExpectedPrompt {
  kind: "bootstrap" | "user";
  id: string;
  text: string;
  /** A failed/timed-out greeting stays as a FIFO tombstone so a late hook
   * cannot be mistaken for a later retry. */
  retired?: boolean;
}

type ObservedProjectTurn =
  | { kind: "bootstrap"; id: string; retired: boolean }
  | { kind: "user"; id: string }
  | { kind: "external" };

type ActiveCoordinatorTurn =
  | { kind: "bootstrap"; id: string }
  | { kind: "user"; id: string };

interface AttemptTimer {
  key: "pending" | string;
  runtimeEpoch: string;
  handle: ReturnType<typeof setTimeout>;
}

interface ActiveTurnTimer {
  turn: ActiveCoordinatorTurn;
  runtimeEpoch: string;
  handle: ReturnType<typeof setTimeout>;
}

type ProjectBootstrapDrainOutcome =
  | "progressed"
  | "empty"
  | "owned"
  | "not-runnable"
  | "authorization-denied"
  | "transient-failure";

interface BootstrapFailureTransitionObligation {
  attemptId: string;
  errorCode: ProjectBootstrapErrorCode;
  retryable: boolean;
  correlationRelease:
    | "remove"
    | "tombstone"
    | "consume-observed-or-tombstone";
}

interface PendingBootstrapFailureTransitionObligation {
  errorCode: ProjectBootstrapErrorCode;
  retryable: boolean;
}

export type ProjectBootstrapRegistrationMode =
  | "boot"
  | "created"
  | "live"
  | "resumed";

export interface ProjectBootstrapRegistrationContext {
  emptyProject: boolean;
  mode: ProjectBootstrapRegistrationMode;
}

export interface ProjectBootstrapCoordinatorOptions {
  root: string;
  /** @deprecated Read-only migration source for pre-SAP-3148 queue files. */
  legacyRoot?: string;
  sessionManager: SessionManager;
  now?: () => string;
  generateId?: () => string;
  /** Maximum wait for the target session to become interactive. */
  readinessTimeoutMs?: number;
  /** Maximum wait for the model turn after the request reaches the PTY. */
  deliveryTimeoutMs?: number;
  /** Test seam for classifying queue-store failures without exposing raw errors. */
  writeState?: (file: string, state: unknown) => Promise<void>;
  /** Test seam for accepted-ledger cleanup/commit failures. */
  writeAcceptedLedger?: (file: string, state: unknown) => Promise<void>;
  /** Live authorization gate checked immediately before every PTY dispatch. */
  canDispatch?: (session: HarnessSession) => boolean | Promise<boolean>;
  /** Rechecks E2 semantic state immediately before the bootstrap attempt. */
  isMeaningfullyEmpty?: (projectId: string) => boolean | Promise<boolean>;
  onEvent?: (event: ProjectBootstrapLifecycleEvent) => Promise<void> | void;
}

export class ProjectBootstrapRetryUnavailableError extends Error {
  readonly code = "project_bootstrap_retry_unavailable";

  constructor() {
    super("project bootstrap retry is not available");
    this.name = "ProjectBootstrapRetryUnavailableError";
  }
}

export class ProjectBootstrapDispatchForbiddenError extends Error {
  readonly code = "project_bootstrap_dispatch_forbidden";

  constructor() {
    super("project bootstrap is no longer authorized for this session");
    this.name = "ProjectBootstrapDispatchForbiddenError";
  }
}

export class ProjectBootstrapCoordinatorClosedError extends Error {
  readonly code = "project_bootstrap_coordinator_closed";

  constructor() {
    super("project bootstrap coordinator is closed");
    this.name = "ProjectBootstrapCoordinatorClosedError";
  }
}

export class ProjectBootstrapRequestIdConflictError extends Error {
  readonly code = "project_bootstrap_request_id_reused";

  constructor() {
    super("project bootstrap request id was reused with different input");
    this.name = "ProjectBootstrapRequestIdConflictError";
  }
}

export class ProjectBootstrapInputCapacityError extends Error {
  readonly code = "project_bootstrap_input_capacity";

  constructor() {
    super("project bootstrap input receipt capacity is temporarily full");
    this.name = "ProjectBootstrapInputCapacityError";
  }
}

const MAX_RETRIES = 2;
const MAX_INPUT_RECEIPTS = 128;
const MAX_CORRELATION_BARRIERS = 256;
const MAX_COMPLETION_EVENT_RECEIPTS = 256;

/**
 * Keep a bounded recent idempotency window. Entries that still own queued or
 * submitted work are never evicted. Only completed unkeyed bookkeeping is
 * retired; keyed receipts remain stable until the bounded store reaches
 * capacity, at which point a new logical request fails before mutation.
 */
function compactInputReceipts(
  receipts: readonly PersistedProjectBootstrapInputReceipt[],
  reserveSlots = 0,
): PersistedProjectBootstrapInputReceipt[] {
  const limit = Math.max(0, MAX_INPUT_RECEIPTS - reserveSlots);
  const compacted: PersistedProjectBootstrapInputReceipt[] = receipts.map(
    (receipt) => structuredClone(receipt),
  );
  while (compacted.length > limit) {
    const index = compacted.findIndex(
      (receipt) => receipt.status === "completed" && receipt.requestId === null,
    );
    if (index < 0) break;
    compacted.splice(index, 1);
  }
  if (compacted.length > limit) {
    throw new ProjectBootstrapInputCapacityError();
  }
  return compacted;
}

function projectBootstrapInputDigest(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, submit: true, text }))
    .digest("hex");
}

function hasSafeBootstrapRetryEvidence(
  state: PersistedProjectBootstrapState,
): boolean {
  const bootstrap = state.metadata.bootstrap;
  if (bootstrap.status !== "failed" || !bootstrap.retryable) return false;
  const latest = state.attempts.at(-1);
  if (!latest) {
    // Readiness and current-schema persistence can fail before an attempt is
    // allocated. Legacy unsafe combinations are normalized non-retryable.
    return (
      bootstrap.errorCode === "session_not_ready" ||
      bootstrap.errorCode === "persistence_failed"
    );
  }
  if (latest.status !== "retired") return false;
  if (latest.phase === "claimed") {
    return (
      bootstrap.errorCode === "session_not_ready" ||
      bootstrap.errorCode === "injection_failed" ||
      bootstrap.errorCode === "persistence_failed"
    );
  }
  if (latest.phase === "not-submitted") {
    return (
      bootstrap.errorCode === "injection_failed" ||
      bootstrap.errorCode === "persistence_failed"
    );
  }
  return (
    latest.phase === "submitted" &&
    (bootstrap.errorCode === "delivery_timeout" ||
      bootstrap.errorCode === "model_turn_failed")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(metadata: ProjectBootstrapMetadata): boolean {
  return (
    metadata.bootstrap.status === "delivered" ||
    metadata.bootstrap.status === "skipped"
  );
}

/**
 * Whether the bootstrap coordinator still owns submitted user input. Once its
 * FIFO is empty, the ordinary SessionManager input path resumes ownership.
 */
export function projectBootstrapOwnsInput(
  metadata: ProjectBootstrapMetadata | null | undefined,
): boolean {
  return Boolean(
    metadata && (!isTerminal(metadata) || metadata.queuedInputIds.length > 0),
  );
}

function validBootstrapState(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "pending":
      return true;
    case "generating":
      return typeof value.attemptId === "string" && value.attemptId !== "";
    case "delivered":
      return typeof value.messageId === "string" && value.messageId !== "";
    case "failed":
      return (
        typeof value.retryable === "boolean" &&
        typeof value.errorCode === "string" &&
        [
          "session_not_ready",
          "session_exited",
          "injection_failed",
          "model_turn_failed",
          "delivery_timeout",
          "persistence_failed",
          "scope_unavailable",
        ].includes(value.errorCode)
      );
    case "skipped":
      return (
        value.reason === "user-proceeded" || value.reason === "map-not-empty"
      );
    default:
      return false;
  }
}

function parsePersistedProjectBootstrapState(
  value: unknown,
  session: HarnessSession,
): PersistedProjectBootstrapState | null {
  if (!isRecord(value) || !session.projectBootstrap) return null;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return null;
  const expected = session.projectBootstrap;
  const legacyIdentity = isRecord(metadata.identity) ? metadata.identity : null;
  const projectId = legacyIdentity?.projectId ?? metadata.projectId;
  const userId = legacyIdentity?.userId ?? metadata.userId;
  const targetSessionId = legacyIdentity?.sessionId ?? metadata.targetSessionId;
  const bootstrap = metadata.bootstrap ?? metadata.greeting;
  if (
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3) ||
    projectId !== expected.projectId ||
    userId !== expected.userId ||
    targetSessionId !== expected.targetSessionId ||
    !Array.isArray(metadata.queuedInputIds) ||
    !metadata.queuedInputIds.every((id) => typeof id === "string") ||
    !validBootstrapState(bootstrap) ||
    !Array.isArray(value.inputs) ||
    (value.dispatchingInputId !== undefined &&
      value.dispatchingInputId !== null &&
      typeof value.dispatchingInputId !== "string") ||
    !Number.isSafeInteger(value.retryCount) ||
    (value.retryCount as number) < 0 ||
    (value.retryCount as number) > MAX_RETRIES ||
    typeof value.emptyProject !== "boolean"
  ) {
    return null;
  }
  const inputs = value.inputs;
  const storedUncertainInputs = Array.isArray(value.uncertainInputs)
    ? value.uncertainInputs
    : [];
  const validInput = (input: unknown): input is ProjectBootstrapQueuedInput =>
    isRecord(input) &&
    typeof input.id === "string" &&
    input.id !== "" &&
    input.sessionId === session.id &&
    typeof input.text === "string" &&
    input.text.length <= 100_000 &&
    typeof input.acceptedAt === "string";
  if (
    !inputs.every(validInput) ||
    !storedUncertainInputs.every(validInput) ||
    new Set(
      [...inputs, ...storedUncertainInputs].map(
        (input) => (input as ProjectBootstrapQueuedInput).id,
      ),
    ).size !==
      inputs.length + storedUncertainInputs.length ||
    metadata.queuedInputIds.length !== inputs.length ||
    metadata.queuedInputIds.some((id, index) => id !== inputs[index]?.id) ||
    (typeof value.dispatchingInputId === "string" &&
      value.dispatchingInputId !== inputs[0]?.id)
  ) {
    return null;
  }
  const sourceSchemaVersion = Number(value.schemaVersion);
  const storedAttempts = Array.isArray(value.attempts) ? value.attempts : [];
  const validAttempt = (
    attempt: unknown,
  ): attempt is PersistedProjectBootstrapState["attempts"][number] =>
    isRecord(attempt) &&
    typeof attempt.attemptId === "string" &&
    attempt.attemptId !== "" &&
    Number.isSafeInteger(attempt.retryOrdinal) &&
    Number(attempt.retryOrdinal) >= 0 &&
    Number(attempt.retryOrdinal) <= MAX_RETRIES &&
    ["active", "retired", "completed"].includes(String(attempt.status)) &&
    (sourceSchemaVersion < 3 ||
      ["claimed", "dispatching", "not-submitted", "submitted"].includes(
        String(attempt.phase),
      ));
  if (
    sourceSchemaVersion >= 3 &&
    (!Array.isArray(value.attempts) ||
      storedAttempts.length > 8 ||
      !storedAttempts.every(validAttempt) ||
      new Set(
        storedAttempts
          .filter(validAttempt)
          .map((attempt) => attempt.attemptId),
      ).size !== storedAttempts.length ||
      new Set(
        storedAttempts
          .filter(validAttempt)
          .map((attempt) => attempt.retryOrdinal),
      ).size !== storedAttempts.length)
  ) {
    // Current-schema attempt evidence is retry authority. Never turn a missing,
    // malformed, or duplicate entry into an apparently safe empty history.
    return null;
  }
  const attempts = Array.isArray(value.attempts)
    ? value.attempts
        .filter(validAttempt)
        .map((attempt) => ({
          attemptId: attempt.attemptId,
          retryOrdinal: attempt.retryOrdinal,
          status: attempt.status,
          // Schema 1/2 could already have crossed Enter and therefore migrates
          // conservatively. Only schema 3 can prove a pre-PTY claim.
          phase:
            sourceSchemaVersion >= 3
              ? attempt.phase
              : attempt.status === "completed"
                ? "submitted"
                : "dispatching",
        }))
    : [];
  const persistedUncertainIds = Array.isArray(value.uncertainInputIds)
    ? value.uncertainInputIds.filter(
        (inputId): inputId is string => typeof inputId === "string",
      )
    : [];
  const legacyUncertainIds = new Set(
    persistedUncertainIds.filter((inputId) =>
      inputs.some((input) => isRecord(input) && input.id === inputId),
    ),
  );
  const normalizedInputs = (
    structuredClone(value.inputs) as ProjectBootstrapQueuedInput[]
  ).filter((input) => !legacyUncertainIds.has(input.id));
  const normalizedUncertainInputs = [
    ...(structuredClone(
      storedUncertainInputs,
    ) as ProjectBootstrapQueuedInput[]),
    ...(structuredClone(value.inputs) as ProjectBootstrapQueuedInput[]).filter(
      (input) => legacyUncertainIds.has(input.id),
    ),
  ];
  const uncertainInputIds = normalizedUncertainInputs.map((input) => input.id);
  let normalizedBootstrap = structuredClone(
    bootstrap,
  ) as ProjectBootstrapMetadata["bootstrap"];
  if (
    sourceSchemaVersion < 3 &&
    normalizedBootstrap.status === "failed" &&
    normalizedBootstrap.retryable &&
    normalizedBootstrap.errorCode !== "session_not_ready"
  ) {
    // Schema 1/2 had no durable phase evidence. A legacy retryable flag cannot
    // prove that an injection/persistence failure preceded Enter.
    normalizedBootstrap = { ...normalizedBootstrap, retryable: false };
  }
  if (
    sourceSchemaVersion < 3 &&
    attempts.length === 0 &&
    normalizedBootstrap.status === "generating"
  ) {
    attempts.push({
      attemptId: normalizedBootstrap.attemptId,
      retryOrdinal: Math.max(0, Number(value.retryCount) || 0),
      status: "active",
      phase: "dispatching",
    });
  }
  if (
    sourceSchemaVersion >= 3 &&
    normalizedBootstrap.status === "generating" &&
    !attempts.some((attempt) => {
      const activeAttemptId =
        normalizedBootstrap.status === "generating"
          ? normalizedBootstrap.attemptId
          : null;
      return (
        attempt.attemptId === activeAttemptId && attempt.status === "active"
      );
    })
  ) {
    return null;
  }
  if (normalizedInputs.length > 0 && !isTerminal({
    projectId: expected.projectId,
    userId: expected.userId,
    targetSessionId: expected.targetSessionId,
    bootstrap: normalizedBootstrap,
    queuedInputIds: normalizedInputs.map((input) => input.id),
  })) {
    if (sourceSchemaVersion >= 3) return null;
    // Legacy planner queues could persist the FIFO before their greeting skip.
    // The user input is authoritative, so migration completes that transition
    // without changing IDs or message bodies.
    normalizedBootstrap = { status: "skipped", reason: "user-proceeded" };
  }
  if (sourceSchemaVersion >= 3 && !Array.isArray(value.receipts)) return null;
  // Schema 1/2 never owned receipt authority. Ignore any injected property and
  // derive canonical unkeyed receipts solely from the migrated FIFO/tombstone
  // state so legacy data cannot mint an idempotency key.
  const storedReceipts =
    sourceSchemaVersion >= 3 && Array.isArray(value.receipts)
      ? value.receipts
      : [];
  const validReceipts = storedReceipts.filter(
    (receipt): receipt is Record<string, unknown> =>
      isRecord(receipt) &&
      (receipt.requestId === null ||
        (typeof receipt.requestId === "string" &&
          receipt.requestId !== "" &&
          receipt.requestId.length <= 200)) &&
      typeof receipt.inputId === "string" &&
      receipt.inputId !== "" &&
      ["queued", "submitted", "uncertain", "completed"].includes(
        String(receipt.status),
      ) &&
      typeof receipt.acceptedAt === "string" &&
      typeof receipt.payloadDigest === "string" &&
      /^[0-9a-f]{64}$/.test(receipt.payloadDigest),
  );
  const receipts: PersistedProjectBootstrapInputReceipt[] = validReceipts.map(
    (receipt) => ({
      requestId: receipt.requestId as string | null,
      inputId: receipt.inputId as string,
      status: receipt.status as ProjectBootstrapInputReceipt["status"],
      acceptedAt: receipt.acceptedAt as string,
      payloadDigest: receipt.payloadDigest as string,
    }),
  );
  if (sourceSchemaVersion < 3) {
    for (const input of normalizedInputs) {
      receipts.push({
        requestId: null,
        inputId: input.id,
        status: "queued",
        acceptedAt: input.acceptedAt,
        payloadDigest: projectBootstrapInputDigest(input.text),
      });
    }
    for (const input of normalizedUncertainInputs) {
      receipts.push({
        requestId: null,
        inputId: input.id,
        status: "uncertain",
        acceptedAt: input.acceptedAt,
        payloadDigest: projectBootstrapInputDigest(input.text),
      });
    }
  }
  if (
    sourceSchemaVersion >= 3 &&
    (validReceipts.length !== storedReceipts.length ||
      new Set(receipts.map((receipt) => receipt.inputId)).size !==
        receipts.length ||
      new Set(
        receipts
          .filter((receipt) => receipt.requestId !== null)
          .map((receipt) => receipt.requestId),
      ).size !==
        receipts.filter((receipt) => receipt.requestId !== null).length)
  ) {
    return null;
  }
  if (
    sourceSchemaVersion >= 3 &&
    (normalizedInputs.some((input) => {
      const receipt = receipts.find(
        (candidate) => candidate.inputId === input.id,
      );
      return (
        !receipt ||
        receipt.acceptedAt !== input.acceptedAt ||
        receipt.payloadDigest !== projectBootstrapInputDigest(input.text) ||
        receipt.status === "completed" ||
        receipt.status === "uncertain"
      );
    }) ||
      normalizedUncertainInputs.some((input) => {
        const receipt = receipts.find(
          (candidate) => candidate.inputId === input.id,
        );
        return (
          !receipt ||
          receipt.acceptedAt !== input.acceptedAt ||
          receipt.payloadDigest !== projectBootstrapInputDigest(input.text) ||
          receipt.status !== "uncertain"
        );
      }) ||
      receipts.some(
        (receipt) =>
          receipt.status === "queued" &&
          !normalizedInputs.some((input) => input.id === receipt.inputId),
      ) ||
      // Receipt order is the durable logical-arrival order. Live FIFO rows may
      // have terminal receipt-only predecessors after a crash, but the rows
      // themselves must remain a monotonic subsequence so boot recovery can
      // conservatively terminalize the causal prefix without guessing.
      normalizedInputs.some((input, index) => {
        if (index === 0) return false;
        const priorIndex = receipts.findIndex(
          (receipt) => receipt.inputId === normalizedInputs[index - 1]?.id,
        );
        const currentIndex = receipts.findIndex(
          (receipt) => receipt.inputId === input.id,
        );
        return priorIndex < 0 || currentIndex <= priorIndex;
      }) ||
      normalizedInputs.some(
        (input, index) =>
          receipts.at(index - normalizedInputs.length)?.inputId !== input.id,
      ))
  ) {
    return null;
  }
  let compactedReceipts: PersistedProjectBootstrapInputReceipt[];
  try {
    compactedReceipts = compactInputReceipts(receipts);
  } catch {
    return null;
  }
  return {
    schemaVersion: 3,
    metadata: {
      projectId: expected.projectId,
      userId: expected.userId,
      targetSessionId: expected.targetSessionId,
      bootstrap: normalizedBootstrap,
      queuedInputIds: normalizedInputs.map((input) => input.id),
    },
    inputs: normalizedInputs,
    dispatchingInputId:
      typeof value.dispatchingInputId === "string" &&
      legacyUncertainIds.has(value.dispatchingInputId)
        ? null
        : (value.dispatchingInputId ?? null),
    retryCount: Number(value.retryCount),
    emptyProject: Boolean(value.emptyProject),
    attempts: attempts.slice(-8),
    uncertainInputIds,
    uncertainInputs: normalizedUncertainInputs,
    receipts: compactedReceipts,
  };
}

export function projectBootstrapPrompt(
  retryOrdinal = 0,
  attemptId?: string,
): string {
  const suffix =
    retryOrdinal > 0
      ? ` This is automatic retry ${Math.min(retryOrdinal, MAX_RETRIES)} of ${MAX_RETRIES}.`
      : "";
  const correlation = attemptId
    ? ` Internal correlation key: ${attemptId}. Never repeat or expose this key.`
    : "";
  return `Agent Studio project bootstrap: Read the current Agent Map first. Only if it is still meaningfully empty, inspect available project context for explicit evidence of agents, meaningful subagents, responsibilities, contracts, resources, connectors, artifacts, and cross-agent data flow. Validate before proposing one honest initial map with the structured Agent Map tools. Never guess, invent placeholder nodes, or overwrite concurrent work; on conflict, reread and reconcile. Summarize what the evidence supports and clearly identify uncertainty. This bootstrap is ordinary project work: if a real user request is present, prioritize it and proceed directly with implementation when it is build-ready; no confirmation or mode transition is required.${suffix}${correlation}`;
}

const PROJECT_SESSION_SOURCES = new Set([
  "startup",
  "resume",
  "clear",
  "compact",
  "codex",
]);
const MAX_TELEMETRY_TOKEN_COUNT = 1_000_000_000_000;

function telemetrySource(value: unknown): string {
  return typeof value === "string" && PROJECT_SESSION_SOURCES.has(value)
    ? value
    : "unknown";
}

function telemetryTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(Math.trunc(value), MAX_TELEMETRY_TOKEN_COUNT);
}

function telemetryUsage(value: unknown): Record<string, number | null> | null {
  if (!isRecord(value)) return null;
  const inputTokens = telemetryTokenCount(value.inputTokens);
  const outputTokens = telemetryTokenCount(value.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

function telemetryPayload(event: AnalyticsEvent): Record<string, unknown> {
  switch (event.type) {
    case "session.start":
      return {
        source: telemetrySource(event.payload.source),
        projectBootstrap: true,
      };
    case "prompt.submitted":
      return {
        projectBootstrap: true,
        origin: event.payload.projectBootstrapOrigin ?? "user",
        ...(typeof event.payload.projectBootstrapInputId === "string"
          ? { projectBootstrapInputId: event.payload.projectBootstrapInputId }
          : {}),
        ...(typeof event.payload.projectBootstrapAttemptId === "string"
          ? {
              projectBootstrapAttemptId:
                event.payload.projectBootstrapAttemptId,
            }
          : {}),
      };
    case "tool.call":
      return { projectBootstrap: true, toolObserved: true };
    case "turn.completed":
      return {
        projectBootstrap: true,
        hasAssistantText:
          typeof event.payload.assistantText === "string" &&
          event.payload.assistantText.length > 0,
        // Provider/model text is never remotely projected. Even a syntactically
        // plausible model identifier is an attacker-controlled covert channel.
        modelReported:
          typeof event.payload.model === "string" &&
          event.payload.model.length > 0,
        usage: telemetryUsage(event.payload.usage),
      };
    default:
      return { projectBootstrap: true };
  }
}

export class ProjectBootstrapCoordinator {
  private readonly root: string;
  private readonly legacyRoot: string | null;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly readinessTimeoutMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly states = new Map<string, PersistedProjectBootstrapState>();
  private readonly writes = new Map<string, Promise<unknown>>();
  /** Exact server-issued PTY generation currently allowed to own volatile
   * correlation, input holds, timers, and completion dedupe state. */
  private readonly runtimeEpochs = new Map<string, string>();
  private readonly expected = new Map<string, ExpectedPrompt[]>();
  private readonly observedAttempts = new Map<string, ObservedProjectTurn[]>();
  /** Exact normalized completion IDs already applied in this live ingest
   * epoch. The ingest pipeline never replays archived events into a newly
   * constructed coordinator, so restart is the safe epoch boundary. Separate
   * provider Stop invocations receive distinct IDs and carry no stable turn
   * token; those intrinsically indistinguishable events are handled only by
   * conservative correlation barriers/timeouts, never text/timing guesses. */
  private readonly processedCompletionEvents = new Map<string, string[]>();
  /** Once the fixed exact-ID window is full, stop trusting completion events
   * for the remainder of this live coordinator epoch. Ingest callbacks are
   * detached from HTTP processing and therefore have no finite delay bound;
   * evicting an old ID would make its replay capable of completing a newer
   * turn. Timeouts preserve FIFO progress until restart establishes a fresh
   * event epoch. */
  private readonly completionDedupeOverflow = new Set<string>();
  /** At most one coordinator-owned prompt may have crossed Enter without a
   * correlated turn completion. This is deliberately separate from durable
   * FIFO acceptance: accepted user input remains durable even while its turn
   * temporarily owns the live CLI. */
  private readonly activeTurns = new Map<string, ActiveCoordinatorTurn>();
  private readonly correlationOverflow = new Set<string>();
  private readonly timers = new Map<string, AttemptTimer>();
  private readonly activeTurnTimers = new Map<string, ActiveTurnTimer>();
  /** Exact persistence-only transition retained when an active bootstrap
   * failure cannot commit. Its retry never writes prompt bytes and preserves
   * the original public error classification. */
  private readonly bootstrapFailureTransitions = new Map<
    string,
    BootstrapFailureTransitionObligation
  >();
  private readonly pendingBootstrapFailureTransitions = new Map<
    string,
    PendingBootstrapFailureTransitionObligation
  >();
  /** Positive no-Enter user submissions whose dispatch-marker rollback still
   * needs to commit. The active owner remains until this persistence-only
   * obligation succeeds; its retry never writes prompt bytes. */
  private readonly userNotSubmittedTransitions = new Map<string, string>();
  private readonly blockingInputRedrainTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Durable work that lost its final external/status wakeup to a transient
   * local persistence/load failure. Only this classification may poll on a
   * bounded timer; authorization denial explicitly clears it. */
  private readonly inputRedrainNeeded = new Set<string>();
  /** Project claims made before SessionManager publishes the new session. */
  private readonly provisionalProjectClaims = new Map<string, string>();
  private readonly provisionalSessionClaims = new Map<string, string>();
  /** Synchronous API-arrival signal used to cancel a staged background Enter
   * before the durable FIFO operation reaches this coordinator's lock. */
  private readonly pendingApiPreemptions = new Map<
    string,
    { runtimeEpoch: string; count: number }
  >();
  /** Status hooks can race a freshly spawned PTY ahead of registration. */
  private readonly registeredSessions = new Set<string>();
  /** Set synchronously by raw terminal input, including before registration. */
  private readonly terminalPreemptions = new Set<string>();
  /** Raw input creates a durable user-proceeded obligation independently of
   * the raw model-turn hold. A completion may release the latter but never the
   * former before `skipped` is committed. */
  private readonly terminalPreemptionObligations = new Set<string>();
  /** Blocking trust/login input releases its raw hold after the durable
   * user-proceeded transition; ordinary terminal input keeps the hold until a
   * correlated external completion. */
  private readonly blockingTerminalPreemptions = new Set<string>();
  private readonly terminalPreemptionRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly reportedTerminalPreemptions = new Set<string>();
  private closed = false;
  private admissionGeneration = 0;

  constructor(private readonly options: ProjectBootstrapCoordinatorOptions) {
    this.root = path.resolve(options.root);
    this.legacyRoot = options.legacyRoot
      ? path.resolve(options.legacyRoot)
      : null;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? options.deliveryTimeoutMs ?? 45_000;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 300_000;
  }

  private sessionDirectory(sessionId: string): string {
    const directory = path.resolve(this.root, sessionId);
    const rootPrefix = `${this.root}${path.sep}`;
    if (!directory.startsWith(rootPrefix)) {
      throw new Error("invalid project bootstrap storage identity");
    }
    return directory;
  }

  private file(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "input-queue.json");
  }

  private legacyFile(sessionId: string, name: string): string | null {
    if (!this.legacyRoot) return null;
    const directory = path.resolve(this.legacyRoot, sessionId);
    if (!directory.startsWith(`${this.legacyRoot}${path.sep}`)) {
      throw new Error("invalid legacy project bootstrap storage identity");
    }
    return path.join(directory, name);
  }

  private acceptedFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "accepted-inputs.json");
  }

  private projectIntentFile(projectId: string): string {
    if (!/^project_[0-9a-f-]+$/.test(projectId)) {
      throw new Error("invalid project bootstrap identity");
    }
    const directory = path.resolve(this.root, "projects");
    const file = path.resolve(directory, `${projectId}.json`);
    if (!file.startsWith(`${directory}${path.sep}`)) {
      throw new Error("invalid project bootstrap identity");
    }
    return file;
  }

  private emit(event: ProjectBootstrapLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Telemetry is best effort and must never change bootstrap semantics.
    }
  }

  private isAdmissionCurrent(generation: number): boolean {
    return !this.closed && this.admissionGeneration === generation;
  }

  private async canDispatch(
    session: HarnessSession,
    generation = this.admissionGeneration,
  ): Promise<boolean> {
    if (!this.isAdmissionCurrent(generation)) return false;
    try {
      const allowed = (await this.options.canDispatch?.(session)) ?? true;
      return allowed && this.isAdmissionCurrent(generation);
    } catch {
      return false;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ProjectBootstrapCoordinatorClosedError();
  }

  private isRuntimeEpochCurrent(
    sessionId: string,
    runtimeEpoch: string,
  ): boolean {
    return (
      !this.closed && this.runtimeEpochs.get(sessionId) === runtimeEpoch
    );
  }

  /** Current trusted live epoch for server-originated API/retry actions. */
  private currentRuntimeEpoch(sessionId: string): string | null {
    const runtimeEpoch = this.options.sessionManager.getRuntimeEpoch(sessionId);
    return runtimeEpoch !== null &&
      this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
      ? runtimeEpoch
      : null;
  }

  private hasPendingApiInput(
    sessionId: string,
    runtimeEpoch = this.runtimeEpochs.get(sessionId),
  ): boolean {
    const pending = this.pendingApiPreemptions.get(sessionId);
    return Boolean(
      runtimeEpoch &&
        pending?.runtimeEpoch === runtimeEpoch &&
        pending.count > 0,
    );
  }

  private notePendingApiInput(sessionId: string, runtimeEpoch: string): void {
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
    const pending = this.pendingApiPreemptions.get(sessionId);
    this.pendingApiPreemptions.set(sessionId, {
      runtimeEpoch,
      count:
        pending?.runtimeEpoch === runtimeEpoch ? pending.count + 1 : 1,
    });
  }

  private clearPendingApiInput(
    sessionId: string,
    runtimeEpoch: string,
  ): void {
    const pending = this.pendingApiPreemptions.get(sessionId);
    if (pending?.runtimeEpoch !== runtimeEpoch) return;
    const remaining = pending.count - 1;
    if (remaining <= 0) {
      this.pendingApiPreemptions.delete(sessionId);
      // Releasing the final API-admission fence is itself a progress edge. A
      // transient drain failure may have tried to schedule recovery while this
      // counter still suppressed it.
      this.scheduleInputRedrain(sessionId, runtimeEpoch);
    } else {
      this.pendingApiPreemptions.set(sessionId, {
        runtimeEpoch,
        count: remaining,
      });
    }
  }

  private hasInputHold(sessionId: string): boolean {
    return (
      this.activeTurns.has(sessionId) || this.terminalPreemptions.has(sessionId)
    );
  }

  /**
   * Whether the single durable input authority must handle this request.
   * Ownership extends through the whole coordinated model turn, even after
   * its FIFO row has been dequeued. A known request ID also routes back here
   * so response-loss retries resolve to the original durable receipt.
   */
  ownsInput(sessionId: string, requestId?: string): boolean {
    const session = this.options.sessionManager.get(sessionId);
    const state = this.states.get(sessionId);
    return Boolean(
      projectBootstrapOwnsInput(session?.projectBootstrap) ||
      state?.dispatchingInputId ||
      this.activeTurns.has(sessionId) ||
      this.hasPendingApiInput(sessionId) ||
      (requestId &&
        state?.receipts.some((receipt) => receipt.requestId === requestId)),
    );
  }

  private inputPayloadDigest(text: string): string {
    return projectBootstrapInputDigest(text);
  }

  private publicReceipt(
    receipt: PersistedProjectBootstrapInputReceipt,
  ): ProjectBootstrapInputReceipt {
    return {
      requestId: receipt.requestId,
      inputId: receipt.inputId,
      status: receipt.status,
      acceptedAt: receipt.acceptedAt,
    };
  }

  private receiptForInput(
    state: PersistedProjectBootstrapState,
    inputId: string,
  ): PersistedProjectBootstrapInputReceipt | undefined {
    return state.receipts.find((receipt) => receipt.inputId === inputId);
  }

  private updateReceiptStatus(
    state: PersistedProjectBootstrapState,
    inputId: string,
    status: ProjectBootstrapInputReceipt["status"],
  ): void {
    const receipt = this.receiptForInput(state, inputId);
    if (!receipt) return;
    // `completed` and `uncertain` are distinct terminal evidence. Neither may
    // be weakened or rewritten by later boot reconciliation or a late hook.
    if (receipt.status === "completed" || receipt.status === "uncertain") return;
    if (receipt.status === "submitted" && status === "queued") return;
    receipt.status = status;
  }

  private clearActiveTurn(
    sessionId: string,
    kind: ActiveCoordinatorTurn["kind"],
    id: string,
  ): void {
    const active = this.activeTurns.get(sessionId);
    if (active?.kind === kind && active.id === id) {
      this.activeTurns.delete(sessionId);
      const timer = this.activeTurnTimers.get(sessionId);
      if (timer?.turn.kind === kind && timer.turn.id === id) {
        clearTimeout(timer.handle);
        this.activeTurnTimers.delete(sessionId);
      }
    }
  }

  private serialize<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.writes.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.writes.set(sessionId, next);
    void next.then(
      () => {
        if (this.writes.get(sessionId) === next) this.writes.delete(sessionId);
      },
      () => {
        if (this.writes.get(sessionId) === next) this.writes.delete(sessionId);
      },
    );
    return next;
  }

  /** Drop only volatile ownership belonging to one proven PTY generation. */
  private clearRuntimeEpochState(
    sessionId: string,
    runtimeEpoch: string,
  ): void {
    if (this.runtimeEpochs.get(sessionId) !== runtimeEpoch) return;
    this.clearTimer(sessionId);
    const activeTimer = this.activeTurnTimers.get(sessionId);
    if (activeTimer) clearTimeout(activeTimer.handle);
    this.activeTurnTimers.delete(sessionId);
    const redrain = this.blockingInputRedrainTimers.get(sessionId);
    if (redrain) clearTimeout(redrain);
    this.blockingInputRedrainTimers.delete(sessionId);
    const preemptionRetry = this.terminalPreemptionRetryTimers.get(sessionId);
    if (preemptionRetry) clearTimeout(preemptionRetry);
    this.terminalPreemptionRetryTimers.delete(sessionId);
    this.expected.delete(sessionId);
    this.observedAttempts.delete(sessionId);
    this.processedCompletionEvents.delete(sessionId);
    this.completionDedupeOverflow.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.correlationOverflow.delete(sessionId);
    this.bootstrapFailureTransitions.delete(sessionId);
    this.pendingBootstrapFailureTransitions.delete(sessionId);
    this.userNotSubmittedTransitions.delete(sessionId);
    this.inputRedrainNeeded.delete(sessionId);
    this.pendingApiPreemptions.delete(sessionId);
    this.registeredSessions.delete(sessionId);
    this.terminalPreemptions.delete(sessionId);
    this.terminalPreemptionObligations.delete(sessionId);
    this.blockingTerminalPreemptions.delete(sessionId);
    this.reportedTerminalPreemptions.delete(sessionId);
    this.runtimeEpochs.delete(sessionId);
  }

  private newState(
    session: HarnessSession,
    emptyProject: boolean,
  ): PersistedProjectBootstrapState {
    if (!session.projectBootstrap) {
      throw new Error("project bootstrap metadata missing");
    }
    return {
      schemaVersion: 3,
      metadata: {
        ...structuredClone(session.projectBootstrap),
        // The queue file owns FIFO membership. If that file is missing or was
        // quarantined, stale registry IDs cannot resurrect content we no
        // longer possess or make the replacement state invalid on next boot.
        queuedInputIds: [],
      },
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject,
      attempts: [],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [],
    };
  }

  private async load(
    session: HarnessSession,
    emptyProject = true,
  ): Promise<PersistedProjectBootstrapState> {
    const cached = this.states.get(session.id);
    // Every transition works on an isolated snapshot. Nothing may mutate the
    // authoritative cache until persist() commits the primary queue file.
    if (cached) return structuredClone(cached);
    let state: PersistedProjectBootstrapState;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.file(session.id), "utf8"),
      );
      const normalized = parsePersistedProjectBootstrapState(parsed, session);
      if (!normalized) throw new Error("invalid project bootstrap state");
      state = normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Keep malformed legacy files in place for explicit recovery. Never
        // rename away or overwrite a file that may contain undelivered input.
        throw new Error("project bootstrap state is unavailable");
      }
      const legacyFile = this.legacyFile(session.id, "input-queue.json");
      if (legacyFile) {
        try {
          const legacy: unknown = JSON.parse(
            await fs.readFile(legacyFile, "utf8"),
          );
          const normalized = parsePersistedProjectBootstrapState(
            legacy,
            session,
          );
          if (!normalized) {
            throw new Error("invalid legacy project bootstrap state");
          }
          const legacyAccepted = this.legacyFile(
            session.id,
            "accepted-inputs.json",
          );
          if (legacyAccepted) {
            try {
              const accepted = await fs.readFile(legacyAccepted, "utf8");
              const decoded: unknown = JSON.parse(accepted);
              if (
                !isRecord(decoded) ||
                decoded.schemaVersion !== 1 ||
                !Array.isArray(decoded.inputIds) ||
                !decoded.inputIds.every(
                  (inputId) => typeof inputId === "string" && inputId !== "",
                )
              ) {
                throw new Error("invalid legacy accepted-input ledger");
              }
              await this.writeAcceptedInputIds(
                session.id,
                decoded.inputIds as string[],
              );
            } catch (legacyAcceptedError) {
              if (
                (legacyAcceptedError as NodeJS.ErrnoException).code !== "ENOENT"
              ) {
                throw legacyAcceptedError;
              }
            }
          }
          await this.writeState(this.file(session.id), normalized);
          state = normalized;
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
            // Preserve the only copy and fail closed. Never quarantine or
            // overwrite a planner-era FIFO that may contain user input.
            throw new Error("legacy project bootstrap state is unavailable");
          }
          state = this.newState(session, emptyProject);
        }
      } else {
        state = this.newState(session, emptyProject);
      }
    }
    this.states.set(session.id, structuredClone(state));
    return state;
  }

  private async writeState(
    file: string,
    state: PersistedProjectBootstrapState,
  ): Promise<void> {
    if (this.options.writeState) {
      await this.options.writeState(file, structuredClone(state));
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, file);
  }

  private async writeIntent(
    file: string,
    intent: PersistedProjectBootstrapIntent,
  ): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async readIntent(
    projectId: string,
  ): Promise<PersistedProjectBootstrapIntent | null> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        await fs.readFile(this.projectIntentFile(projectId), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("project bootstrap intent is unavailable");
    }
    if (
      !isRecord(decoded) ||
      decoded.schemaVersion !== 1 ||
      decoded.projectId !== projectId ||
      typeof decoded.userId !== "string" ||
      decoded.userId === "" ||
      (decoded.targetSessionId !== null &&
        (typeof decoded.targetSessionId !== "string" ||
          decoded.targetSessionId === "")) ||
      (decoded.status !== "scheduled" && decoded.status !== "claimed") ||
      (decoded.status === "scheduled" && decoded.targetSessionId !== null) ||
      (decoded.status === "claimed" && decoded.targetSessionId === null) ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.updatedAt !== "string"
    ) {
      throw new Error("project bootstrap intent is malformed");
    }
    return structuredClone(
      decoded,
    ) as unknown as PersistedProjectBootstrapIntent;
  }

  /** Durably schedules the lifecycle before a project has a launchable root. */
  scheduleProject(projectId: string, userId: string): Promise<boolean> {
    return this.serialize(`project:${projectId}`, async () => {
      this.assertOpen();
      const existing = await this.readIntent(projectId);
      if (existing) {
        if (existing.userId !== userId) {
          throw new ProjectBootstrapDispatchForbiddenError();
        }
        return false;
      }
      const timestamp = this.now();
      await this.writeIntent(this.projectIntentFile(projectId), {
        schemaVersion: 1,
        projectId,
        userId,
        targetSessionId: null,
        status: "scheduled",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return true;
    });
  }

  /** A replacement session may only claim an abandoned pre-provider target
   * when doing so cannot strand content in that target's durable FIFO. Missing
   * or malformed state is treated conservatively whenever a queue file exists. */
  private async targetHasUnresolvedInput(sessionId: string): Promise<boolean> {
    const target = this.options.sessionManager.get(sessionId);
    if ((target?.projectBootstrap?.queuedInputIds.length ?? 0) > 0) return true;

    const files = [
      this.file(sessionId),
      this.legacyFile(sessionId, "input-queue.json"),
    ].filter((file): file is string => file !== null);
    for (const file of files) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return true;
      }
      if (!isRecord(decoded) || !Array.isArray(decoded.inputs)) return true;
      const metadata = isRecord(decoded.metadata) ? decoded.metadata : null;
      if (!metadata || !Array.isArray(metadata.queuedInputIds)) return true;
      if (metadata.queuedInputIds.length > 0) return true;
      if (decoded.inputs.length > 0) return true;
      if (
        decoded.dispatchingInputId !== null &&
        decoded.dispatchingInputId !== undefined
      ) {
        return true;
      }
      if (
        (decoded.uncertainInputs !== undefined &&
          !Array.isArray(decoded.uncertainInputs)) ||
        (decoded.uncertainInputIds !== undefined &&
          !Array.isArray(decoded.uncertainInputIds)) ||
        (Array.isArray(decoded.uncertainInputs) &&
          decoded.uncertainInputs.length > 0) ||
        (Array.isArray(decoded.uncertainInputIds) &&
          decoded.uncertainInputIds.length > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whether a scheduled project still needs its one ordinary first session. */
  needsProjectSession(projectId: string, userId: string): Promise<boolean> {
    return this.serialize(`project:${projectId}`, async () => {
      this.assertOpen();
      const intent = await this.readIntent(projectId);
      if (!intent) return false;
      if (intent.userId !== userId) {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      if (intent.status === "scheduled") return true;
      const target = intent.targetSessionId
        ? this.options.sessionManager.get(intent.targetSessionId)
        : undefined;
      if (
        intent.targetSessionId &&
        this.provisionalProjectClaims.get(projectId) === intent.targetSessionId
      ) {
        // A published row is already the durable first-session outcome, even
        // when its process exited before a provider session ID was observed.
        // A missing row can only be replaced after create() releases this
        // provisional fence, proving publication never committed.
        return false;
      }
      return (
        !target &&
        !(await this.targetHasUnresolvedInput(intent.targetSessionId!))
      );
    });
  }

  /** Atomically binds a scheduled project lifecycle to its first real session. */
  claimProject(
    identity: ProjectAgentSession,
    initialUserInputPending = false,
  ): Promise<ProjectBootstrapMetadata | null> {
    return this.serialize(`project:${identity.projectId}`, async () => {
      this.assertOpen();
      const intent = await this.readIntent(identity.projectId);
      if (!intent) return null;
      if (intent.userId !== identity.userId) {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      if (
        intent.status === "claimed" &&
        intent.targetSessionId !== identity.sessionId
      ) {
        const target = this.options.sessionManager.get(intent.targetSessionId!);
        if (
          this.provisionalProjectClaims.get(identity.projectId) ===
          intent.targetSessionId
        ) {
          return null;
        }
        if (target) return null;
        if (await this.targetHasUnresolvedInput(intent.targetSessionId!)) {
          return null;
        }
      }
      const claimed: PersistedProjectBootstrapIntent = {
        ...intent,
        targetSessionId: identity.sessionId,
        status: "claimed",
        updatedAt: this.now(),
      };
      await this.writeIntent(
        this.projectIntentFile(identity.projectId),
        claimed,
      );
      this.provisionalProjectClaims.set(identity.projectId, identity.sessionId);
      this.provisionalSessionClaims.set(identity.sessionId, identity.projectId);
      return {
        projectId: identity.projectId,
        userId: identity.userId,
        targetSessionId: identity.sessionId,
        bootstrap: initialUserInputPending
          ? { status: "skipped", reason: "user-proceeded" }
          : { status: "pending" },
        queuedInputIds: [],
      };
    });
  }

  /** Release only an unpublished/failed create claim. Durable intent remains
   * available for the next proven session and is never deleted. */
  releaseSessionClaim(sessionId: string): Promise<void> {
    const projectId = this.provisionalSessionClaims.get(sessionId);
    if (!projectId) return Promise.resolve();
    return this.serialize(`project:${projectId}`, async () => {
      if (this.provisionalProjectClaims.get(projectId) === sessionId) {
        this.provisionalProjectClaims.delete(projectId);
      }
      this.provisionalSessionClaims.delete(sessionId);
    });
  }

  private async acceptedInputIds(
    sessionId: string,
  ): Promise<Set<string> | null> {
    const file = this.acceptedFile(sessionId);
    try {
      const decoded: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !isRecord(decoded) ||
        decoded.schemaVersion !== 1 ||
        !Array.isArray(decoded.inputIds) ||
        decoded.inputIds.length > MAX_INPUT_RECEIPTS ||
        !decoded.inputIds.every(
          (inputId) => typeof inputId === "string" && inputId !== "",
        ) ||
        new Set(decoded.inputIds).size !== decoded.inputIds.length
      ) {
        throw new Error("invalid accepted-input ledger");
      }
      return new Set(decoded.inputIds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      // An unreadable acknowledgement is safety-significant. Keep the queue's
      // write-ahead intent unresolved instead of guessing and replaying it.
      // The artifact stays in place until its FIFO is durably terminalized;
      // otherwise a crash after quarantine would turn unknown proof into
      // ENOENT and authorize replay on the next process.
      return null;
    }
  }

  private async quarantineAcceptedLedger(sessionId: string): Promise<void> {
    const file = this.acceptedFile(sessionId);
    const quarantine = path.join(
      path.dirname(file),
      `accepted-inputs.corrupt-${this.now().replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.json`,
    );
    await fs.rename(file, quarantine).catch(() => {});
  }

  private async terminalizeUnreadableAcceptedLedger(
    state: PersistedProjectBootstrapState,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const terminal = structuredClone(state);
    const uncertainById = new Map(
      terminal.uncertainInputs.map((input) => [input.id, input]),
    );
    for (const input of terminal.inputs) {
      uncertainById.set(input.id, structuredClone(input));
      const receipt = this.receiptForInput(terminal, input.id);
      if (receipt && receipt.status !== "completed") receipt.status = "uncertain";
    }
    for (const receipt of terminal.receipts) {
      if (receipt.status === "submitted") receipt.status = "uncertain";
    }
    terminal.inputs = [];
    terminal.metadata.queuedInputIds = [];
    terminal.dispatchingInputId = null;
    terminal.uncertainInputs = [...uncertainById.values()];
    terminal.uncertainInputIds = terminal.uncertainInputs.map(
      (input) => input.id,
    );
    await this.persist(sessionId, terminal);
    // Safe state is authoritative before the unreadable artifact moves. A
    // failed rename merely causes the same idempotent normalization next time.
    await this.quarantineAcceptedLedger(sessionId);
    return terminal;
  }

  private async writeAcceptedInputIds(
    sessionId: string,
    inputIds: readonly string[],
  ): Promise<void> {
    const file = this.acceptedFile(sessionId);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const ledger: AcceptedInputLedger = {
      schemaVersion: 1,
      inputIds: [...inputIds],
    };
    if (this.options.writeAcceptedLedger) {
      await this.options.writeAcceptedLedger(file, structuredClone(ledger));
      return;
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async recordAcceptedInput(
    state: PersistedProjectBootstrapState,
    inputId: string,
  ): Promise<void> {
    const sessionId = state.metadata.targetSessionId;
    const accepted = await this.acceptedInputIds(sessionId);
    if (accepted === null) {
      throw new Error("project bootstrap input acceptance ledger unavailable");
    }
    // IDs whose queue entries were already durably removed are stale cleanup
    // residue and can be compacted. The active FIFO is bounded by the request
    // body limit, and only its IDs are retained here (never input content).
    const queuedIds = new Set(state.inputs.map((input) => input.id));
    const retained = [...accepted].filter((id) => queuedIds.has(id));
    if (!retained.includes(inputId)) retained.push(inputId);
    await this.writeAcceptedInputIds(sessionId, retained);
  }

  private async reconcileAcceptedInputs(
    state: PersistedProjectBootstrapState,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const accepted = await this.acceptedInputIds(sessionId);
    if (accepted === null)
      return this.terminalizeUnreadableAcceptedLedger(state);
    if (accepted.size === 0) return state;
    const remaining = state.inputs.filter((input) => !accepted.has(input.id));
    const uncertainById = new Map(
      state.uncertainInputs.map((input) => [input.id, structuredClone(input)]),
    );
    const receipts = structuredClone(state.receipts);
    for (const inputId of accepted) {
      const receipt = receipts.find(
        (candidate) => candidate.inputId === inputId,
      );
      // The side ledger is written only after SessionManager has positively
      // acknowledged the PTY submission. In the live coordinator it is
      // stronger evidence than the stale FIFO/dequeue marker and removes that
      // row without writing Enter again while the active completion barrier
      // remains authoritative. Boot normalization is deliberately separate.
      if (
        receipt &&
        receipt.status !== "completed" &&
        receipt.status !== "uncertain"
      ) {
        receipt.status = "submitted";
      }
      const queued = state.inputs.find((input) => input.id === inputId);
      if (
        queued &&
        receipt?.status === "uncertain"
      ) {
        uncertainById.set(inputId, structuredClone(queued));
      }
    }
    const remainingUncertain = [...uncertainById.values()];
    const remainingUncertainIds = remainingUncertain.map((input) => input.id);
    const changed =
      remaining.length !== state.inputs.length ||
      remainingUncertain.length !== state.uncertainInputs.length ||
      remainingUncertain.some(
        (input, index) => input.id !== state.uncertainInputs[index]?.id,
      ) ||
      receipts.some(
        (receipt, index) => receipt.status !== state.receipts[index]?.status,
      ) ||
      remainingUncertainIds.length !== state.uncertainInputIds.length ||
      remainingUncertainIds.some(
        (inputId, index) => inputId !== state.uncertainInputIds[index],
      ) ||
      (state.dispatchingInputId !== null &&
        accepted.has(state.dispatchingInputId));
    const reconciled: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      inputs: remaining,
      dispatchingInputId:
        state.dispatchingInputId && accepted.has(state.dispatchingInputId)
          ? null
          : state.dispatchingInputId,
      metadata: {
        ...structuredClone(state.metadata),
        queuedInputIds: remaining.map((input) => input.id),
      },
      uncertainInputIds: remainingUncertainIds,
      uncertainInputs: remainingUncertain,
      receipts,
    };
    if (changed) await this.persist(sessionId, reconciled);
    // Only after the authoritative queue/receipt transition is durable may its
    // acknowledgement be removed. A cleanup failure leaves harmless positive
    // proof that the next boot can reconcile again; it never makes Enter
    // replayable.
    await this.writeAcceptedInputIds(
      sessionId,
      [...accepted].filter((id) => remaining.some((input) => input.id === id)),
    ).catch(() => {});
    return reconciled;
  }

  private async resolveUncertainDispatch(
    state: PersistedProjectBootstrapState,
  ): Promise<PersistedProjectBootstrapState> {
    const inputId = state.dispatchingInputId;
    if (inputId === null || state.inputs[0]?.id !== inputId) return state;
    const input = state.inputs[0];
    if (!input) return state;
    const resolved: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      inputs: state.inputs.slice(1),
      dispatchingInputId: null,
      metadata: {
        ...structuredClone(state.metadata),
        queuedInputIds: state.metadata.queuedInputIds.slice(1),
      },
      uncertainInputIds: [...state.uncertainInputIds, inputId],
      uncertainInputs: [...state.uncertainInputs, structuredClone(input)],
      receipts: structuredClone(state.receipts),
    };
    this.updateReceiptStatus(resolved, inputId, "uncertain");
    await this.persist(state.metadata.targetSessionId, resolved);
    this.emit({
      name: "project_bootstrap.input_delivery_uncertain",
      projectId: state.metadata.projectId,
      sessionId: state.metadata.targetSessionId,
      inputId,
      errorCode: "delivery_uncertain",
      queueDepth: state.inputs.length,
    });
    return resolved;
  }

  private async normalizeBootInputState(
    state: PersistedProjectBootstrapState,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const accepted = await this.acceptedInputIds(sessionId);
    if (accepted === null)
      return this.terminalizeUnreadableAcceptedLedger(state);
    const receiptIndexByInput = new Map(
      state.receipts.map((receipt, index) => [receipt.inputId, index]),
    );
    let lastUnsafeReceiptIndex = -1;
    state.receipts.forEach((receipt, index) => {
      if (
        receipt.status === "submitted" ||
        receipt.status === "uncertain" ||
        receipt.status === "completed" ||
        accepted.has(receipt.inputId) ||
        state.dispatchingInputId === receipt.inputId
      ) {
        lastUnsafeReceiptIndex = index;
      }
    });
    // A terminal receipt that no longer has a content row is still positive
    // evidence that a later logical turn crossed the PTY. Every earlier live
    // FIFO row belongs to the same causal prefix and cannot be replayed after
    // restart without reversing arrival order or duplicating work.
    let lastUnsafeIndex = -1;
    state.inputs.forEach((input, index) => {
      const receiptIndex = receiptIndexByInput.get(input.id);
      if (
        receiptIndex !== undefined &&
        receiptIndex <= lastUnsafeReceiptIndex
      ) {
        lastUnsafeIndex = index;
      }
    });

    const terminal = structuredClone(state);
    const uncertainById = new Map(
      terminal.uncertainInputs.map((input) => [input.id, input]),
    );
    // If a later FIFO row is positively accepted or already marked submitted,
    // every earlier row belongs to the same unresolved delivery prefix. A new
    // process cannot replay that prefix without reversing durable arrival
    // order or duplicating a turn, so terminalize it in FIFO order.
    for (const input of terminal.inputs.slice(0, lastUnsafeIndex + 1)) {
      uncertainById.set(input.id, structuredClone(input));
      this.updateReceiptStatus(terminal, input.id, "uncertain");
    }
    terminal.inputs = terminal.inputs.slice(lastUnsafeIndex + 1);
    terminal.metadata.queuedInputIds = terminal.inputs.map((input) => input.id);
    if (lastUnsafeIndex >= 0) terminal.dispatchingInputId = null;

    // Submitted receipts whose payload row was already durably removed still
    // cannot recover live completion correlation in a new process. Likewise,
    // accepted-ledger proof is submission acknowledgement, not completion.
    for (const receipt of terminal.receipts) {
      if (
        receipt.status === "submitted" ||
        (accepted.has(receipt.inputId) &&
          receipt.status !== "completed" &&
          receipt.status !== "uncertain")
      ) {
        receipt.status = "uncertain";
      }
    }
    terminal.uncertainInputs = [...uncertainById.values()];
    terminal.uncertainInputIds = terminal.uncertainInputs.map(
      (input) => input.id,
    );

    const changed = JSON.stringify(terminal) !== JSON.stringify(state);
    if (changed) {
      await this.persist(sessionId, terminal);
      for (const input of state.inputs.slice(0, lastUnsafeIndex + 1)) {
        this.emit({
          name: "project_bootstrap.input_delivery_uncertain",
          projectId: state.metadata.projectId,
          sessionId,
          inputId: input.id,
          errorCode: "delivery_uncertain",
          queueDepth: state.inputs.length,
        });
      }
    }
    // Never discard positive PTY acknowledgement until the canonical
    // non-replayable state is durable. Cleanup is retry-safe and may lag.
    if (accepted.size > 0)
      await this.writeAcceptedInputIds(sessionId, []).catch(() => {});
    return terminal;
  }

  /** Stop timers and settle all queued persistence before server teardown. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.admissionGeneration += 1;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    for (const { handle } of this.activeTurnTimers.values())
      clearTimeout(handle);
    this.activeTurnTimers.clear();
    this.bootstrapFailureTransitions.clear();
    this.pendingBootstrapFailureTransitions.clear();
    this.userNotSubmittedTransitions.clear();
    for (const handle of this.blockingInputRedrainTimers.values())
      clearTimeout(handle);
    this.blockingInputRedrainTimers.clear();
    this.inputRedrainNeeded.clear();
    while (this.writes.size > 0) {
      await Promise.allSettled([...this.writes.values()]);
    }
    // An operation that was already between awaits when close began must not
    // leave any late timer or correlation state behind.
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    for (const { handle } of this.activeTurnTimers.values())
      clearTimeout(handle);
    this.activeTurnTimers.clear();
    for (const handle of this.blockingInputRedrainTimers.values())
      clearTimeout(handle);
    this.blockingInputRedrainTimers.clear();
    this.expected.clear();
    this.observedAttempts.clear();
    this.processedCompletionEvents.clear();
    this.completionDedupeOverflow.clear();
    this.activeTurns.clear();
    this.correlationOverflow.clear();
    this.pendingApiPreemptions.clear();
    this.provisionalProjectClaims.clear();
    this.provisionalSessionClaims.clear();
    this.states.clear();
    this.registeredSessions.clear();
    this.terminalPreemptions.clear();
    this.terminalPreemptionObligations.clear();
    this.blockingTerminalPreemptions.clear();
    for (const handle of this.terminalPreemptionRetryTimers.values())
      clearTimeout(handle);
    this.terminalPreemptionRetryTimers.clear();
    this.reportedTerminalPreemptions.clear();
    this.runtimeEpochs.clear();
  }

  private clearTimer(sessionId: string, key?: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer || (key !== undefined && timer.key !== key)) return;
    clearTimeout(timer.handle);
    this.timers.delete(sessionId);
  }

  private needsLifecycleTimer(
    sessionId: string,
    key: "pending" | string,
    runtimeEpoch: string,
  ): boolean {
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return false;
    if (
      key === "pending" &&
      this.pendingBootstrapFailureTransitions.has(sessionId)
    ) {
      return true;
    }
    if (
      key !== "pending" &&
      this.bootstrapFailureTransitions.get(sessionId)?.attemptId === key
    ) {
      return true;
    }
    const state = this.states.get(sessionId);
    const bootstrap =
      state?.metadata.bootstrap ??
      this.options.sessionManager.get(sessionId)?.projectBootstrap?.bootstrap;
    return key === "pending"
      ? bootstrap?.status === "pending"
      : bootstrap?.status === "generating" && bootstrap.attemptId === key;
  }

  private armTimer(
    sessionId: string,
    key: "pending" | string,
    runtimeEpoch = this.runtimeEpochs.get(sessionId),
  ): void {
    if (
      runtimeEpoch === undefined ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
    )
      return;
    const existing = this.timers.get(sessionId);
    if (existing?.key === key && existing.runtimeEpoch === runtimeEpoch) return;
    this.clearTimer(sessionId);
    const handle = setTimeout(
      () => {
        const fired = this.timers.get(sessionId);
        if (
          fired?.handle !== handle ||
          !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
        )
          return;
        this.timers.delete(sessionId);
        void this.fail(
          sessionId,
          key,
          key === "pending" ? "session_not_ready" : "delivery_timeout",
          key === "pending",
          runtimeEpoch,
        ).catch(() => {
          if (this.needsLifecycleTimer(sessionId, key, runtimeEpoch))
            this.armTimer(sessionId, key, runtimeEpoch);
          // Timer callbacks have no request boundary to receive a rejection.
          // persist() already projects/emits `persistence_failed` wherever one
          // durable store remains; log only a fixed local classification here,
          // never the provider/storage error or planner content.
          console.error(
            "[harness] project bootstrap timeout transition failed: persistence_failed",
          );
        });
      },
      key === "pending" ? this.readinessTimeoutMs : this.deliveryTimeoutMs,
    );
    handle.unref?.();
    this.timers.set(sessionId, { key, runtimeEpoch, handle });
  }

  private armActiveTurnTimer(
    sessionId: string,
    turn: ActiveCoordinatorTurn,
    runtimeEpoch = this.runtimeEpochs.get(sessionId),
  ): void {
    if (
      runtimeEpoch === undefined ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
    )
      return;
    const active = this.activeTurns.get(sessionId);
    // A very fast provider can persist completion before submitInput returns.
    // Never install a timer after that completion already released ownership.
    if (active?.kind !== turn.kind || active.id !== turn.id) return;
    const existing = this.activeTurnTimers.get(sessionId);
    if (
      existing?.turn.kind === turn.kind &&
      existing.turn.id === turn.id &&
      existing.runtimeEpoch === runtimeEpoch
    )
      return;
    if (existing) clearTimeout(existing.handle);
    const handle = setTimeout(() => {
      const fired = this.activeTurnTimers.get(sessionId);
      if (
        fired?.handle !== handle ||
        !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
      )
        return;
      this.activeTurnTimers.delete(sessionId);
      void this.expireActiveTurn(sessionId, turn, runtimeEpoch).catch(() => {
        // The timeout is only a request to persist a conservative terminal
        // boundary. A storage rejection must retain the exact live owner and
        // try that persistence again after another bounded interval; it must
        // never release a successor merely because storage was unavailable.
        const active = this.activeTurns.get(sessionId);
        if (
          this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) &&
          active?.kind === turn.kind &&
          active.id === turn.id
        ) {
          this.armActiveTurnTimer(sessionId, turn, runtimeEpoch);
        }
        console.error(
          "[harness] project bootstrap turn timeout transition failed: persistence_failed",
        );
      });
    }, this.deliveryTimeoutMs);
    handle.unref?.();
    this.activeTurnTimers.set(sessionId, {
      turn: structuredClone(turn),
      runtimeEpoch,
      handle,
    });
  }

  private async commitBootstrapFailureTransition(
    state: PersistedProjectBootstrapState,
    transition: BootstrapFailureTransitionObligation,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const active = this.activeTurns.get(sessionId);
    if (
      active &&
      (active.kind !== "bootstrap" || active.id !== transition.attemptId)
    ) {
      return state;
    }
    const knownAttempt = state.attempts.some(
      (attempt) => attempt.attemptId === transition.attemptId,
    );
    if (!active && !knownAttempt) {
      return state;
    }
    const releaseCorrelation = (): void => {
      if (transition.correlationRelease === "remove") {
        this.removeExpectedGreeting(sessionId, transition.attemptId);
      } else if (transition.correlationRelease === "tombstone") {
        this.tombstoneMissingPromptBarrier(sessionId, {
          kind: "bootstrap",
          id: transition.attemptId,
        });
      } else {
        const observed = this.observedAttempts.get(sessionId)?.[0];
        if (
          observed?.kind === "bootstrap" &&
          observed.id === transition.attemptId
        ) {
          this.consumeObservedTurn(sessionId, observed);
        } else {
          this.tombstoneMissingPromptBarrier(sessionId, {
            kind: "bootstrap",
            id: transition.attemptId,
          });
        }
      }
    };
    if (isTerminal(state.metadata)) {
      // persist() may have committed a terminal fallback before throwing. That
      // satisfies only the state half of this obligation; exact correlation
      // retirement must still land before ownership can be released.
      releaseCorrelation();
      this.bootstrapFailureTransitions.delete(sessionId);
      this.clearActiveTurn(sessionId, "bootstrap", transition.attemptId);
      this.clearTimer(sessionId, transition.attemptId);
      if (state.inputs.length > 0) await this.drainWithRecovery(state);
      return state;
    }

    const next = structuredClone(state);
    this.markAttempt(next, transition.attemptId, "retired");
    next.metadata.bootstrap = next.inputs.length
      ? { status: "skipped", reason: "user-proceeded" }
      : {
          status: "failed",
          retryable: transition.retryable,
          errorCode: transition.errorCode,
        };
    await this.persist(sessionId, next);

    releaseCorrelation();
    this.bootstrapFailureTransitions.delete(sessionId);
    this.clearActiveTurn(sessionId, "bootstrap", transition.attemptId);
    this.clearTimer(sessionId, transition.attemptId);
    if (next.metadata.bootstrap.status === "skipped") {
      this.emit({
        name: "project_bootstrap.skipped",
        projectId: next.metadata.projectId,
        sessionId,
        attemptId: transition.attemptId,
        reason: "user-proceeded",
        queueDepth: next.inputs.length,
      });
      if (next.inputs.length > 0) await this.drainWithRecovery(next);
    } else {
      this.emit({
        name: "project_bootstrap.failed",
        projectId: next.metadata.projectId,
        sessionId,
        attemptId: transition.attemptId,
        errorCode: transition.errorCode,
        retryable: transition.retryable,
        queueDepth: 0,
      });
    }
    return next;
  }

  /**
   * Persist a pre-attempt lifecycle failure without surrendering the one
   * readiness owner first. A failed primary write can project the bounded
   * `persistence_failed` fallback, but this obligation retains the original
   * public cause/retryability and retries only that state transition; it never
   * writes bootstrap prompt bytes.
   */
  private async commitPendingBootstrapFailureTransition(
    state: PersistedProjectBootstrapState,
    transition: PendingBootstrapFailureTransitionObligation,
    drainAfterCommit = true,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const bootstrap = state.metadata.bootstrap;
    if (bootstrap.status === "delivered" || bootstrap.status === "skipped") {
      this.pendingBootstrapFailureTransitions.delete(sessionId);
      this.clearTimer(sessionId, "pending");
      if (drainAfterCommit && state.inputs.length > 0)
        await this.drainWithRecovery(state);
      return state;
    }
    if (bootstrap.status === "generating") {
      // A claim that won after the readiness callback was queued supersedes
      // that stale pending transition. Never overwrite the active attempt.
      this.pendingBootstrapFailureTransitions.delete(sessionId);
      this.clearTimer(sessionId, "pending");
      return state;
    }
    if (
      bootstrap.status === "failed" &&
      bootstrap.errorCode !== "persistence_failed"
    ) {
      // Another exact terminal transition already committed.
      this.pendingBootstrapFailureTransitions.delete(sessionId);
      this.clearTimer(sessionId, "pending");
      return state;
    }

    const next = structuredClone(state);
    next.metadata.bootstrap = next.inputs.length
      ? { status: "skipped", reason: "user-proceeded" }
      : {
          status: "failed",
          retryable: transition.retryable,
          errorCode: transition.errorCode,
        };
    try {
      await this.persist(sessionId, next);
    } catch (error) {
      if (!this.closed) this.armTimer(sessionId, "pending");
      throw error;
    }

    Object.assign(state, structuredClone(next));
    this.pendingBootstrapFailureTransitions.delete(sessionId);
    this.clearTimer(sessionId, "pending");
    if (next.metadata.bootstrap.status === "skipped") {
      this.emit({
        name: "project_bootstrap.skipped",
        projectId: next.metadata.projectId,
        sessionId,
        reason: "user-proceeded",
        queueDepth: next.inputs.length,
      });
      if (drainAfterCommit && next.inputs.length > 0)
        await this.drainWithRecovery(next);
    } else {
      this.emit({
        name: "project_bootstrap.failed",
        projectId: next.metadata.projectId,
        sessionId,
        errorCode: transition.errorCode,
        retryable: transition.retryable,
        queueDepth: 0,
      });
    }
    return next;
  }

  private async commitUserNotSubmittedTransition(
    state: PersistedProjectBootstrapState,
    inputId: string,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = state.metadata.targetSessionId;
    const active = this.activeTurns.get(sessionId);
    if (active?.kind !== "user" || active.id !== inputId) return state;
    const next = structuredClone(state);
    if (next.dispatchingInputId === inputId) next.dispatchingInputId = null;
    await this.persist(sessionId, next);
    this.userNotSubmittedTransitions.delete(sessionId);
    this.removeExpectedPrompt(sessionId, "user", inputId);
    this.clearActiveTurn(sessionId, "user", inputId);
    return next;
  }

  private async expireActiveTurn(
    sessionId: string,
    turn: ActiveCoordinatorTurn,
    runtimeEpoch: string,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      const current = this.activeTurns.get(sessionId);
      if (current?.kind !== turn.kind || current.id !== turn.id) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) {
        throw new Error("project bootstrap session unavailable");
      }
      let state = await this.load(session);
      if (turn.kind === "bootstrap") {
        if (this.terminalPreemptionObligations.has(sessionId)) {
          state = await this.commitTerminalPreemption(state);
        } else if (
          this.bootstrapFailureTransitions.get(sessionId)?.attemptId === turn.id
        ) {
          state = await this.commitBootstrapFailureTransition(
            state,
            this.bootstrapFailureTransitions.get(sessionId)!,
          );
        } else if (
          state.metadata.bootstrap.status === "generating" &&
          state.metadata.bootstrap.attemptId === turn.id
        ) {
          const attempt = state.attempts.find(
            (candidate) => candidate.attemptId === turn.id,
          );
          const positivelyNotSubmitted =
            attempt?.phase === "claimed" || attempt?.phase === "not-submitted";
          const transition: BootstrapFailureTransitionObligation = {
            attemptId: turn.id,
            errorCode: positivelyNotSubmitted
              ? "injection_failed"
              : "delivery_timeout",
            retryable: positivelyNotSubmitted,
            correlationRelease: positivelyNotSubmitted
              ? "remove"
              : "tombstone",
          };
          if (positivelyNotSubmitted)
            this.removeExpectedGreeting(sessionId, turn.id);
          this.bootstrapFailureTransitions.set(sessionId, transition);
          state = await this.commitBootstrapFailureTransition(
            state,
            transition,
          );
        } else {
          // A post-Enter persistence failure may already have projected a
          // bounded `failed` classification through persist()'s fallback
          // store. The deadline still owns retirement of that submitted
          // attempt. Make the retirement durable even though setFailure() no
          // longer matches the now-failed metadata; otherwise retry admission
          // must infer safety from a stale active attempt after restart.
          const retired = structuredClone(state);
          this.markAttempt(retired, turn.id, "retired");
          await this.persist(sessionId, retired);
          state = retired;
        }
      } else {
        if (this.userNotSubmittedTransitions.get(sessionId) === turn.id) {
          state = await this.commitUserNotSubmittedTransition(state, turn.id);
          if (isTerminal(state.metadata) && state.inputs.length > 0)
            await this.drainWithRecovery(state);
          return;
        }
        if (
          state.dispatchingInputId === turn.id &&
          state.inputs[0]?.id === turn.id
        ) {
          // Timeout is the bounded uncertainty boundary. Move the exact head
          // out of the replayable FIFO and into its tombstone in one durable
          // write; an intermediate `uncertain` receipt beside a dispatchable
          // row would be both crash-unsafe and rejected by the schema parser.
          state = await this.resolveUncertainDispatch(state);
        } else {
          this.updateReceiptStatus(state, turn.id, "uncertain");
          await this.persist(sessionId, state);
          this.emit({
            name: "project_bootstrap.input_delivery_uncertain",
            projectId: state.metadata.projectId,
            sessionId,
            inputId: turn.id,
            errorCode: "delivery_uncertain",
            queueDepth: state.inputs.length,
          });
        }
      }
      // Release only after the terminal/non-replayable state is durable. The
      // fired timer was removed by its callback, so clearActiveTurn cannot
      // accidentally erase a newly armed successor deadline.
      const remainingActive = this.activeTurns.get(sessionId);
      if (
        remainingActive?.kind === turn.kind &&
        remainingActive.id === turn.id
      ) {
        this.tombstoneMissingPromptBarrier(sessionId, turn);
        this.clearActiveTurn(sessionId, turn.kind, turn.id);
      }
      if (isTerminal(state.metadata) && state.inputs.length > 0) {
        await this.drainWithRecovery(state);
      }
    });
  }

  private hasRunnableQueuedInput(
    sessionId: string,
    runtimeEpoch: string,
  ): boolean {
    if (
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
      this.hasInputHold(sessionId) ||
      this.hasPendingApiInput(sessionId, runtimeEpoch)
    )
      return false;
    const session = this.options.sessionManager.get(sessionId);
    if (
      !session?.projectBootstrap ||
      !session.ready ||
      session.status !== "running"
    ) {
      return false;
    }
    const state = this.states.get(sessionId);
    const metadata = state?.metadata ?? session.projectBootstrap;
    const queueDepth =
      state?.inputs.length ?? session.projectBootstrap.queuedInputIds.length;
    return isTerminal(metadata) && queueDepth > 0;
  }

  private requestInputRedrain(
    sessionId: string,
    runtimeEpoch = this.currentRuntimeEpoch(sessionId),
  ): void {
    if (
      runtimeEpoch === null ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
    )
      return;
    this.inputRedrainNeeded.add(sessionId);
    this.scheduleInputRedrain(sessionId, runtimeEpoch);
  }

  /**
   * One bounded, non-overlapping wakeup for durable FIFO work. Both event and
   * status paths may consume their immediate wakeup before a transient store
   * failure is observable; the durable queue remains the predicate that keeps
   * this retry alive. Active/raw owners, exit, close, and authorization are
   * rechecked by the serialized drain before any PTY byte.
   */
  private scheduleInputRedrain(
    sessionId: string,
    runtimeEpoch = this.currentRuntimeEpoch(sessionId),
  ): void {
    if (
      runtimeEpoch === null ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
      !this.inputRedrainNeeded.has(sessionId) ||
      !this.hasRunnableQueuedInput(sessionId, runtimeEpoch) ||
      this.blockingInputRedrainTimers.has(sessionId)
    ) {
      return;
    }
    const handle = setTimeout(() => {
      if (this.blockingInputRedrainTimers.get(sessionId) !== handle) return;
      this.blockingInputRedrainTimers.delete(sessionId);
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      void this.drainSessionWithRecovery(sessionId, runtimeEpoch);
    }, this.readinessTimeoutMs);
    handle.unref?.();
    this.blockingInputRedrainTimers.set(sessionId, handle);
  }

  private async drainWithRecovery(
    state: PersistedProjectBootstrapState,
    runtimeEpoch = this.runtimeEpochs.get(state.metadata.targetSessionId),
  ): Promise<ProjectBootstrapDrainOutcome> {
    const sessionId = state.metadata.targetSessionId;
    if (
      runtimeEpoch === undefined ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
    )
      return "not-runnable";
    let outcome: ProjectBootstrapDrainOutcome;
    try {
      outcome = await this.drain(state, runtimeEpoch);
    } catch {
      outcome = "transient-failure";
    }
    if (outcome === "transient-failure") {
      this.inputRedrainNeeded.add(sessionId);
    } else {
      this.inputRedrainNeeded.delete(sessionId);
    }
    this.scheduleInputRedrain(sessionId, runtimeEpoch);
    return outcome;
  }

  private async drainSessionWithRecovery(
    sessionId: string,
    runtimeEpoch: string,
  ): Promise<ProjectBootstrapDrainOutcome> {
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch))
      return "not-runnable";
    let outcome: ProjectBootstrapDrainOutcome;
    try {
      outcome = await this.drainSession(sessionId, runtimeEpoch);
    } catch {
      outcome = "transient-failure";
      console.error(
        "[harness] project bootstrap input redrain failed: persistence_failed",
      );
    }
    if (outcome === "transient-failure") {
      this.inputRedrainNeeded.add(sessionId);
    } else {
      this.inputRedrainNeeded.delete(sessionId);
    }
    this.scheduleInputRedrain(sessionId, runtimeEpoch);
    return outcome;
  }

  private retireAttemptCorrelation(sessionId: string, attemptId: string): void {
    const expected = this.expected.get(sessionId);
    if (expected) {
      this.expected.set(
        sessionId,
        expected.map((entry) =>
          entry.kind === "bootstrap" && entry.id === attemptId
            ? { ...entry, retired: true }
            : entry,
        ),
      );
    }
    const observed = this.observedAttempts.get(sessionId);
    if (observed) {
      this.observedAttempts.set(
        sessionId,
        observed.map((entry) =>
          entry.kind === "bootstrap" && entry.id === attemptId
            ? { ...entry, retired: true }
            : entry,
        ),
      );
    }
  }

  /**
   * A provider prompt hook can be lost even though Enter crossed. Before a
   * timed-out turn releases its successor, reserve its completion slot ahead
   * of later observed prompts. A late completion then consumes only this
   * terminal turn; if it never arrives, the successor reaches its own timeout
   * conservatively instead of being falsely marked complete.
   */
  private tombstoneMissingPromptBarrier(
    sessionId: string,
    turn: ActiveCoordinatorTurn,
  ): void {
    const expected = this.expected.get(sessionId);
    const index = expected?.findIndex(
      (entry) => entry.kind === turn.kind && entry.id === turn.id,
    );
    if (expected && index !== undefined && index >= 0) {
      expected.splice(index, 1);
      if (expected.length === 0) this.expected.delete(sessionId);
      const observed = this.observedAttempts.get(sessionId) ?? [];
      if (observed.length >= MAX_CORRELATION_BARRIERS) {
        this.clearCorrelation(sessionId);
        this.correlationOverflow.add(sessionId);
        return;
      }
      observed.unshift(
        turn.kind === "bootstrap"
          ? { kind: "bootstrap", id: turn.id, retired: true }
          : { kind: "user", id: turn.id },
      );
      this.observedAttempts.set(sessionId, observed);
    } else if (turn.kind === "bootstrap") {
      this.retireAttemptCorrelation(sessionId, turn.id);
    }
  }

  private markAttempt(
    state: PersistedProjectBootstrapState,
    attemptId: string,
    status: "active" | "retired" | "completed",
  ): void {
    const attempt = state.attempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attempt) attempt.status = status;
  }

  private markAttemptPhase(
    state: PersistedProjectBootstrapState,
    attemptId: string,
    phase: ProjectBootstrapAttemptPhase,
  ): void {
    const attempt = state.attempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attempt) attempt.phase = phase;
  }

  /**
   * An API request reached the server before the background Enter crossed the
   * PTY. Return the lifecycle to pending until enqueue() durably commits that
   * user input; if enqueue fails, a later registration can safely retry because
   * this attempt is proven not to have been submitted.
   */
  private async yieldStagedBootstrapToApiInput(
    state: PersistedProjectBootstrapState,
    attemptId: string,
  ): Promise<void> {
    const sessionId = state.metadata.targetSessionId;
    // The prompt is positively known not to have crossed Enter. Removing only
    // this exact expectation immediately prevents an identical newer raw
    // prompt from being mislabeled while the lifecycle commit is pending.
    this.removeExpectedGreeting(sessionId, attemptId);
    const pending = structuredClone(state);
    this.markAttempt(pending, attemptId, "retired");
    pending.metadata.bootstrap = { status: "pending" };
    await this.persist(sessionId, pending);
    // Positive no-Enter evidence makes retry safe, but owner/correlation
    // release still follows the durable lifecycle commit.
    this.clearActiveTurn(sessionId, "bootstrap", attemptId);
    this.clearTimer(sessionId, attemptId);
    this.retireAttemptCorrelation(sessionId, attemptId);
  }

  private removeExpectedGreeting(sessionId: string, attemptId: string): void {
    this.removeExpectedPrompt(sessionId, "bootstrap", attemptId);
  }

  private removeExpectedPrompt(
    sessionId: string,
    kind: ExpectedPrompt["kind"],
    id: string,
  ): void {
    const expected = this.expected.get(sessionId);
    if (!expected) return;
    const remaining = expected.filter(
      (entry) => !(entry.kind === kind && entry.id === id),
    );
    if (remaining.length === 0) this.expected.delete(sessionId);
    else this.expected.set(sessionId, remaining);
  }

  private clearCorrelation(sessionId: string): void {
    this.expected.delete(sessionId);
    this.observedAttempts.delete(sessionId);
    this.correlationOverflow.delete(sessionId);
  }

  private consumeObservedTurn(
    sessionId: string,
    turn: ObservedProjectTurn | undefined,
  ): void {
    if (!turn) return;
    const observed = this.observedAttempts.get(sessionId);
    const head = observed?.[0];
    if (
      !head ||
      head.kind !== turn.kind ||
      (head.kind !== "external" &&
        turn.kind !== "external" &&
        head.id !== turn.id)
    ) {
      return;
    }
    observed.shift();
    if (observed.length === 0) this.observedAttempts.delete(sessionId);
  }

  private claimCompletionEvent(sessionId: string, eventId: string): boolean {
    if (this.completionDedupeOverflow.has(sessionId)) return false;
    const processed = this.processedCompletionEvents.get(sessionId) ?? [];
    if (processed.includes(eventId)) return false;
    if (processed.length >= MAX_COMPLETION_EVENT_RECEIPTS) {
      this.completionDedupeOverflow.add(sessionId);
      return false;
    }
    processed.push(eventId);
    this.processedCompletionEvents.set(sessionId, processed);
    return true;
  }

  private releaseCompletionEvent(sessionId: string, eventId: string): void {
    const processed = this.processedCompletionEvents.get(sessionId);
    if (!processed) return;
    const remaining = processed.filter((candidate) => candidate !== eventId);
    if (remaining.length === 0)
      this.processedCompletionEvents.delete(sessionId);
    else this.processedCompletionEvents.set(sessionId, remaining);
  }

  private async persist(
    sessionId: string,
    state: PersistedProjectBootstrapState,
  ): Promise<void> {
    try {
      await this.writeState(this.file(sessionId), state);
    } catch {
      if (!isTerminal(state.metadata)) {
        const previousBootstrap = state.metadata.bootstrap;
        const attemptId =
          previousBootstrap.status === "generating"
            ? previousBootstrap.attemptId
            : undefined;
        const latestAttempt = state.attempts.at(-1);
        const positivelyPreSubmit =
          !latestAttempt ||
          latestAttempt.phase === "claimed" ||
          latestAttempt.phase === "not-submitted";
        const retryable =
          positivelyPreSubmit &&
          (previousBootstrap.status !== "failed" ||
            previousBootstrap.retryable);
        if (retryable && latestAttempt) latestAttempt.status = "retired";
        state.metadata.bootstrap = state.inputs.length
          ? { status: "skipped", reason: "user-proceeded" }
          : {
              status: "failed",
              retryable,
              errorCode: "persistence_failed",
            };
        // At least one of the two stores may still be available. Keep the
        // bounded classification wherever possible; never persist raw errors.
        let fallbackCommitted = false;
        try {
          await this.options.sessionManager.setProjectBootstrapMetadata(
            sessionId,
            state.metadata,
          );
          fallbackCommitted = true;
        } catch {
          // The primary queue fallback below may still retain the bounded
          // terminal classification.
        }
        try {
          await this.writeState(this.file(sessionId), state);
          fallbackCommitted = true;
        } catch {
          // If sessions.json committed, mergeRegistration treats that terminal
          // projection as authoritative on restart. Only a total two-store
          // outage retains the last committed cache.
        }
        if (fallbackCommitted)
          this.states.set(sessionId, structuredClone(state));
        this.emit({
          name: "project_bootstrap.failed",
          projectId: state.metadata.projectId,
          sessionId,
          ...(attemptId ? { attemptId } : {}),
          errorCode: "persistence_failed",
          retryable,
          queueDepth: state.inputs.length,
        });
      }
      throw new Error("project bootstrap state persistence failed");
    }

    // The queue file contains the full coordinator state and is authoritative.
    // Publish its clone only after that primary write commits: a transient
    // failure before this point must not leave a phantom dispatch intent in
    // memory. SessionManager's sessions.json metadata is a UI/list projection,
    // not a second commit prerequisite. If that projection write fails after
    // the queue commit, aborting here would strand a durable pre-PTY intent
    // that restart must conservatively drop even though submitInput was never
    // called. Keep dispatch moving and retry the projection on every later
    // transition/registration instead.
    this.states.set(sessionId, structuredClone(state));
    await this.options.sessionManager
      .setProjectBootstrapMetadata(sessionId, state.metadata)
      .catch(() => {});
  }

  /**
   * Merge the two durable stores under a single serialized registration CAS.
   * Queue-file inputs are authoritative. A terminal manager greeting is newer
   * than a non-terminal queue greeting (resume suppression), while a terminal
   * queue greeting is newer than a stale non-terminal manager snapshot.
   */
  private mergeRegistration(
    state: PersistedProjectBootstrapState,
    session: HarnessSession,
  ): void {
    if (!session.projectBootstrap) return;
    const managerTerminal = isTerminal(session.projectBootstrap);
    const queueTerminal = isTerminal(state.metadata);
    if (managerTerminal && !queueTerminal) {
      state.metadata.bootstrap = structuredClone(
        session.projectBootstrap.bootstrap,
      );
    }
    state.metadata.queuedInputIds = state.inputs.map((input) => input.id);
  }

  async register(
    session: HarnessSession,
    context: ProjectBootstrapRegistrationContext,
    runtimeEpoch: string | null,
  ): Promise<void> {
    if (this.closed || !session.projectBootstrap) return;
    if (
      context.mode !== "boot" &&
      (runtimeEpoch === null ||
        !this.isRuntimeEpochCurrent(session.id, runtimeEpoch))
    ) {
      throw new ProjectBootstrapDispatchForbiddenError();
    }
    const claimedProjectId = this.provisionalSessionClaims.get(session.id);
    if (
      claimedProjectId &&
      this.provisionalProjectClaims.get(claimedProjectId) === session.id
    ) {
      this.provisionalProjectClaims.delete(claimedProjectId);
      this.provisionalSessionClaims.delete(session.id);
    }
    let shouldStart = false;
    let shouldRetry = false;
    let shouldDrain = false;
    await this.serialize(session.id, async () => {
      const firstRegistration = !this.registeredSessions.has(session.id);
      let terminalTransitionEmitted = false;
      let state = await this.load(session, context.emptyProject);
      this.mergeRegistration(state, session);

      const pendingFailure =
        this.pendingBootstrapFailureTransitions.get(session.id);
      if (pendingFailure) {
        state = await this.commitPendingBootstrapFailureTransition(
          state,
          pendingFailure,
        );
        terminalTransitionEmitted = true;
      }
      const attemptFailure = this.bootstrapFailureTransitions.get(session.id);
      if (attemptFailure) {
        state = await this.commitBootstrapFailureTransition(
          state,
          attemptFailure,
        );
        terminalTransitionEmitted = true;
      }

      if (context.mode === "boot" && firstRegistration) {
        // A fresh process has no live completion barrier. Normalize every
        // accepted/submitted/dispatching FIFO prefix atomically before any
        // drain can write PTY bytes, preserving arrival order and tombstones.
        state = await this.normalizeBootInputState(state);
      }

      if (this.terminalPreemptionObligations.has(session.id)) {
        state = await this.commitTerminalPreemption(state);
        terminalTransitionEmitted = true;
      }

      // Only a process-boot load proves an in-flight dispatch was abandoned.
      // Live re-registration is idempotent and must not fail its active turn.
      if (
        context.mode === "boot" &&
        firstRegistration &&
        state.metadata.bootstrap.status === "generating"
      ) {
        const attemptId = state.metadata.bootstrap.attemptId;
        const attempt = state.attempts.find(
          (candidate) => candidate.attemptId === attemptId,
        );
        const definitelyUnsubmitted =
          attempt?.phase === "claimed" || attempt?.phase === "not-submitted";
        this.markAttempt(state, attemptId, "retired");
        state.metadata.bootstrap = state.inputs.length
          ? { status: "skipped", reason: "user-proceeded" }
          : definitelyUnsubmitted && state.retryCount < MAX_RETRIES
            ? {
                status: "failed",
                retryable: true,
                errorCode: "injection_failed",
              }
            : {
                status: "failed",
                retryable: false,
                errorCode: "delivery_timeout",
              };
        shouldRetry =
          definitelyUnsubmitted &&
          state.inputs.length === 0 &&
          state.retryCount < MAX_RETRIES &&
          session.ready &&
          session.status === "running";
        if (state.inputs.length) {
          terminalTransitionEmitted = true;
          this.emit({
            name: "project_bootstrap.skipped",
            projectId: state.metadata.projectId,
            sessionId: session.id,
            attemptId,
            reason: "user-proceeded",
            queueDepth: state.inputs.length,
          });
        } else if (!shouldRetry) {
          terminalTransitionEmitted = true;
          this.emit({
            name: "project_bootstrap.failed",
            projectId: state.metadata.projectId,
            sessionId: session.id,
            attemptId,
            errorCode: "delivery_timeout",
            retryable: false,
            queueDepth: 0,
          });
        }
      }
      if (
        context.mode === "resumed" &&
        state.metadata.bootstrap.status === "failed" &&
        state.metadata.bootstrap.retryable &&
        state.metadata.bootstrap.errorCode === "injection_failed" &&
        state.retryCount < MAX_RETRIES &&
        state.attempts.at(-1)?.status === "retired" &&
        (state.attempts.at(-1)?.phase === "claimed" ||
          state.attempts.at(-1)?.phase === "not-submitted") &&
        session.ready &&
        session.status === "running"
      ) {
        shouldRetry = true;
      }
      await this.persist(session.id, state);
      if (firstRegistration && context.mode === "created") {
        this.emit({
          name: "project_bootstrap.scheduled",
          projectId: state.metadata.projectId,
          sessionId: session.id,
        });
      } else if (firstRegistration && context.mode === "boot") {
        this.emit({
          name: "project_bootstrap.recovered",
          projectId: state.metadata.projectId,
          sessionId: session.id,
        });
      }
      this.registeredSessions.add(session.id);
      if (
        firstRegistration &&
        !terminalTransitionEmitted &&
        state.metadata.bootstrap.status === "skipped"
      ) {
        this.emit({
          name: "project_bootstrap.skipped",
          projectId: state.metadata.projectId,
          sessionId: session.id,
          reason: state.metadata.bootstrap.reason,
          queueDepth: state.inputs.length,
        });
      }
      if (state.metadata.bootstrap.status === "pending") {
        if (session.status === "exited") {
          await this.setFailure(state, "pending", "session_exited", false);
        } else {
          const allowed = await this.canDispatch(session);
          if (session.ready && session.status === "running" && allowed)
            shouldStart = true;
          else if (allowed && runtimeEpoch !== null)
            this.armTimer(session.id, "pending", runtimeEpoch);
          else
            await this.setFailure(
              state,
              "pending",
              "scope_unavailable",
              false,
            );
        }
      } else if (isTerminal(state.metadata)) {
        shouldDrain =
          session.ready &&
          session.status === "running" &&
          (await this.canDispatch(session));
      }
    });
    if (runtimeEpoch === null) return;
    if (shouldRetry) await this.startGreeting(session.id, true, runtimeEpoch);
    else if (shouldStart)
      await this.startGreeting(session.id, false, runtimeEpoch);
    else if (shouldDrain)
      await this.drainSessionWithRecovery(session.id, runtimeEpoch);
  }

  private async terminalizeRuntimeOwnership(
    session: HarnessSession,
  ): Promise<void> {
    let state = await this.load(session);
    const pendingFailure = this.pendingBootstrapFailureTransitions.get(
      session.id,
    );
    if (pendingFailure) {
      state = await this.commitPendingBootstrapFailureTransition(
        state,
        pendingFailure,
        false,
      );
    }
    const attemptFailure = this.bootstrapFailureTransitions.get(session.id);
    if (attemptFailure) {
      state = await this.commitBootstrapFailureTransition(
        state,
        attemptFailure,
      );
    }
    if (this.terminalPreemptionObligations.has(session.id)) {
      state = await this.commitTerminalPreemption(state);
    }

    const timer = this.timers.get(session.id);
    const activeTurn = this.activeTurns.get(session.id);
    if (activeTurn?.kind === "user") {
      if (this.userNotSubmittedTransitions.get(session.id) === activeTurn.id) {
        state = await this.commitUserNotSubmittedTransition(
          state,
          activeTurn.id,
        );
      } else if (
        state.dispatchingInputId === activeTurn.id &&
        state.inputs[0]?.id === activeTurn.id
      ) {
        // An ambiguous Enter may still own the replayable FIFO head. Remove
        // that exact row and persist its tombstone before admitting a new PTY.
        state = await this.resolveUncertainDispatch(state);
      } else {
        const receipt = this.receiptForInput(state, activeTurn.id);
        if (receipt && receipt.status !== "completed") {
          const exitedState = {
            ...structuredClone(state),
            receipts: structuredClone(state.receipts),
          };
          this.updateReceiptStatus(exitedState, activeTurn.id, "uncertain");
          await this.persist(session.id, exitedState);
          state = exitedState;
        }
      }
    }
    const expectedKey =
      activeTurn?.kind === "bootstrap"
        ? activeTurn.id
        : (timer?.key ??
          (state.metadata.bootstrap.status === "generating"
            ? state.metadata.bootstrap.attemptId
            : "pending"));
    if (activeTurn?.kind === "bootstrap") {
      if (
        state.metadata.bootstrap.status === "generating" &&
        state.metadata.bootstrap.attemptId === activeTurn.id
      ) {
        const transition: BootstrapFailureTransitionObligation = {
          attemptId: activeTurn.id,
          errorCode: "session_exited",
          retryable: false,
          correlationRelease: "tombstone",
        };
        this.bootstrapFailureTransitions.set(session.id, transition);
        state = await this.commitBootstrapFailureTransition(state, transition);
      } else {
        this.markAttempt(state, activeTurn.id, "retired");
        await this.persist(session.id, state);
      }
    } else {
      await this.setFailure(
        state,
        expectedKey,
        "session_exited",
        false,
        false,
      );
    }
    // All fallible state transitions have committed. Volatile correlation is
    // cleared by the caller only after this returns successfully.
    const remainingActive = this.activeTurns.get(session.id);
    if (
      activeTurn &&
      remainingActive?.kind === activeTurn.kind &&
      remainingActive.id === activeTurn.id
    ) {
      this.tombstoneMissingPromptBarrier(session.id, activeTurn);
      this.clearActiveTurn(session.id, activeTurn.kind, activeTurn.id);
    }
  }

  /**
   * Move coordinator ownership between server-issued PTY generations. This is
   * awaited by SessionManager before publishing a replacement handle.
   */
  transitionRuntimeEpoch(
    session: HarnessSession,
    nextRuntimeEpoch: string | null,
  ): Promise<void> {
    return this.serialize(session.id, async () => {
      this.assertOpen();
      const currentRuntimeEpoch = this.runtimeEpochs.get(session.id);
      if (currentRuntimeEpoch === nextRuntimeEpoch) return;
      if (currentRuntimeEpoch !== undefined) {
        if (session.projectBootstrap) {
          await this.terminalizeRuntimeOwnership({
            ...session,
            status: "exited",
            ready: false,
          });
        }
        this.clearRuntimeEpochState(session.id, currentRuntimeEpoch);
      }
      if (nextRuntimeEpoch !== null) {
        if (!nextRuntimeEpoch || nextRuntimeEpoch.length > 128) {
          throw new ProjectBootstrapDispatchForbiddenError();
        }
        this.runtimeEpochs.set(session.id, nextRuntimeEpoch);
      }
    });
  }

  async onSessionStatus(
    session: HarnessSession,
    runtimeEpoch: string | null,
  ): Promise<void> {
    if (
      this.closed ||
      !session.projectBootstrap ||
      runtimeEpoch === null ||
      !this.isRuntimeEpochCurrent(session.id, runtimeEpoch)
    )
      return;
    let action: "start" | "retry" | "drain" | null = null;
    await this.serialize(session.id, async () => {
      if (
        !this.isRuntimeEpochCurrent(session.id, runtimeEpoch) ||
        !this.registeredSessions.has(session.id)
      ) {
        return;
      }
      if (session.status === "exited") {
        await this.terminalizeRuntimeOwnership(session);
        this.clearRuntimeEpochState(session.id, runtimeEpoch);
        return;
      }
      let state = await this.load(session);
      const pendingFailure =
        this.pendingBootstrapFailureTransitions.get(session.id);
      if (pendingFailure) {
        state = await this.commitPendingBootstrapFailureTransition(
          state,
          pendingFailure,
        );
      }
      const attemptFailure = this.bootstrapFailureTransitions.get(session.id);
      if (attemptFailure) {
        state = await this.commitBootstrapFailureTransition(
          state,
          attemptFailure,
        );
      }
      if (this.terminalPreemptionObligations.has(session.id)) {
        state = await this.commitTerminalPreemption(state);
      }
      if (
        session.ready &&
        session.status === "running" &&
        (await this.canDispatch(session))
      ) {
        if (!this.isRuntimeEpochCurrent(session.id, runtimeEpoch)) return;
        const blockingRedrain = this.blockingInputRedrainTimers.get(session.id);
        if (blockingRedrain) {
          clearTimeout(blockingRedrain);
          this.blockingInputRedrainTimers.delete(session.id);
        }
        const recoverableClaim =
          state.metadata.bootstrap.status === "failed" &&
          state.metadata.bootstrap.retryable &&
          (state.metadata.bootstrap.errorCode === "session_not_ready" ||
            state.metadata.bootstrap.errorCode === "injection_failed") &&
          hasSafeBootstrapRetryEvidence(state) &&
          state.retryCount < MAX_RETRIES &&
          state.inputs.length === 0;
        action = recoverableClaim
          ? "retry"
          : isTerminal(state.metadata)
            ? "drain"
            : "start";
      }
    });
    if (!this.isRuntimeEpochCurrent(session.id, runtimeEpoch)) return;
    if (action === "drain")
      await this.drainSessionWithRecovery(session.id, runtimeEpoch);
    else if (action === "retry")
      await this.startGreeting(session.id, true, runtimeEpoch);
    else if (action === "start")
      await this.startGreeting(session.id, false, runtimeEpoch);
  }

  private async startGreeting(
    sessionId: string,
    retry: boolean,
    runtimeEpoch: string,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      let state = await this.load(session);
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      const pendingFailure =
        this.pendingBootstrapFailureTransitions.get(sessionId);
      if (pendingFailure) {
        await this.commitPendingBootstrapFailureTransition(
          state,
          pendingFailure,
        );
        return;
      }
      const attemptFailure = this.bootstrapFailureTransitions.get(sessionId);
      if (attemptFailure) {
        await this.commitBootstrapFailureTransition(state, attemptFailure);
        return;
      }
      if (this.activeTurns.has(sessionId)) {
        if (retry) throw new ProjectBootstrapRetryUnavailableError();
        return;
      }
      if (this.terminalPreemptions.has(sessionId)) {
        this.terminalPreemptionObligations.add(sessionId);
        state = await this.commitTerminalPreemption(state);
        return;
      }
      if (!(await this.canDispatch(session))) {
        if (retry) throw new ProjectBootstrapDispatchForbiddenError();
        if (state.metadata.bootstrap.status === "pending") {
          await this.setFailure(
            state,
            "pending",
            session.status === "exited"
              ? "session_exited"
              : "scope_unavailable",
            false,
          );
        }
        return;
      }
      let mapStillEmpty: boolean;
      try {
        mapStillEmpty =
          (await this.options.isMeaningfullyEmpty?.(
            state.metadata.projectId,
          )) ?? state.emptyProject;
      } catch {
        const expected =
          state.metadata.bootstrap.status === "generating"
            ? state.metadata.bootstrap.attemptId
            : "pending";
        await this.setFailure(state, expected, "persistence_failed", true);
        return;
      }
      if (!mapStillEmpty) {
        state.emptyProject = false;
        state.metadata.bootstrap = {
          status: "skipped",
          reason: "map-not-empty",
        };
        await this.persist(sessionId, state);
        this.emit({
          name: "project_bootstrap.skipped",
          projectId: state.metadata.projectId,
          sessionId,
          reason: "map-not-empty",
          queueDepth: state.inputs.length,
        });
        return;
      }
      if (retry) {
        if (
          state.metadata.bootstrap.status !== "failed" ||
          !state.metadata.bootstrap.retryable ||
          !hasSafeBootstrapRetryEvidence(state) ||
          state.inputs.length > 0 ||
          this.activeTurns.has(sessionId) ||
          state.retryCount >= MAX_RETRIES
        ) {
          throw new ProjectBootstrapRetryUnavailableError();
        }
        state.retryCount += 1;
      } else if (state.metadata.bootstrap.status !== "pending") {
        return;
      }
      const attemptId = this.generateId();
      const claimed = structuredClone(state);
      claimed.metadata.bootstrap = { status: "generating", attemptId };
      claimed.attempts.push({
        attemptId,
        retryOrdinal: claimed.retryCount,
        status: "active",
        phase: "claimed",
      });
      claimed.attempts = claimed.attempts.slice(-8);
      try {
        await this.persist(sessionId, claimed);
      } catch {
        // A ready session can enter this path without a readiness timer. Keep
        // one persistence-only owner after a total primary+fallback failure so
        // the last durable `pending` state cannot become ownerless. This owner
        // never retries the PTY claim or allocates another attempt; it commits
        // the bounded failure classification under the original pending CAS.
        const transition: PendingBootstrapFailureTransitionObligation = {
          errorCode: "persistence_failed",
          retryable: true,
        };
        this.pendingBootstrapFailureTransitions.set(sessionId, transition);
        this.armTimer(sessionId, "pending", runtimeEpoch);
        return;
      }
      state = claimed;
      this.clearTimer(sessionId, "pending");
      this.emit({
        name: retry
          ? "project_bootstrap.retried"
          : "project_bootstrap.attempted",
        projectId: state.metadata.projectId,
        sessionId,
        attemptId,
        retryOrdinal: state.retryCount,
        queueDepth: state.inputs.length,
      });
      const prompt = projectBootstrapPrompt(state.retryCount, attemptId);
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      if (!(await this.canDispatch(session))) {
        await this.setFailure(
          state,
          attemptId,
          session.status === "exited"
            ? "session_exited"
            : "scope_unavailable",
          false,
        );
        if (retry) throw new ProjectBootstrapDispatchForbiddenError();
        return;
      }
      if (this.terminalPreemptions.has(sessionId)) {
        this.markAttempt(state, attemptId, "retired");
        state.metadata.bootstrap = {
          status: "skipped",
          reason: "user-proceeded",
        };
        await this.persist(sessionId, state);
        if (!this.reportedTerminalPreemptions.has(sessionId)) {
          this.reportedTerminalPreemptions.add(sessionId);
          this.emit({
            name: "project_bootstrap.preempted",
            projectId: state.metadata.projectId,
            sessionId,
            attemptId,
            reason: "user-proceeded",
            queueDepth: state.inputs.length,
          });
        }
        return;
      }
      if (this.hasPendingApiInput(sessionId, runtimeEpoch)) {
        await this.yieldStagedBootstrapToApiInput(state, attemptId);
        return;
      }
      // Register before crossing the PTY boundary. A prompt hook may arrive
      // immediately after the write, before submitInput's delayed Enter has
      // resolved; registering afterward loses the only safe correlation.
      const queue = this.expected.get(sessionId) ?? [];
      queue.push({
        kind: "bootstrap",
        id: attemptId,
        text: prompt,
        retired: false,
      });
      this.expected.set(sessionId, queue);
      this.activeTurns.set(sessionId, {
        kind: "bootstrap",
        id: attemptId,
      });
      const admissionGeneration = this.admissionGeneration;
      let crossedEnter = false;
      let durableNotSubmitted = false;
      try {
        const accepted = await this.options.sessionManager.submitInput(
          sessionId,
          prompt,
          true,
          async () =>
            !this.closed &&
            this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) &&
            !this.hasPendingApiInput(sessionId, runtimeEpoch) &&
            (await this.canDispatch(session)),
          true,
          {
            beforeFirstWrite: async () => {
              if (
                !this.isAdmissionCurrent(admissionGeneration) ||
                !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
                this.hasPendingApiInput(sessionId, runtimeEpoch)
              ) {
                throw new SessionInputGuardRejectedError(false);
              }
              this.markAttemptPhase(state, attemptId, "dispatching");
              await this.persist(sessionId, state);
            },
            canWriteNow: () =>
              this.isAdmissionCurrent(admissionGeneration) &&
              this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) &&
              !this.hasPendingApiInput(sessionId, runtimeEpoch),
            onNotSubmitted: async () => {
              if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
              this.markAttemptPhase(state, attemptId, "not-submitted");
              this.markAttempt(state, attemptId, "retired");
              if (
                state.metadata.bootstrap.status === "failed" &&
                state.metadata.bootstrap.errorCode === "persistence_failed"
              ) {
                state.metadata.bootstrap = {
                  ...state.metadata.bootstrap,
                  retryable: true,
                };
              }
              await this.persist(sessionId, state);
              durableNotSubmitted = true;
            },
          },
        );
        if (!accepted) {
          // A false return proves the prompt did not cross the PTY boundary.
          this.markAttemptPhase(state, attemptId, "not-submitted");
          this.removeExpectedGreeting(sessionId, attemptId);
          const transition: BootstrapFailureTransitionObligation = {
            attemptId,
            errorCode:
              session.status === "exited"
                ? "session_exited"
                : "scope_unavailable",
            retryable: false,
            correlationRelease: "remove",
          };
          this.bootstrapFailureTransitions.set(sessionId, transition);
          try {
            await this.commitBootstrapFailureTransition(state, transition);
          } catch {
            this.armActiveTurnTimer(
              sessionId,
              { kind: "bootstrap", id: attemptId },
              runtimeEpoch,
            );
            return;
          }
          return;
        }
        crossedEnter = true;
        this.markAttemptPhase(state, attemptId, "submitted");
        // Enter owns a live model turn now. Arm its bound before any later
        // state write so a storage rejection cannot release queued user input
        // or make this submitted attempt eligible for blind replay.
        if (
          this.isAdmissionCurrent(admissionGeneration) &&
          this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
        ) {
          this.armActiveTurnTimer(
            sessionId,
            { kind: "bootstrap", id: attemptId },
            runtimeEpoch,
          );
        }
        if (
          !this.isAdmissionCurrent(admissionGeneration) ||
          !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
        )
          return;
        await this.persist(sessionId, state);
      } catch (error) {
        if (
          !this.isAdmissionCurrent(admissionGeneration) ||
          !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)
        ) {
          this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          this.removeExpectedGreeting(sessionId, attemptId);
          return;
        }
        if (crossedEnter) {
          // persist() already retains the bounded content-free failure wherever
          // either durable store remains. The live turn and its timer continue
          // to own the CLI until completion or this attempt's own deadline.
          return;
        }
        const positivelyBeforeEnter =
          durableNotSubmitted ||
          error instanceof SessionNotReadyError ||
          (error instanceof SessionInputGuardRejectedError && !error.staged) ||
          (error instanceof SessionBackgroundInputPreemptedError &&
            !error.staged);
        if (!positivelyBeforeEnter) {
          // A text or Enter write can report failure after accepting bytes,
          // and a failed composer cleanup is equally ambiguous. Preserve the
          // submitted-turn owner and give it the same bounded terminalization
          // path as a successful submit. User input accepted concurrently can
          // still preempt metadata, but cannot enter this composer until the
          // ambiguity is durably retired.
          this.armActiveTurnTimer(
            sessionId,
            { kind: "bootstrap", id: attemptId },
            runtimeEpoch,
          );
          return;
        }
        if (
          this.hasPendingApiInput(sessionId, runtimeEpoch) &&
          (error instanceof SessionBackgroundInputPreemptedError ||
            error instanceof SessionInputGuardRejectedError)
        ) {
          try {
            await this.yieldStagedBootstrapToApiInput(state, attemptId);
          } catch {
            this.armActiveTurnTimer(
              sessionId,
              { kind: "bootstrap", id: attemptId },
              runtimeEpoch,
            );
          }
          return;
        }
        if (error instanceof SessionBackgroundInputPreemptedError) {
          if (durableNotSubmitted || !error.staged)
            this.removeExpectedGreeting(sessionId, attemptId);
          try {
            this.terminalPreemptionObligations.add(sessionId);
            state = await this.commitTerminalPreemption(state);
          } catch {
            this.armActiveTurnTimer(
              sessionId,
              { kind: "bootstrap", id: attemptId },
              runtimeEpoch,
            );
            return;
          }
          this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          this.removeExpectedGreeting(sessionId, attemptId);
          this.clearTimer(sessionId, attemptId);
          if (state.inputs.length > 0)
            await this.drainWithRecovery(state, runtimeEpoch);
          return;
        }
        const removeUnsubmittedBarrier =
          error instanceof SessionNotReadyError ||
          (error instanceof SessionInputGuardRejectedError && !error.staged) ||
          durableNotSubmitted;
        const transition: BootstrapFailureTransitionObligation = {
          attemptId,
          errorCode:
            error instanceof SessionNotReadyError
              ? "session_not_ready"
              : error instanceof SessionInputGuardRejectedError
                ? session.status === "exited"
                  ? "session_exited"
                  : "scope_unavailable"
                : "injection_failed",
          retryable:
            error instanceof SessionNotReadyError ||
            (durableNotSubmitted &&
              !(error instanceof SessionInputGuardRejectedError)),
          correlationRelease: removeUnsubmittedBarrier
            ? "remove"
            : "tombstone",
        };
        if (removeUnsubmittedBarrier)
          this.removeExpectedGreeting(sessionId, attemptId);
        this.bootstrapFailureTransitions.set(sessionId, transition);
        try {
          await this.commitBootstrapFailureTransition(state, transition);
        } catch {
          this.armActiveTurnTimer(
            sessionId,
            { kind: "bootstrap", id: attemptId },
            runtimeEpoch,
          );
          return;
        }
        if (retry && error instanceof SessionInputGuardRejectedError) {
          throw new ProjectBootstrapDispatchForbiddenError();
        }
      }
    });
  }

  private async setFailure(
    state: PersistedProjectBootstrapState,
    expectedKey: "pending" | string,
    errorCode: ProjectBootstrapErrorCode,
    retryable: boolean,
    drainAfterCommit = true,
  ): Promise<void> {
    if (expectedKey === "pending") {
      const existing = this.pendingBootstrapFailureTransitions.get(
        state.metadata.targetSessionId,
      );
      if (!existing && state.metadata.bootstrap.status !== "pending") return;
      const transition = existing ?? { errorCode, retryable };
      this.pendingBootstrapFailureTransitions.set(
        state.metadata.targetSessionId,
        transition,
      );
      try {
        await this.commitPendingBootstrapFailureTransition(
          state,
          transition,
          drainAfterCommit,
        );
      } catch (error) {
        if (!this.closed)
          this.armTimer(state.metadata.targetSessionId, "pending");
        throw error;
      }
      return;
    }
    const greeting = state.metadata.bootstrap;
    const sessionId = state.metadata.targetSessionId;
    const existing = this.bootstrapFailureTransitions.get(sessionId);
    if (
      greeting.status !== "generating" &&
      existing?.attemptId !== expectedKey
    ) {
      return;
    }
    if (
      greeting.status === "generating" &&
      greeting.attemptId !== expectedKey
    ) {
      return;
    }
    const attempt = state.attempts.find(
      (candidate) => candidate.attemptId === expectedKey,
    );
    const positivelyNotSubmitted =
      attempt?.phase === "claimed" || attempt?.phase === "not-submitted";
    const transition = existing ?? {
      attemptId: expectedKey,
      errorCode,
      retryable,
      correlationRelease: positivelyNotSubmitted
        ? ("remove" as const)
        : ("tombstone" as const),
    };
    if (transition.correlationRelease === "remove")
      this.removeExpectedGreeting(sessionId, expectedKey);
    this.bootstrapFailureTransitions.set(sessionId, transition);
    try {
      const committed = await this.commitBootstrapFailureTransition(
        state,
        transition,
      );
      Object.assign(state, structuredClone(committed));
      if (!drainAfterCommit) this.inputRedrainNeeded.delete(sessionId);
    } catch (error) {
      if (!this.closed && !this.activeTurns.has(sessionId))
        this.armTimer(sessionId, expectedKey);
      throw error;
    }
  }

  private async fail(
    sessionId: string,
    expectedKey: "pending" | string,
    errorCode: ProjectBootstrapErrorCode,
    retryable: boolean,
    runtimeEpoch: string,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      if (this.terminalPreemptionObligations.has(sessionId)) {
        await this.commitTerminalPreemption(state);
      } else if (expectedKey === "pending") {
        const existing =
          this.pendingBootstrapFailureTransitions.get(sessionId);
        if (!existing && state.metadata.bootstrap.status !== "pending") return;
        const transition = existing ?? { errorCode, retryable };
        this.pendingBootstrapFailureTransitions.set(sessionId, transition);
        await this.commitPendingBootstrapFailureTransition(state, transition);
      } else if (
        this.bootstrapFailureTransitions.get(sessionId)?.attemptId ===
        expectedKey
      ) {
        await this.commitBootstrapFailureTransition(
          state,
          this.bootstrapFailureTransitions.get(sessionId)!,
        );
      } else {
        await this.setFailure(state, expectedKey, errorCode, retryable);
      }
    });
  }

  retry(sessionId: string): Promise<void> {
    if (this.closed)
      return Promise.reject(new ProjectBootstrapCoordinatorClosedError());
    const runtimeEpoch = this.currentRuntimeEpoch(sessionId);
    if (runtimeEpoch === null) {
      return Promise.reject(new ProjectBootstrapDispatchForbiddenError());
    }
    return this.startGreeting(sessionId, true, runtimeEpoch);
  }

  enqueue(sessionId: string, text: string): Promise<ProjectBootstrapMetadata> {
    return this.enqueueWithReceipt(sessionId, text).then(
      (result) => result.metadata,
    );
  }

  async enqueueWithReceipt(
    sessionId: string,
    text: string,
    requestId?: string,
  ): Promise<{
    metadata: ProjectBootstrapMetadata;
    receipt: ProjectBootstrapInputReceipt;
  }> {
    if (this.closed)
      throw new ProjectBootstrapCoordinatorClosedError();
    const known = this.options.sessionManager.get(sessionId);
    if (!known?.projectBootstrap) {
      throw new Error("project bootstrap session not found");
    }
    // Scope/principal/CWD ownership is the read authorization boundary too.
    // Validate it before looking up a durable request receipt so a foreign or
    // rebound caller cannot use idempotency as an existence oracle.
    if (!(await this.canDispatch(known)))
      throw new ProjectBootstrapDispatchForbiddenError();
    const runtimeEpoch = this.currentRuntimeEpoch(sessionId);
    const payloadDigest = this.inputPayloadDigest(text);
    const cachedState = this.states.get(sessionId);
    const cachedReceipt = requestId
      ? cachedState?.receipts.find(
          (receipt) => receipt.requestId === requestId,
        )
      : undefined;
    let pendingInputInstalled = false;

    // This signal is intentionally installed before waiting for the coordinator
    // lock: startGreeting may currently be between its background text write and
    // delayed Enter. Cancelling that staging window gives durable user input
    // priority without ever splicing the two prompts together.
    // A known idempotency receipt is a pure lookup. It must not preempt a live
    // composer or install admission state merely because the response is being
    // retried. If the state has not been loaded yet, defer this decision to the
    // serialized durable lookup below.
    if (
      runtimeEpoch !== null &&
      (!requestId || (cachedState && !cachedReceipt))
    ) {
      this.notePendingApiInput(sessionId, runtimeEpoch);
      pendingInputInstalled = true;
      try {
        this.options.sessionManager.preemptBackgroundInput(sessionId);
      } catch (error) {
        this.clearPendingApiInput(sessionId, runtimeEpoch);
        throw error;
      }
    }

    const operation = this.serialize(sessionId, async () => {
      this.assertOpen();
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap)
        throw new Error("project bootstrap session not found");
      if (!(await this.canDispatch(session)))
        throw new ProjectBootstrapDispatchForbiddenError();
      const state = await this.load(session);
      if (!(await this.canDispatch(session)))
        throw new ProjectBootstrapDispatchForbiddenError();
      const existingReceipt = requestId
        ? state.receipts.find((receipt) => receipt.requestId === requestId)
        : undefined;
      if (existingReceipt) {
        if (existingReceipt.payloadDigest !== payloadDigest) {
          throw new ProjectBootstrapRequestIdConflictError();
        }
        if (
          existingReceipt.status === "queued" &&
          runtimeEpoch !== null &&
          this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) &&
          isTerminal(state.metadata) &&
          !this.hasInputHold(sessionId) &&
          session.ready &&
          session.status === "running" &&
          (await this.canDispatch(session))
        ) {
          // A prior attempt may have positively proved that Enter was never
          // attempted and durably rolled this exact row back to queued. A
          // response-loss retry with the same key is the next admission event:
          // redrive the existing row through the one FIFO authority, never
          // create a replacement receipt. Transient redrive failures leave and
          // return the durable queued/submitted classification.
          if (pendingInputInstalled) {
            this.clearPendingApiInput(sessionId, runtimeEpoch);
            pendingInputInstalled = false;
          }
          await this.drainWithRecovery(state, runtimeEpoch).catch(() => {});
        }
        const latest = this.states.get(sessionId) ?? state;
        const latestReceipt = this.receiptForInput(
          latest,
          existingReceipt.inputId,
        );
        return {
          metadata: structuredClone(latest.metadata),
          receipt: this.publicReceipt(latestReceipt ?? existingReceipt),
        };
      }
      if (
        runtimeEpoch === null ||
        !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
        this.options.sessionManager.getRuntimeEpoch(sessionId) !== runtimeEpoch
      ) {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      if (!pendingInputInstalled) {
        this.notePendingApiInput(sessionId, runtimeEpoch);
        pendingInputInstalled = true;
        this.options.sessionManager.preemptBackgroundInput(sessionId);
      }
      if (session.status === "exited" || !(await this.canDispatch(session))) {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      state.receipts = compactInputReceipts(state.receipts, 1);
      const input: ProjectBootstrapQueuedInput = {
        id: this.generateId(),
        sessionId,
        text,
        acceptedAt: this.now(),
      };
      state.inputs.push(input);
      state.metadata.queuedInputIds.push(input.id);
      state.receipts.push({
        requestId: requestId ?? null,
        inputId: input.id,
        status: "queued",
        acceptedAt: input.acceptedAt,
        payloadDigest,
      });
      const bootstrap = state.metadata.bootstrap;
      const preempt =
        bootstrap.status === "pending" ||
        bootstrap.status === "generating" ||
        bootstrap.status === "failed";
      const attemptId =
        bootstrap.status === "generating" ? bootstrap.attemptId : undefined;
      if (preempt) {
        state.metadata.bootstrap = {
          status: "skipped",
          reason: "user-proceeded",
        };
        if (attemptId) this.markAttempt(state, attemptId, "retired");
      }
      await this.persist(sessionId, state);
      if (preempt) {
        this.clearTimer(sessionId);
        if (attemptId) {
          this.retireAttemptCorrelation(sessionId, attemptId);
          const active = this.activeTurns.get(sessionId);
          const attempt = state.attempts.find(
            (candidate) => candidate.attemptId === attemptId,
          );
          if (
            active?.kind === "bootstrap" &&
            active.id === attemptId &&
            (attempt?.phase === "claimed" ||
              attempt?.phase === "not-submitted")
          ) {
            this.removeExpectedGreeting(sessionId, attemptId);
            this.bootstrapFailureTransitions.delete(sessionId);
            this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          }
        }
        this.emit({
          name: "project_bootstrap.preempted",
          projectId: state.metadata.projectId,
          sessionId,
          ...(attemptId ? { attemptId } : {}),
          reason: "user-proceeded",
          queueDepth: state.inputs.length,
        });
      }
      // Durable acceptance is the API acknowledgement boundary. A project or
      // session rebind after this commit may pause dispatch, but must not turn
      // the accepted request into a client-visible failure that invites a
      // duplicate retry.
      if (isTerminal(state.metadata)) {
        if (pendingInputInstalled) {
          this.clearPendingApiInput(sessionId, runtimeEpoch);
          pendingInputInstalled = false;
        }
        await this.drainWithRecovery(state, runtimeEpoch);
      }
      // drain() advances through immutable queue-state clones. Return the
      // latest authoritative projection rather than the pre-drain object so a
      // 202 response never reports IDs that were already durably dequeued.
      const latest = this.states.get(sessionId) ?? state;
      const receipt = this.receiptForInput(latest, input.id);
      if (!receipt) {
        throw new Error("project bootstrap input receipt unavailable");
      }
      return {
        metadata: structuredClone(latest.metadata),
        receipt: this.publicReceipt(receipt),
      };
    });
    return operation.finally(() => {
      if (pendingInputInstalled && runtimeEpoch !== null)
        this.clearPendingApiInput(sessionId, runtimeEpoch);
    });
  }

  private scheduleTerminalPreemptionRetry(
    sessionId: string,
    runtimeEpoch = this.currentRuntimeEpoch(sessionId),
  ): void {
    if (
      runtimeEpoch === null ||
      !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
      !this.terminalPreemptionObligations.has(sessionId) ||
      this.terminalPreemptionRetryTimers.has(sessionId)
    ) {
      return;
    }
    const handle = setTimeout(() => {
      if (this.terminalPreemptionRetryTimers.get(sessionId) !== handle) return;
      this.terminalPreemptionRetryTimers.delete(sessionId);
      void this.serialize(sessionId, async () => {
        if (
          !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
          !this.terminalPreemptionObligations.has(sessionId)
        )
          return;
        const session = this.options.sessionManager.get(sessionId);
        // Registration is the authoritative publication wakeup for a session
        // that does not yet expose bootstrap metadata. Keep the obligation,
        // but avoid polling an unpublished or removed session.
        if (!session?.projectBootstrap) return;
        const state = await this.load(session);
        await this.commitTerminalPreemption(state);
      }).catch(() =>
        this.scheduleTerminalPreemptionRetry(sessionId, runtimeEpoch),
      );
    }, this.readinessTimeoutMs);
    handle.unref?.();
    this.terminalPreemptionRetryTimers.set(sessionId, handle);
  }

  private async commitTerminalPreemption(
    current: PersistedProjectBootstrapState,
  ): Promise<PersistedProjectBootstrapState> {
    const sessionId = current.metadata.targetSessionId;
    const prior = current.metadata.bootstrap;
    let state = current;
    let attemptId: string | undefined;
    if (!isTerminal(current.metadata)) {
      state = structuredClone(current);
      attemptId =
        prior.status === "generating" ? prior.attemptId : undefined;
      if (attemptId) this.markAttempt(state, attemptId, "retired");
      state.metadata.bootstrap = {
        status: "skipped",
        reason: "user-proceeded",
      };
      // Copy-on-write is intentional: none of the live owner/timer/correlation
      // state moves until this terminal transition is durable.
      try {
        await this.persist(sessionId, state);
      } catch (error) {
        this.scheduleTerminalPreemptionRetry(sessionId);
        throw error;
      }
      this.clearTimer(sessionId);
      if (attemptId) this.retireAttemptCorrelation(sessionId, attemptId);
      if (!this.reportedTerminalPreemptions.has(sessionId)) {
        this.reportedTerminalPreemptions.add(sessionId);
        this.emit({
          name: "project_bootstrap.preempted",
          projectId: state.metadata.projectId,
          sessionId,
          ...(attemptId ? { attemptId } : {}),
          reason: "user-proceeded",
          queueDepth: state.inputs.length,
        });
      }
    }

    const active = this.activeTurns.get(sessionId);
    if (active?.kind === "bootstrap") {
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === active.id,
      );
      if (attempt?.phase === "claimed" || attempt?.phase === "not-submitted") {
        this.removeExpectedGreeting(sessionId, active.id);
        this.clearActiveTurn(sessionId, "bootstrap", active.id);
      }
    }

    const retryTimer = this.terminalPreemptionRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.terminalPreemptionRetryTimers.delete(sessionId);
    }
    this.terminalPreemptionObligations.delete(sessionId);
    if (this.blockingTerminalPreemptions.delete(sessionId)) {
      // Setup/trust bytes may not emit a model completion. Their raw hold is
      // released only after user-proceeded is durable, then one bounded FIFO
      // wakeup is requested.
      this.terminalPreemptions.delete(sessionId);
      this.requestInputRedrain(sessionId);
    } else if (!this.terminalPreemptions.has(sessionId)) {
      // An ordinary raw model turn may have completed while skip persistence
      // was retrying. Its ownership is gone, but its durable obligation still
      // had to commit before queued API work could progress.
      this.requestInputRedrain(sessionId);
    }
    return state;
  }

  /**
   * Raw PTY input is already owned by the user and is never copied into this
   * store. Install its synchronous hold first, then commit the durable
   * user-proceeded transition before releasing any lifecycle owner.
   */
  onTerminalInput(
    sessionId: string,
    context: { runtimeEpoch: string; blockingPrompt: boolean },
  ): void {
    const { runtimeEpoch } = context;
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch)) return;
    this.terminalPreemptionObligations.add(sessionId);
    this.terminalPreemptions.add(sessionId);
    if (context.blockingPrompt)
      this.blockingTerminalPreemptions.add(sessionId);
    else this.blockingTerminalPreemptions.delete(sessionId);
    void this.serialize(sessionId, async () => {
      if (
        !this.isRuntimeEpochCurrent(sessionId, runtimeEpoch) ||
        !this.terminalPreemptionObligations.has(sessionId)
      )
        return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      await this.commitTerminalPreemption(state);
    }).catch(() =>
      this.scheduleTerminalPreemptionRetry(sessionId, runtimeEpoch),
    );
  }

  private async drainSession(
    sessionId: string,
    runtimeEpoch: string,
  ): Promise<ProjectBootstrapDrainOutcome> {
    return this.serialize(sessionId, async () => {
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch))
        return "not-runnable";
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return "not-runnable";
      const state = await this.load(session);
      if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch))
        return "not-runnable";
      if (!isTerminal(state.metadata)) return "owned";
      return this.drain(state, runtimeEpoch);
    });
  }

  private async drain(
    initialState: PersistedProjectBootstrapState,
    runtimeEpoch: string,
  ): Promise<ProjectBootstrapDrainOutcome> {
    const sessionId = initialState.metadata.targetSessionId;
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch))
      return "not-runnable";
    if (this.hasInputHold(sessionId)) return "owned";
    let state: PersistedProjectBootstrapState;
    try {
      // An accepted-input ledger is the commit/ack boundary. If the prior
      // process reached the PTY but failed to rewrite the FIFO, finish that
      // dequeue without submitting the prompt again.
      state = await this.reconcileAcceptedInputs(initialState);
    } catch {
      return "transient-failure";
    }
    const input = state.inputs[0];
    if (!input) return "empty";
    if (this.hasInputHold(sessionId)) return "owned";
    const session = this.options.sessionManager.get(input.sessionId);
    if (!session?.ready || session.status !== "running") return "not-runnable";
    const admissionGeneration = this.admissionGeneration;
    if (!this.isRuntimeEpochCurrent(sessionId, runtimeEpoch))
      return "not-runnable";
    if (!(await this.canDispatch(session, admissionGeneration)))
      return "authorization-denied";

    // A durable intent without a durable acceptance acknowledgement is
    // irreducibly ambiguous across a crash. Never guess by replaying it: a
    // later accepted ledger can complete the dequeue, while automatic replay
    // could duplicate a user message already written to the PTY.
    if (state.dispatchingInputId !== null) {
      try {
        state = await this.resolveUncertainDispatch(state);
      } catch {
        return "transient-failure";
      }
      if (state.dispatchingInputId !== null) return "owned";
      const next = state.inputs[0];
      if (!next) return "progressed";
      if (this.hasInputHold(sessionId)) return "owned";
      return this.drain(state, runtimeEpoch);
    }

    const prepared: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      dispatchingInputId: input.id,
    };
    try {
      await this.persist(input.sessionId, prepared);
    } catch {
      // No external side effect occurred before the intent commit.
      return "transient-failure";
    }
    state = prepared;
    if (!(await this.canDispatch(session, admissionGeneration))) {
      const rollback: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        dispatchingInputId: null,
      };
      try {
        await this.persist(input.sessionId, rollback);
      } catch {
        return "transient-failure";
      }
      return "authorization-denied";
    }

    // Register correlation and the live turn gate before crossing the PTY
    // boundary. Prompt hooks may run before submitInput resolves.
    const queue = this.expected.get(input.sessionId) ?? [];
    queue.push({ kind: "user", id: input.id, text: input.text });
    this.expected.set(input.sessionId, queue);
    this.activeTurns.set(input.sessionId, { kind: "user", id: input.id });
    let accepted = false;
    let durableNotSubmitted: PersistedProjectBootstrapState | null = null;
    const persistNotSubmitted = async (): Promise<void> => {
      if (
        !this.isAdmissionCurrent(admissionGeneration) ||
        !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
      )
        return;
      const rollback: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        dispatchingInputId: null,
      };
      await this.persist(input.sessionId, rollback);
      // Set this only after the rollback is durable. A callback invocation by
      // itself is not enough evidence to make the FIFO row replayable after a
      // process loss.
      durableNotSubmitted = rollback;
    };
    try {
      accepted = await this.options.sessionManager.submitInput(
        input.sessionId,
        input.text,
        true,
        async () =>
          this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch) &&
          (await this.canDispatch(session, admissionGeneration)),
        false,
        {
          canWriteNow: () =>
            this.isAdmissionCurrent(admissionGeneration) &&
            this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch),
          onNotSubmitted: persistNotSubmitted,
        },
      );
    } catch (error) {
      // Readiness and authorization failures are raised before any PTY byte.
      // Persist the same positive rollback proof SessionManager supplies for a
      // pre-Enter text-write rejection. If that write cannot commit, retain
      // the conservative dispatch intent instead of making A replayable.
      if (
        durableNotSubmitted === null &&
        (error instanceof SessionNotReadyError ||
          (error instanceof SessionInputGuardRejectedError && !error.staged) ||
          (error instanceof SessionBackgroundInputPreemptedError &&
            !error.staged))
      ) {
        await persistNotSubmitted().catch(() => {});
      }
      if (durableNotSubmitted !== null) {
        this.clearActiveTurn(input.sessionId, "user", input.id);
        this.removeExpectedPrompt(input.sessionId, "user", input.id);
        if (error instanceof SessionNotReadyError) return "not-runnable";
        if (error instanceof SessionInputGuardRejectedError)
          return "authorization-denied";
        if (error instanceof SessionBackgroundInputPreemptedError)
          return "owned";
        return "transient-failure";
      }
      if (
        !this.isAdmissionCurrent(admissionGeneration) ||
        !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
      )
        return "not-runnable";

      // A generic PTY rejection can come from the Enter write itself. There is
      // no safe way to distinguish "provider did not receive it" from "Enter
      // crossed and the local write reported failure". Keep correlation and
      // active ownership, classify the receipt as submitted, and let this
      // turn's own deadline retire it as uncertain before admitting B.
      const ambiguous: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        receipts: structuredClone(state.receipts),
      };
      this.updateReceiptStatus(ambiguous, input.id, "submitted");
      this.armActiveTurnTimer(input.sessionId, {
        kind: "user",
        id: input.id,
      });
      await this.persist(input.sessionId, ambiguous).catch(() => {});
      return "owned";
    }
    if (!accepted) {
      if (!this.isAdmissionCurrent(admissionGeneration)) return "not-runnable";
      this.userNotSubmittedTransitions.set(input.sessionId, input.id);
      try {
        await this.commitUserNotSubmittedTransition(state, input.id);
      } catch {
        this.armActiveTurnTimer(input.sessionId, {
          kind: "user",
          id: input.id,
        });
        return "owned";
      }
      return "not-runnable";
    }
    // Enter has crossed the PTY boundary, so this logical turn owns its own
    // bounded deadline immediately. Keep that deadline even if any subsequent
    // submitted-state, acknowledgement, or dequeue persistence step fails.
    if (
      this.isAdmissionCurrent(admissionGeneration) &&
      this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
    ) {
      this.armActiveTurnTimer(input.sessionId, {
        kind: "user",
        id: input.id,
      });
    }
    // Enter has crossed the PTY boundary. Persist that fact before any
    // acknowledgement/dequeue work so shutdown or response loss cannot make a
    // submitted logical turn appear safely replayable.
    const submittedState: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      receipts: structuredClone(state.receipts),
    };
    this.updateReceiptStatus(submittedState, input.id, "submitted");
    try {
      await this.persist(input.sessionId, submittedState);
    } catch {
      return "owned";
    }
    state = submittedState;
    if (
      !this.isAdmissionCurrent(admissionGeneration) ||
      !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
    )
      return "owned";
    try {
      await this.recordAcceptedInput(state, input.id);
    } catch {
      // The durable intent remains unresolved and will not be replayed after
      // restart. True PTY exactly-once is impossible without this ack.
      return "owned";
    }

    if (
      !this.isAdmissionCurrent(admissionGeneration) ||
      !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
    )
      return "owned";

    const committed: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      inputs: state.inputs.slice(1),
      dispatchingInputId: null,
      metadata: {
        ...structuredClone(state.metadata),
        queuedInputIds: state.metadata.queuedInputIds.slice(1),
      },
      uncertainInputIds: state.uncertainInputIds.filter(
        (inputId) => inputId !== input.id,
      ),
      receipts: structuredClone(state.receipts),
    };
    this.updateReceiptStatus(committed, input.id, "submitted");
    if (
      !this.isAdmissionCurrent(admissionGeneration) ||
      !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
    )
      return "owned";
    try {
      await this.persist(input.sessionId, committed);
    } catch {
      // The accepted ledger is durable. A restart will finish this exact
      // dequeue without submitting the input twice.
      return "owned";
    }
    await this.writeAcceptedInputIds(input.sessionId, []).catch(() => {});
    if (
      !this.isAdmissionCurrent(admissionGeneration) ||
      !this.isRuntimeEpochCurrent(input.sessionId, runtimeEpoch)
    )
      return "owned";
    // The next FIFO entry is intentionally not submitted here. Its dispatch
    // is released only by this turn's correlated completion.
    return "owned";
  }

  /** Add local-only correlation without removing transcript content. */
  decorateLocalEvent(
    event: AnalyticsEvent,
    runtimeEpoch: string,
  ): AnalyticsEvent {
    if (!this.isRuntimeEpochCurrent(event.harnessSessionId, runtimeEpoch))
      return event;
    const session = this.options.sessionManager.get(event.harnessSessionId);
    const preRegistrationRawHold = this.terminalPreemptions.has(
      event.harnessSessionId,
    );
    if (
      (!session?.projectBootstrap && !preRegistrationRawHold) ||
      event.type !== "prompt.submitted"
    )
      return event;
    if (
      this.correlationOverflow.has(event.harnessSessionId) ||
      this.completionDedupeOverflow.has(event.harnessSessionId)
    ) {
      // Overflow is a fail-closed correlation epoch. No later prompt may
      // establish a trusted barrier until process/session recovery resets the
      // in-memory epoch; otherwise an old completion could claim the new turn.
      return event;
    }
    const prompt =
      typeof event.payload.prompt === "string" ? event.payload.prompt : "";
    const queue = this.expected.get(event.harnessSessionId) ?? [];
    const index = queue.findIndex((entry) => entry.text === prompt);
    const [match] = index < 0 ? [] : queue.splice(index, 1);
    if (queue.length === 0) this.expected.delete(event.harnessSessionId);
    const observed = this.observedAttempts.get(event.harnessSessionId) ?? [];
    // One barrier per observed prompt. turn.completed has no attempt token, so
    // skipping ordinary/user barriers would let their completion release or
    // satisfy a later coordinator-owned turn.
    if (observed.length >= MAX_CORRELATION_BARRIERS) {
      this.clearCorrelation(event.harnessSessionId);
      this.correlationOverflow.add(event.harnessSessionId);
    } else {
      observed.push(
        match?.kind === "bootstrap"
          ? {
              kind: "bootstrap",
              id: match.id,
              retired: match.retired === true,
            }
          : match?.kind === "user"
            ? { kind: "user", id: match.id }
            : { kind: "external" },
      );
      this.observedAttempts.set(event.harnessSessionId, observed);
    }
    if (!match) return event;
    return {
      ...event,
      payload: {
        ...event.payload,
        projectBootstrapOrigin:
          match.kind === "bootstrap" ? "infrastructure" : "user",
        ...(match.kind === "bootstrap"
          ? { projectBootstrapAttemptId: match.id }
          : { projectBootstrapInputId: match.id }),
      },
    };
  }

  /** Bootstrap telemetry receives no prompt, path, or provider content. */
  redactForTelemetry(event: AnalyticsEvent): AnalyticsEvent {
    const session = this.options.sessionManager.get(event.harnessSessionId);
    const nextObserved = this.observedAttempts.get(event.harnessSessionId)?.[0];
    const correlatedAttempt =
      typeof event.payload.projectBootstrapAttemptId === "string" ||
      nextObserved?.kind === "bootstrap";
    const activeBootstrapLifecycle =
      session?.projectBootstrap !== undefined &&
      !isTerminal(session.projectBootstrap);
    const coordinatedUserInput =
      typeof event.payload.projectBootstrapInputId === "string";
    return correlatedAttempt || activeBootstrapLifecycle || coordinatedUserInput
      ? {
          ...event,
          // The normalized hook envelope is attacker-controlled too: every
          // hook can supply `payload.session_id`. The harness session ID is the
          // server-owned project bootstrap correlation key, so provider identity is not
          // needed in remote planner telemetry at all.
          agentSessionId: null,
          payload: telemetryPayload(event),
        }
      : event;
  }

  async onEventPersisted(
    event: AnalyticsEvent,
    runtimeEpoch: string,
  ): Promise<void> {
    if (
      event.type !== "turn.completed" ||
      !this.isRuntimeEpochCurrent(event.harnessSessionId, runtimeEpoch)
    )
      return;
    await this.serialize(event.harnessSessionId, async () => {
      if (!this.isRuntimeEpochCurrent(event.harnessSessionId, runtimeEpoch))
        return;
      if (!this.claimCompletionEvent(event.harnessSessionId, event.eventId)) {
        return;
      }
      let completionCommitted = false;
      try {
        // Overflow invalidates the whole in-memory correlation epoch. Check it
        // before peeking or mutating anything: an old completion must never
        // consume a post-overflow prompt or release its active owner.
        if (this.correlationOverflow.has(event.harnessSessionId)) return;

        const observed = this.observedAttempts.get(event.harnessSessionId);
        const completedTurn = observed?.[0];
        if (completedTurn?.kind === "external") {
          // Consuming the exact barrier is an event-attributable effect. Keep
          // this completion ID retired even if a later load/redrive fails.
          this.consumeObservedTurn(event.harnessSessionId, completedTurn);
          completionCommitted = true;
          this.terminalPreemptions.delete(event.harnessSessionId);
          this.reportedTerminalPreemptions.delete(event.harnessSessionId);
        }

        const session = this.options.sessionManager.get(event.harnessSessionId);
        if (!session?.projectBootstrap) return;
        let state = await this.load(session);
        if (
          this.terminalPreemptionObligations.has(event.harnessSessionId)
        ) {
          state = await this.commitTerminalPreemption(state);
        }

        if (completedTurn?.kind === "user") {
          const receipt = this.receiptForInput(state, completedTurn.id);
          if (receipt && receipt.status !== "uncertain") {
            if (
              state.dispatchingInputId === completedTurn.id &&
              state.inputs[0]?.id === completedTurn.id
            ) {
              const completed: PersistedProjectBootstrapState = {
                ...structuredClone(state),
                inputs: state.inputs.slice(1),
                dispatchingInputId: null,
                metadata: {
                  ...structuredClone(state.metadata),
                  queuedInputIds: state.metadata.queuedInputIds.slice(1),
                },
                uncertainInputIds: state.uncertainInputIds.filter(
                  (inputId) => inputId !== completedTurn.id,
                ),
                uncertainInputs: state.uncertainInputs.filter(
                  (input) => input.id !== completedTurn.id,
                ),
                receipts: structuredClone(state.receipts),
              };
              this.updateReceiptStatus(
                completed,
                completedTurn.id,
                "completed",
              );
              await this.persist(event.harnessSessionId, completed);
              state = completed;
              await this.writeAcceptedInputIds(
                event.harnessSessionId,
                [],
              ).catch(() => {});
            } else {
              const completed = structuredClone(state);
              this.updateReceiptStatus(
                completed,
                completedTurn.id,
                "completed",
              );
              await this.persist(event.harnessSessionId, completed);
              state = completed;
            }
            completionCommitted = true;
            this.clearActiveTurn(
              event.harnessSessionId,
              "user",
              completedTurn.id,
            );
          }
          // A previously terminal uncertain receipt is monotonic, but its
          // exact late completion must still consume only its own tombstone.
          completionCommitted = true;
          this.consumeObservedTurn(event.harnessSessionId, completedTurn);
        }

        if (state.metadata.bootstrap.status !== "generating") {
          const activeBootstrap = this.activeTurns.get(
            event.harnessSessionId,
          );
          if (
            completedTurn?.kind === "bootstrap" &&
            !completedTurn.retired &&
            activeBootstrap?.kind === "bootstrap" &&
            activeBootstrap.id === completedTurn.id &&
            state.metadata.bootstrap.status === "failed" &&
            state.metadata.bootstrap.errorCode === "persistence_failed"
          ) {
            const assistantText = event.payload.assistantText;
            if (
              typeof assistantText !== "string" ||
              assistantText.trim() === ""
            ) {
              const transition =
                this.bootstrapFailureTransitions.get(
                  event.harnessSessionId,
                ) ?? {
                  attemptId: completedTurn.id,
                  errorCode: "model_turn_failed" as const,
                  retryable: true,
                  correlationRelease:
                    "consume-observed-or-tombstone" as const,
                };
              this.bootstrapFailureTransitions.set(
                event.harnessSessionId,
                transition,
              );
              state = await this.commitBootstrapFailureTransition(
                state,
                transition,
              );
              completionCommitted = true;
              this.consumeObservedTurn(event.harnessSessionId, completedTurn);
              return;
            }
            const delivered = structuredClone(state);
            delivered.metadata.bootstrap = {
              status: "delivered",
              messageId: event.eventId,
            };
            this.markAttempt(delivered, completedTurn.id, "completed");
            await this.persist(event.harnessSessionId, delivered);
            state = delivered;
            completionCommitted = true;
            this.bootstrapFailureTransitions.delete(event.harnessSessionId);
            this.consumeObservedTurn(event.harnessSessionId, completedTurn);
            this.clearActiveTurn(
              event.harnessSessionId,
              "bootstrap",
              completedTurn.id,
            );
            this.emit({
              name: "project_bootstrap.delivered",
              projectId: state.metadata.projectId,
              sessionId: event.harnessSessionId,
              attemptId: completedTurn.id,
              queueDepth: state.inputs.length,
            });
            if (state.inputs.length > 0) await this.drainWithRecovery(state);
            return;
          }
          if (
            completedTurn?.kind === "bootstrap" &&
            state.metadata.bootstrap.status === "failed" &&
            state.metadata.bootstrap.errorCode === "delivery_timeout" &&
            !state.metadata.bootstrap.retryable &&
            state.inputs.length === 0 &&
            state.retryCount < MAX_RETRIES
          ) {
            const retryable = structuredClone(state);
            retryable.metadata.bootstrap = {
              status: "failed",
              retryable: true,
              errorCode: "delivery_timeout",
            };
            await this.persist(event.harnessSessionId, retryable);
            state = retryable;
            completionCommitted = true;
          }
          if (completedTurn?.kind === "bootstrap") {
            completionCommitted = true;
            this.consumeObservedTurn(event.harnessSessionId, completedTurn);
            this.clearActiveTurn(
              event.harnessSessionId,
              "bootstrap",
              completedTurn.id,
            );
          }
          if (isTerminal(state.metadata) && state.inputs.length > 0)
            await this.drainWithRecovery(state);
          return;
        }

        const attemptId = state.metadata.bootstrap.attemptId;
        if (completedTurn?.kind !== "bootstrap") return;
        if (completedTurn.retired || completedTurn.id !== attemptId) {
          completionCommitted = true;
          this.consumeObservedTurn(event.harnessSessionId, completedTurn);
          return;
        }
        const text = event.payload.assistantText;
        if (typeof text !== "string" || text.trim() === "") {
          const transition: BootstrapFailureTransitionObligation = {
            attemptId,
            errorCode: "model_turn_failed",
            retryable: true,
            correlationRelease: "consume-observed-or-tombstone",
          };
          this.bootstrapFailureTransitions.set(
            event.harnessSessionId,
            transition,
          );
          state = await this.commitBootstrapFailureTransition(
            state,
            transition,
          );
          completionCommitted = true;
          this.consumeObservedTurn(event.harnessSessionId, completedTurn);
          return;
        }

        const delivered = structuredClone(state);
        delivered.metadata.bootstrap = {
          status: "delivered",
          messageId: event.eventId,
        };
        this.markAttempt(delivered, attemptId, "completed");
        await this.persist(event.harnessSessionId, delivered);
        state = delivered;
        completionCommitted = true;
        this.bootstrapFailureTransitions.delete(event.harnessSessionId);
        this.consumeObservedTurn(event.harnessSessionId, completedTurn);
        this.clearActiveTurn(
          event.harnessSessionId,
          "bootstrap",
          attemptId,
        );
        this.clearTimer(event.harnessSessionId, attemptId);
        this.emit({
          name: "project_bootstrap.delivered",
          projectId: state.metadata.projectId,
          sessionId: event.harnessSessionId,
          attemptId,
          queueDepth: state.inputs.length,
        });
        await this.drainWithRecovery(state);
      } catch (error) {
        if (!completionCommitted) {
          // Failure preceded every durable/correlation effect, so an exact
          // retry may safely attempt this same commit. Once any effect lands,
          // retirement is monotonic even if successor redrive fails.
          this.releaseCompletionEvent(event.harnessSessionId, event.eventId);
        } else {
          this.inputRedrainNeeded.add(event.harnessSessionId);
          this.scheduleInputRedrain(event.harnessSessionId, runtimeEpoch);
        }
        throw error;
      }
    });
  }
}

/**
 * @deprecated Rolling compatibility aliases for persisted clients and tests.
 * Remove with the bounded planner HTTP aliases in SAP-3152.
 */
export {
  ProjectBootstrapCoordinator as PlannerGreetingCoordinator,
  ProjectBootstrapDispatchForbiddenError as PlannerDispatchForbiddenError,
  ProjectBootstrapRetryUnavailableError as PlannerGreetingRetryUnavailableError,
};
export type PlannerRegistrationMode = ProjectBootstrapRegistrationMode;

/** @deprecated SAP-3152 removes the planner-named compatibility export. */
export function plannerGreetingPrompt(
  _emptyProject?: boolean,
  retryOrdinal: number | string = 0,
): string {
  return typeof retryOrdinal === "string"
    ? projectBootstrapPrompt(0, retryOrdinal)
    : projectBootstrapPrompt(retryOrdinal);
}
