import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ProjectBootstrapErrorCode,
  ProjectBootstrapLifecycleEvent,
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

interface PersistedProjectBootstrapState {
  schemaVersion: 2;
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
  }>;
  /** IDs retained for schema-2 compatibility and bounded inspection. */
  uncertainInputIds: string[];
  /**
   * Durable, content-bearing tombstones for FIFO entries whose PTY acceptance
   * could not be proven. They are removed from the dispatchable FIFO so later
   * user input can progress, but are never replayed or discarded.
   */
  uncertainInputs: ProjectBootstrapQueuedInput[];
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
  handle: ReturnType<typeof setTimeout>;
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

const MAX_RETRIES = 2;

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
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
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
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.filter(
        (
          attempt,
        ): attempt is PersistedProjectBootstrapState["attempts"][number] =>
          isRecord(attempt) &&
          typeof attempt.attemptId === "string" &&
          Number.isSafeInteger(attempt.retryOrdinal) &&
          ["active", "retired", "completed"].includes(String(attempt.status)),
      )
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
  const normalizedBootstrap = structuredClone(
    bootstrap,
  ) as ProjectBootstrapMetadata["bootstrap"];
  if (attempts.length === 0 && normalizedBootstrap.status === "generating") {
    attempts.push({
      attemptId: normalizedBootstrap.attemptId,
      retryOrdinal: Math.max(0, Number(value.retryCount) || 0),
      status: "active",
    });
  }
  return {
    schemaVersion: 2,
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
  private readonly expected = new Map<string, ExpectedPrompt[]>();
  private readonly observedAttempts = new Map<string, ObservedProjectTurn[]>();
  /** At most one coordinator-owned prompt may have crossed Enter without a
   * correlated turn completion. This is deliberately separate from durable
   * FIFO acceptance: accepted user input remains durable even while its turn
   * temporarily owns the live CLI. */
  private readonly activeTurns = new Map<string, ActiveCoordinatorTurn>();
  private readonly correlationOverflow = new Set<string>();
  private readonly timers = new Map<string, AttemptTimer>();
  /** Project claims made before SessionManager publishes the new session. */
  private readonly provisionalProjectClaims = new Map<string, string>();
  private readonly provisionalSessionClaims = new Map<string, string>();
  /** Synchronous API-arrival signal used to cancel a staged background Enter
   * before the durable FIFO operation reaches this coordinator's lock. */
  private readonly pendingApiPreemptions = new Map<string, number>();
  /** Status hooks can race a freshly spawned PTY ahead of registration. */
  private readonly registeredSessions = new Set<string>();
  /** Set synchronously by raw terminal input, including before registration. */
  private readonly terminalPreemptions = new Set<string>();
  private readonly reportedTerminalPreemptions = new Set<string>();
  private closed = false;

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

  private async canDispatch(session: HarnessSession): Promise<boolean> {
    try {
      return (await this.options.canDispatch?.(session)) ?? true;
    } catch {
      return false;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ProjectBootstrapCoordinatorClosedError();
  }

  private hasPendingApiInput(sessionId: string): boolean {
    return (this.pendingApiPreemptions.get(sessionId) ?? 0) > 0;
  }

  private notePendingApiInput(sessionId: string): void {
    this.pendingApiPreemptions.set(
      sessionId,
      (this.pendingApiPreemptions.get(sessionId) ?? 0) + 1,
    );
  }

  private clearPendingApiInput(sessionId: string): void {
    const remaining = (this.pendingApiPreemptions.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) this.pendingApiPreemptions.delete(sessionId);
    else this.pendingApiPreemptions.set(sessionId, remaining);
  }

  private hasInputHold(sessionId: string): boolean {
    return (
      this.activeTurns.has(sessionId) || this.terminalPreemptions.has(sessionId)
    );
  }

  private clearActiveTurn(
    sessionId: string,
    kind: ActiveCoordinatorTurn["kind"],
    id: string,
  ): void {
    const active = this.activeTurns.get(sessionId);
    if (active?.kind === kind && active.id === id) {
      this.activeTurns.delete(sessionId);
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

  private newState(
    session: HarnessSession,
    emptyProject: boolean,
  ): PersistedProjectBootstrapState {
    if (!session.projectBootstrap) {
      throw new Error("project bootstrap metadata missing");
    }
    return {
      schemaVersion: 2,
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
        if (target?.status === "exited" && target.agentSessionId === null) {
          this.provisionalProjectClaims.delete(projectId);
          this.provisionalSessionClaims.delete(intent.targetSessionId);
        } else {
          return false;
        }
      }
      // A create that failed before the provider ever owned a conversation
      // leaves an exited registry tombstone. Preserve that record, but let the
      // next ordinary session take over the still-unfulfilled project intent.
      const replaceable =
        !target ||
        (target.status === "exited" && target.agentSessionId === null);
      return (
        replaceable &&
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
          if (target?.status === "exited" && target.agentSessionId === null) {
            this.provisionalProjectClaims.delete(identity.projectId);
            this.provisionalSessionClaims.delete(intent.targetSessionId!);
          } else {
            return null;
          }
        }
        if (
          target &&
          !(target.status === "exited" && target.agentSessionId === null)
        ) {
          return null;
        }
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
        !decoded.inputIds.every(
          (inputId) => typeof inputId === "string" && inputId !== "",
        )
      ) {
        throw new Error("invalid accepted-input ledger");
      }
      return new Set(decoded.inputIds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      // An unreadable acknowledgement is safety-significant. Keep the queue's
      // write-ahead intent unresolved instead of guessing and replaying it.
      const quarantine = path.join(
        path.dirname(file),
        `accepted-inputs.corrupt-${this.now().replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.json`,
      );
      await fs.rename(file, quarantine).catch(() => {});
      return null;
    }
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
    if (accepted === null || accepted.size === 0) return state;
    const remaining = state.inputs.filter((input) => !accepted.has(input.id));
    const remainingUncertain = state.uncertainInputs.filter(
      (input) => !accepted.has(input.id),
    );
    if (
      remaining.length === state.inputs.length &&
      remainingUncertain.length === state.uncertainInputs.length
    )
      return state;
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
      uncertainInputIds: state.uncertainInputIds.filter(
        (inputId) => !accepted.has(inputId),
      ),
      uncertainInputs: remainingUncertain,
    };
    await this.persist(sessionId, reconciled);
    // The queue commit is now authoritative. Ledger cleanup is best effort:
    // stale accepted IDs are harmless and are compacted on the next accept.
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
    };
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

  /** Stop timers and settle all queued persistence before server teardown. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    while (this.writes.size > 0) {
      await Promise.allSettled([...this.writes.values()]);
    }
    // An operation that was already between awaits when close began must not
    // leave any late timer or correlation state behind.
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.expected.clear();
    this.observedAttempts.clear();
    this.activeTurns.clear();
    this.correlationOverflow.clear();
    this.pendingApiPreemptions.clear();
    this.provisionalProjectClaims.clear();
    this.provisionalSessionClaims.clear();
    this.states.clear();
    this.registeredSessions.clear();
    this.terminalPreemptions.clear();
    this.reportedTerminalPreemptions.clear();
  }

  private clearTimer(sessionId: string, key?: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer || (key !== undefined && timer.key !== key)) return;
    clearTimeout(timer.handle);
    this.timers.delete(sessionId);
  }

  private armTimer(sessionId: string, key: "pending" | string): void {
    if (this.closed) return;
    if (this.timers.get(sessionId)?.key === key) return;
    this.clearTimer(sessionId);
    const handle = setTimeout(
      () => {
        void this.fail(
          sessionId,
          key,
          key === "pending" ? "session_not_ready" : "delivery_timeout",
          key === "pending",
        ).catch(() => {
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
    this.timers.set(sessionId, { key, handle });
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
    this.clearActiveTurn(sessionId, "bootstrap", attemptId);
    this.clearTimer(sessionId, attemptId);
    this.removeExpectedGreeting(sessionId, attemptId);
    this.retireAttemptCorrelation(sessionId, attemptId);
    this.markAttempt(state, attemptId, "retired");
    state.metadata.bootstrap = { status: "pending" };
    await this.persist(sessionId, state);
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

  private async persist(
    sessionId: string,
    state: PersistedProjectBootstrapState,
  ): Promise<void> {
    try {
      await this.writeState(this.file(sessionId), state);
    } catch {
      if (!isTerminal(state.metadata)) {
        const attemptId =
          state.metadata.bootstrap.status === "generating"
            ? state.metadata.bootstrap.attemptId
            : undefined;
        this.clearTimer(sessionId);
        state.metadata.bootstrap = state.inputs.length
          ? { status: "skipped", reason: "user-proceeded" }
          : {
              status: "failed",
              retryable: true,
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
          retryable: true,
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
  ): Promise<void> {
    if (this.closed || !session.projectBootstrap) return;
    const claimedProjectId = this.provisionalSessionClaims.get(session.id);
    if (
      claimedProjectId &&
      this.provisionalProjectClaims.get(claimedProjectId) === session.id
    ) {
      this.provisionalProjectClaims.delete(claimedProjectId);
      this.provisionalSessionClaims.delete(session.id);
    }
    let shouldStart = false;
    let shouldDrain = false;
    await this.serialize(session.id, async () => {
      const firstRegistration = !this.registeredSessions.has(session.id);
      let terminalTransitionEmitted = false;
      const cached = this.states.has(session.id);
      const state = await this.load(session, context.emptyProject);
      this.mergeRegistration(state, session);

      if (
        this.terminalPreemptions.has(session.id) &&
        !isTerminal(state.metadata)
      ) {
        const attemptId =
          state.metadata.bootstrap.status === "generating"
            ? state.metadata.bootstrap.attemptId
            : undefined;
        if (attemptId) this.markAttempt(state, attemptId, "retired");
        state.metadata.bootstrap = {
          status: "skipped",
          reason: "user-proceeded",
        };
      }

      // Only a process-boot load proves an in-flight dispatch was abandoned.
      // Live re-registration is idempotent and must not fail its active turn.
      if (
        context.mode === "boot" &&
        !cached &&
        state.metadata.bootstrap.status === "generating"
      ) {
        const attemptId = state.metadata.bootstrap.attemptId;
        this.markAttempt(state, attemptId, "retired");
        state.metadata.bootstrap = state.inputs.length
          ? { status: "skipped", reason: "user-proceeded" }
          : {
              status: "failed",
              retryable: false,
              errorCode: "delivery_timeout",
            };
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
        } else {
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
          else if (allowed) this.armTimer(session.id, "pending");
          else await this.setFailure(state, "pending", "session_exited", false);
        }
      } else if (isTerminal(state.metadata)) {
        shouldDrain =
          session.ready &&
          session.status === "running" &&
          (await this.canDispatch(session));
      }
    });
    if (shouldStart) await this.startGreeting(session.id, false);
    else if (shouldDrain) await this.drainSession(session.id);
  }

  async onSessionStatus(session: HarnessSession): Promise<void> {
    if (this.closed || !session.projectBootstrap) return;
    let action: "start" | "drain" | null = null;
    await this.serialize(session.id, async () => {
      if (this.closed || !this.registeredSessions.has(session.id)) {
        return;
      }
      const current = this.options.sessionManager.get(session.id);
      if (!current?.projectBootstrap) return;
      const state = await this.load(current);
      if (current.status === "exited") {
        const timer = this.timers.get(session.id);
        this.clearTimer(session.id);
        this.clearCorrelation(session.id);
        this.activeTurns.delete(session.id);
        this.terminalPreemptions.delete(session.id);
        this.reportedTerminalPreemptions.delete(session.id);
        const expectedKey =
          timer?.key ??
          (state.metadata.bootstrap.status === "generating"
            ? state.metadata.bootstrap.attemptId
            : "pending");
        await this.setFailure(state, expectedKey, "session_exited", false);
        return;
      }
      if (
        current.ready &&
        current.status === "running" &&
        (await this.canDispatch(current))
      ) {
        if (this.closed) return;
        this.clearTimer(session.id, "pending");
        action = isTerminal(state.metadata) ? "drain" : "start";
      }
    });
    if (this.closed) return;
    if (action === "drain") await this.drainSession(session.id);
    else if (action === "start") await this.startGreeting(session.id, false);
  }

  private async startGreeting(
    sessionId: string,
    retry: boolean,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.closed) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      if (this.closed) return;
      if (this.activeTurns.has(sessionId)) {
        if (retry) throw new ProjectBootstrapRetryUnavailableError();
        return;
      }
      if (this.terminalPreemptions.has(sessionId)) {
        if (!isTerminal(state.metadata)) {
          const attemptId =
            state.metadata.bootstrap.status === "generating"
              ? state.metadata.bootstrap.attemptId
              : undefined;
          if (attemptId) this.markAttempt(state, attemptId, "retired");
          state.metadata.bootstrap = {
            status: "skipped",
            reason: "user-proceeded",
          };
          await this.persist(sessionId, state);
        }
        return;
      }
      if (!(await this.canDispatch(session))) {
        if (retry) throw new ProjectBootstrapDispatchForbiddenError();
        if (state.metadata.bootstrap.status === "pending") {
          await this.setFailure(state, "pending", "session_exited", false);
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
      this.clearTimer(sessionId, "pending");
      const attemptId = this.generateId();
      state.metadata.bootstrap = { status: "generating", attemptId };
      state.attempts.push({
        attemptId,
        retryOrdinal: state.retryCount,
        status: "active",
      });
      state.attempts = state.attempts.slice(-8);
      await this.persist(sessionId, state);
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
      if (this.closed) return;
      if (!(await this.canDispatch(session))) {
        await this.setFailure(state, attemptId, "session_exited", false);
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
      if (this.hasPendingApiInput(sessionId)) {
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
      try {
        const accepted = await this.options.sessionManager.submitInput(
          sessionId,
          prompt,
          true,
          async () =>
            !this.closed &&
            !this.hasPendingApiInput(sessionId) &&
            (await this.canDispatch(session)),
          true,
        );
        if (!accepted) {
          // A false return proves the prompt did not cross the PTY boundary.
          this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          this.removeExpectedGreeting(sessionId, attemptId);
          await this.setFailure(state, attemptId, "session_exited", false);
          return;
        }
        if (this.closed) return;
        this.armTimer(sessionId, attemptId);
      } catch (error) {
        if (
          this.hasPendingApiInput(sessionId) &&
          (error instanceof SessionBackgroundInputPreemptedError ||
            error instanceof SessionInputGuardRejectedError)
        ) {
          this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          await this.yieldStagedBootstrapToApiInput(state, attemptId);
          return;
        }
        if (error instanceof SessionBackgroundInputPreemptedError) {
          this.clearActiveTurn(sessionId, "bootstrap", attemptId);
          this.removeExpectedGreeting(sessionId, attemptId);
          this.clearTimer(sessionId, attemptId);
          this.retireAttemptCorrelation(sessionId, attemptId);
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
        if (
          error instanceof SessionNotReadyError ||
          (error instanceof SessionInputGuardRejectedError && !error.staged)
        ) {
          // Both cases prove absence at the PTY boundary. A guard rejection
          // after staging is intentionally retained/retired as uncertain.
          this.removeExpectedGreeting(sessionId, attemptId);
        }
        // submitInput only resolves after Enter. Every rejection proves that
        // this attempt does not own a running model turn, even if its text had
        // briefly been staged in the composer.
        this.clearActiveTurn(sessionId, "bootstrap", attemptId);
        await this.setFailure(
          state,
          attemptId,
          error instanceof SessionNotReadyError
            ? "session_not_ready"
            : error instanceof SessionInputGuardRejectedError
              ? "session_exited"
              : "injection_failed",
          !(error instanceof SessionInputGuardRejectedError),
        );
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
  ): Promise<void> {
    const greeting = state.metadata.bootstrap;
    const matches =
      (expectedKey === "pending" && greeting.status === "pending") ||
      (greeting.status === "generating" && greeting.attemptId === expectedKey);
    if (!matches) return;
    const sessionId = state.metadata.targetSessionId;
    const attemptId =
      greeting.status === "generating" ? greeting.attemptId : undefined;
    this.clearTimer(sessionId, expectedKey);
    if (attemptId) {
      this.retireAttemptCorrelation(sessionId, attemptId);
      this.markAttempt(state, attemptId, "retired");
    }
    if (state.inputs.length > 0) {
      state.metadata.bootstrap = {
        status: "skipped",
        reason: "user-proceeded",
      };
      await this.persist(sessionId, state);
      this.clearCorrelation(sessionId);
      this.emit({
        name: "project_bootstrap.skipped",
        projectId: state.metadata.projectId,
        sessionId,
        ...(attemptId ? { attemptId } : {}),
        reason: "user-proceeded",
        queueDepth: state.inputs.length,
      });
      await this.drain(state);
      return;
    }
    state.metadata.bootstrap = { status: "failed", retryable, errorCode };
    await this.persist(sessionId, state);
    const awaitsTimedOutTurnCompletion =
      errorCode === "delivery_timeout" &&
      attemptId !== undefined &&
      this.activeTurns.get(sessionId)?.kind === "bootstrap" &&
      this.activeTurns.get(sessionId)?.id === attemptId;
    if (!retryable && !awaitsTimedOutTurnCompletion) {
      this.clearCorrelation(sessionId);
    }
    this.emit({
      name: "project_bootstrap.failed",
      projectId: state.metadata.projectId,
      sessionId,
      ...(attemptId ? { attemptId } : {}),
      errorCode,
      retryable,
      queueDepth: 0,
    });
  }

  private async fail(
    sessionId: string,
    expectedKey: "pending" | string,
    errorCode: ProjectBootstrapErrorCode,
    retryable: boolean,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.closed) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      await this.setFailure(state, expectedKey, errorCode, retryable);
    });
  }

  retry(sessionId: string): Promise<void> {
    if (this.closed)
      return Promise.reject(new ProjectBootstrapCoordinatorClosedError());
    return this.startGreeting(sessionId, true);
  }

  enqueue(sessionId: string, text: string): Promise<ProjectBootstrapMetadata> {
    if (this.closed)
      return Promise.reject(new ProjectBootstrapCoordinatorClosedError());
    const known = this.options.sessionManager.get(sessionId);
    if (!known?.projectBootstrap) {
      return Promise.reject(new Error("project bootstrap session not found"));
    }
    if (known.status === "exited") {
      return Promise.reject(new ProjectBootstrapDispatchForbiddenError());
    }

    // This signal is intentionally installed before waiting for the coordinator
    // lock: startGreeting may currently be between its background text write and
    // delayed Enter. Cancelling that staging window gives durable user input
    // priority without ever splicing the two prompts together.
    this.notePendingApiInput(sessionId);
    this.options.sessionManager.preemptBackgroundInput(sessionId);

    const operation = this.serialize(sessionId, async () => {
      this.assertOpen();
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap)
        throw new Error("project bootstrap session not found");
      if (session.status === "exited") {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      if (!(await this.canDispatch(session))) {
        throw new ProjectBootstrapDispatchForbiddenError();
      }
      const state = await this.load(session);
      const input: ProjectBootstrapQueuedInput = {
        id: this.generateId(),
        sessionId,
        text,
        acceptedAt: this.now(),
      };
      state.inputs.push(input);
      state.metadata.queuedInputIds.push(input.id);
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
        } else if (bootstrap.status === "pending") {
          this.clearCorrelation(sessionId);
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
      if (isTerminal(state.metadata)) await this.drain(state);
      // drain() advances through immutable queue-state clones. Return the
      // latest authoritative projection rather than the pre-drain object so a
      // 202 response never reports IDs that were already durably dequeued.
      return structuredClone(
        this.states.get(sessionId)?.metadata ?? state.metadata,
      );
    });
    return operation.finally(() => this.clearPendingApiInput(sessionId));
  }

  /**
   * Raw PTY input is already owned by the user and is never copied into this
   * store. It synchronously retires bootstrap in memory, then durably records
   * preemption on the coordinator queue before any later automatic attempt.
   */
  onTerminalInput(sessionId: string): void {
    if (this.closed) return;
    this.terminalPreemptions.add(sessionId);
    const session = this.options.sessionManager.get(sessionId);
    if (session?.projectBootstrap && !isTerminal(session.projectBootstrap)) {
      session.projectBootstrap.bootstrap = {
        status: "skipped",
        reason: "user-proceeded",
      };
    }
    const state = this.states.get(sessionId);
    const bootstrap = state?.metadata.bootstrap;
    if (
      !state ||
      !bootstrap ||
      (bootstrap.status !== "pending" &&
        bootstrap.status !== "generating" &&
        bootstrap.status !== "failed")
    ) {
      return;
    }
    const attemptId =
      bootstrap.status === "generating" ? bootstrap.attemptId : undefined;
    state.metadata.bootstrap = { status: "skipped", reason: "user-proceeded" };
    this.clearTimer(sessionId);
    if (attemptId) {
      this.retireAttemptCorrelation(sessionId, attemptId);
      this.markAttempt(state, attemptId, "retired");
    }
    this.states.set(sessionId, structuredClone(state));
    void this.serialize(sessionId, async () => {
      const latest = this.states.get(sessionId);
      if (!latest) return;
      await this.persist(sessionId, structuredClone(latest));
      if (!this.reportedTerminalPreemptions.has(sessionId)) {
        this.reportedTerminalPreemptions.add(sessionId);
        this.emit({
          name: "project_bootstrap.preempted",
          projectId: latest.metadata.projectId,
          sessionId,
          ...(attemptId ? { attemptId } : {}),
          reason: "user-proceeded",
          queueDepth: latest.inputs.length,
        });
      }
    }).catch(() => {});
  }

  private async drainSession(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.closed) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      if (isTerminal(state.metadata)) await this.drain(state);
    });
  }

  private async drain(
    initialState: PersistedProjectBootstrapState,
  ): Promise<void> {
    const sessionId = initialState.metadata.targetSessionId;
    if (this.hasInputHold(sessionId)) return;
    let state: PersistedProjectBootstrapState;
    try {
      // An accepted-input ledger is the commit/ack boundary. If the prior
      // process reached the PTY but failed to rewrite the FIFO, finish that
      // dequeue without submitting the prompt again.
      state = await this.reconcileAcceptedInputs(initialState);
    } catch {
      return;
    }
    const input = state.inputs[0];
    if (!input || this.hasInputHold(sessionId)) return;
    const session = this.options.sessionManager.get(input.sessionId);
    if (!session?.ready || session.status !== "running") return;
    if (!(await this.canDispatch(session))) return;

    // A durable intent without a durable acceptance acknowledgement is
    // irreducibly ambiguous across a crash. Never guess by replaying it: a
    // later accepted ledger can complete the dequeue, while automatic replay
    // could duplicate a user message already written to the PTY.
    if (state.dispatchingInputId !== null) {
      try {
        state = await this.resolveUncertainDispatch(state);
      } catch {
        return;
      }
      if (state.dispatchingInputId !== null) return;
      const next = state.inputs[0];
      if (!next || this.hasInputHold(sessionId)) return;
      return this.drain(state);
    }

    const prepared: PersistedProjectBootstrapState = {
      ...structuredClone(state),
      dispatchingInputId: input.id,
    };
    try {
      await this.persist(input.sessionId, prepared);
    } catch {
      // No external side effect occurred before the intent commit.
      return;
    }
    state = prepared;
    if (!(await this.canDispatch(session))) {
      const rollback: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        dispatchingInputId: null,
      };
      await this.persist(input.sessionId, rollback).catch(() => {});
      return;
    }

    // Register correlation and the live turn gate before crossing the PTY
    // boundary. Prompt hooks may run before submitInput resolves.
    const queue = this.expected.get(input.sessionId) ?? [];
    queue.push({ kind: "user", id: input.id, text: input.text });
    this.expected.set(input.sessionId, queue);
    this.activeTurns.set(input.sessionId, { kind: "user", id: input.id });
    let accepted = false;
    try {
      accepted = await this.options.sessionManager.submitInput(
        input.sessionId,
        input.text,
        true,
        () => this.canDispatch(session),
      );
    } catch {
      this.clearActiveTurn(input.sessionId, "user", input.id);
      this.removeExpectedPrompt(input.sessionId, "user", input.id);
      const rollback: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        dispatchingInputId: null,
      };
      await this.persist(input.sessionId, rollback).catch(() => {});
      return;
    }
    if (!accepted) {
      this.clearActiveTurn(input.sessionId, "user", input.id);
      this.removeExpectedPrompt(input.sessionId, "user", input.id);
      const rollback: PersistedProjectBootstrapState = {
        ...structuredClone(state),
        dispatchingInputId: null,
      };
      await this.persist(input.sessionId, rollback).catch(() => {});
      return;
    }
    try {
      await this.recordAcceptedInput(state, input.id);
    } catch {
      // The durable intent remains unresolved and will not be replayed after
      // restart. True PTY exactly-once is impossible without this ack.
      return;
    }

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
    };
    try {
      await this.persist(input.sessionId, committed);
    } catch {
      // The accepted ledger is durable. A restart will finish this exact
      // dequeue without submitting the input twice.
      return;
    }
    await this.writeAcceptedInputIds(input.sessionId, []).catch(() => {});
    // The next FIFO entry is intentionally not submitted here. Its dispatch
    // is released only by this turn's correlated completion.
  }

  /** Add local-only correlation without removing transcript content. */
  decorateLocalEvent(event: AnalyticsEvent): AnalyticsEvent {
    const session = this.options.sessionManager.get(event.harnessSessionId);
    if (!session?.projectBootstrap || event.type !== "prompt.submitted")
      return event;
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
    if (observed.length >= 256) {
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

  async onEventPersisted(event: AnalyticsEvent): Promise<void> {
    if (this.closed || event.type !== "turn.completed") return;
    await this.serialize(event.harnessSessionId, async () => {
      if (this.closed) return;
      // Consume exactly one prompt barrier for every completion before looking
      // at lifecycle state. In particular, a late completion while attempt 1
      // is failed must not remain queued to satisfy a later retry.
      const observed = this.observedAttempts.get(event.harnessSessionId);
      const completedTurn = observed?.shift();
      if (observed?.length === 0) {
        this.observedAttempts.delete(event.harnessSessionId);
      }
      if (completedTurn?.kind === "bootstrap") {
        this.clearActiveTurn(
          event.harnessSessionId,
          "bootstrap",
          completedTurn.id,
        );
      } else if (completedTurn?.kind === "user") {
        this.clearActiveTurn(event.harnessSessionId, "user", completedTurn.id);
      } else if (completedTurn?.kind === "external") {
        // An observed ordinary prompt plus its completion is the only safe
        // evidence that raw terminal ownership has ended. A bootstrap
        // completion must never release input queued behind a person's turn.
        this.terminalPreemptions.delete(event.harnessSessionId);
        this.reportedTerminalPreemptions.delete(event.harnessSessionId);
      }
      const session = this.options.sessionManager.get(event.harnessSessionId);
      if (!session?.projectBootstrap) return;
      const state = await this.load(session);
      if (this.correlationOverflow.delete(event.harnessSessionId)) {
        if (state.metadata.bootstrap.status === "generating") {
          await this.setFailure(
            state,
            state.metadata.bootstrap.attemptId,
            "model_turn_failed",
            true,
          );
        }
        return;
      }
      if (state.metadata.bootstrap.status !== "generating") {
        if (
          completedTurn?.kind === "bootstrap" &&
          state.metadata.bootstrap.status === "failed" &&
          state.metadata.bootstrap.errorCode === "delivery_timeout" &&
          !state.metadata.bootstrap.retryable &&
          state.inputs.length === 0 &&
          state.retryCount < MAX_RETRIES
        ) {
          // The timeout itself could not prove whether the submitted turn was
          // still running. Its correlated completion is the missing proof: it
          // is now safe to expose a bounded retry without ever overlapping the
          // provider turn.
          state.metadata.bootstrap = {
            status: "failed",
            retryable: true,
            errorCode: "delivery_timeout",
          };
          await this.persist(event.harnessSessionId, state);
        }
        // A raw terminal turn may have preempted a staged durable API input.
        // Its completion is the first proof that the ordinary composer is safe
        // to receive that FIFO again.
        if (isTerminal(state.metadata) && state.inputs.length > 0) {
          await this.drain(state);
        }
        return;
      }
      const attemptId = state.metadata.bootstrap.attemptId;
      if (completedTurn?.kind !== "bootstrap") return;
      // Stop/turn.completed carries no attempt token. Consume correlations in
      // prompt-observation order: a retired older turn is a tombstone, never
      // evidence that the currently generating retry completed.
      if (completedTurn.retired || completedTurn.id !== attemptId) return;
      const text = event.payload.assistantText;
      if (typeof text !== "string" || text.trim() === "") {
        await this.setFailure(state, attemptId, "model_turn_failed", true);
        return;
      }
      this.clearTimer(event.harnessSessionId, attemptId);
      state.metadata.bootstrap = {
        status: "delivered",
        messageId: event.eventId,
      };
      this.markAttempt(state, attemptId, "completed");
      await this.persist(event.harnessSessionId, state);
      this.clearCorrelation(event.harnessSessionId);
      this.emit({
        name: "project_bootstrap.delivered",
        projectId: state.metadata.projectId,
        sessionId: event.harnessSessionId,
        attemptId,
        queueDepth: state.inputs.length,
      });
      await this.drain(state);
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
