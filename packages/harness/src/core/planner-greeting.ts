import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  PlannerGreetingErrorCode,
  PlannerLifecycleEvent,
  PlannerQueuedInput,
  PlannerSessionMetadata,
} from "../shared/agent-map.js";
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import {
  SessionInputGuardRejectedError,
  SessionManager,
  SessionNotReadyError,
} from "./session-manager.js";

interface PersistedPlannerState {
  schemaVersion: 1;
  metadata: PlannerSessionMetadata;
  inputs: PlannerQueuedInput[];
  /**
   * Durable write-ahead intent for the one FIFO head that may be crossing the
   * PTY boundary. An unresolved intent is never replayed automatically after a
   * restart because the process cannot prove whether the PTY accepted it.
   */
  dispatchingInputId: string | null;
  /** Latest user submission with a durable PTY-acceptance acknowledgement.
   * This content-free token lets other trusted services prove that another
   * user turn occurred without interpreting the message text. */
  lastAcceptedUserInputId: string | null;
  /** Time the latest accepted input entered the trusted user-input boundary.
   * Queued inputs retain their enqueue time so a pre-preparation backlog
   * cannot later masquerade as a reply to a consent question. */
  lastAcceptedUserInputAt: string | null;
  retryCount: number;
  emptyProject: boolean;
}

interface AcceptedInputLedger {
  schemaVersion: 1;
  inputIds: string[];
}

interface ExpectedPrompt {
  kind: "greeting" | "user";
  id: string;
  text: string;
  /** A failed/timed-out greeting stays as a FIFO tombstone so a late hook
   * cannot be mistaken for a later retry. */
  retired?: boolean;
}

interface ObservedGreetingAttempt {
  id: string;
  retired: boolean;
}

interface AttemptTimer {
  key: "pending" | string;
  handle: ReturnType<typeof setTimeout>;
}

export type PlannerRegistrationMode =
  | "boot"
  | "created"
  | "live"
  | "resumed"
  | "rehydrated";

export interface PlannerRegistrationContext {
  emptyProject: boolean;
  mode: PlannerRegistrationMode;
}

export interface PlannerGreetingCoordinatorOptions {
  root: string;
  sessionManager: SessionManager;
  now?: () => string;
  generateId?: () => string;
  /** Applies both while waiting for readiness and while awaiting a model turn. */
  deliveryTimeoutMs?: number;
  /** Test seam for classifying queue-store failures without exposing raw errors. */
  writeState?: (file: string, state: unknown) => Promise<void>;
  /** Test seam for accepted-ledger cleanup/commit failures. */
  writeAcceptedLedger?: (file: string, state: unknown) => Promise<void>;
  /** Test seam for the atomic predecessor-to-successor queue handoff. */
  moveStateDirectory?: (source: string, target: string) => Promise<void>;
  /** Live authorization gate checked immediately before every PTY dispatch. */
  canDispatch?: (session: HarnessSession) => boolean | Promise<boolean>;
  onEvent?: (event: PlannerLifecycleEvent) => Promise<void> | void;
}

export interface AcceptedPlannerUserInput {
  inputId: string;
  acceptedAt: string;
}

function newestAcceptedUserInput(
  state: PersistedPlannerState,
  candidates: readonly AcceptedPlannerUserInput[],
): AcceptedPlannerUserInput | null {
  let latest =
    state.lastAcceptedUserInputId !== null &&
    state.lastAcceptedUserInputAt !== null
      ? {
          inputId: state.lastAcceptedUserInputId,
          acceptedAt: state.lastAcceptedUserInputAt,
        }
      : null;
  for (const candidate of candidates) {
    if (
      latest === null ||
      Date.parse(candidate.acceptedAt) > Date.parse(latest.acceptedAt)
    ) {
      latest = candidate;
    }
  }
  return latest;
}

export class PlannerGreetingRetryUnavailableError extends Error {
  readonly code = "greeting_retry_unavailable";

  constructor() {
    super("greeting retry is not available");
    this.name = "PlannerGreetingRetryUnavailableError";
  }
}

export class PlannerDispatchForbiddenError extends Error {
  readonly code = "planner_dispatch_forbidden";

  constructor() {
    super("planner session is no longer authorized for this project binding");
    this.name = "PlannerDispatchForbiddenError";
  }
}

const MAX_RETRIES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(metadata: PlannerSessionMetadata): boolean {
  return (
    metadata.greeting.status === "delivered" ||
    metadata.greeting.status === "skipped"
  );
}

function isPersistedPlannerState(
  value: unknown,
  session: HarnessSession,
): value is PersistedPlannerState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !session.planning) {
    return false;
  }
  const metadata = value.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.identity)) return false;
  const expected = session.planning.identity;
  if (
    metadata.identity.role !== "map-planner" ||
    metadata.identity.sessionId !== expected.sessionId ||
    metadata.identity.projectId !== expected.projectId ||
    metadata.identity.userId !== expected.userId ||
    !Array.isArray(metadata.queuedInputIds) ||
    !metadata.queuedInputIds.every((id) => typeof id === "string") ||
    !isRecord(metadata.greeting) ||
    typeof metadata.greeting.status !== "string" ||
    !["pending", "generating", "delivered", "failed", "skipped"].includes(
      metadata.greeting.status,
    ) ||
    !Array.isArray(value.inputs) ||
    (value.dispatchingInputId !== undefined &&
      value.dispatchingInputId !== null &&
      typeof value.dispatchingInputId !== "string") ||
    (value.lastAcceptedUserInputId !== undefined &&
      value.lastAcceptedUserInputId !== null &&
      (typeof value.lastAcceptedUserInputId !== "string" ||
        value.lastAcceptedUserInputId === "")) ||
    (value.lastAcceptedUserInputAt !== undefined &&
      value.lastAcceptedUserInputAt !== null &&
      (typeof value.lastAcceptedUserInputAt !== "string" ||
        !Number.isFinite(Date.parse(value.lastAcceptedUserInputAt)))) ||
    !Number.isSafeInteger(value.retryCount) ||
    (value.retryCount as number) < 0 ||
    (value.retryCount as number) > MAX_RETRIES ||
    typeof value.emptyProject !== "boolean"
  ) {
    return false;
  }
  const inputs = value.inputs;
  if (
    !inputs.every(
      (input) =>
        isRecord(input) &&
        typeof input.id === "string" &&
        input.id !== "" &&
        input.sessionId === session.id &&
        typeof input.text === "string" &&
        input.text.length <= 100_000 &&
        typeof input.acceptedAt === "string" &&
        Number.isFinite(Date.parse(input.acceptedAt)),
    ) ||
    metadata.queuedInputIds.length !== inputs.length ||
    metadata.queuedInputIds.some(
      (id, index) => id !== (inputs[index] as Record<string, unknown>).id,
    ) ||
    (typeof value.dispatchingInputId === "string" &&
      value.dispatchingInputId !==
        (inputs[0] as Record<string, unknown> | undefined)?.id)
  ) {
    return false;
  }
  const greeting = metadata.greeting;
  switch (greeting.status) {
    case "pending":
      return true;
    case "generating":
      return typeof greeting.attemptId === "string" && greeting.attemptId !== "";
    case "delivered":
      return typeof greeting.messageId === "string" && greeting.messageId !== "";
    case "failed":
      return (
        typeof greeting.retryable === "boolean" &&
        typeof greeting.errorCode === "string" &&
        [
          "session_not_ready",
          "session_exited",
          "injection_failed",
          "model_turn_failed",
          "delivery_timeout",
          "persistence_failed",
        ].includes(greeting.errorCode)
      );
    case "skipped":
      return greeting.reason === "user-proceeded";
    default:
      return false;
  }
}

/** A directory rename can commit before the successor rewrites the embedded
 * session identity. The trusted `rehydratedFrom` link is the recovery marker:
 * accept only an otherwise-valid predecessor state with the same scoped
 * project/user/role, then re-key every identity-bearing field in memory. */
function adoptRehydratedState(
  value: unknown,
  session: HarnessSession,
): PersistedPlannerState | null {
  if (!session.planning || !session.rehydratedFrom) return null;
  const predecessorId = session.rehydratedFrom;
  const predecessor: HarnessSession = {
    ...session,
    id: predecessorId,
    planning: {
      ...structuredClone(session.planning),
      identity: {
        ...structuredClone(session.planning.identity),
        sessionId: predecessorId,
      },
    },
  };
  if (!isPersistedPlannerState(value, predecessor)) return null;
  const hasAcceptedInput =
    value.lastAcceptedUserInputId != null &&
    value.lastAcceptedUserInputAt != null;
  return {
    ...structuredClone(value),
    metadata: {
      ...structuredClone(value.metadata),
      identity: structuredClone(session.planning.identity),
    },
    inputs: value.inputs.map((input) => ({
      ...structuredClone(input),
      sessionId: session.id,
    })),
    dispatchingInputId: value.dispatchingInputId ?? null,
    lastAcceptedUserInputId: hasAcceptedInput
      ? value.lastAcceptedUserInputId
      : null,
    lastAcceptedUserInputAt: hasAcceptedInput
      ? value.lastAcceptedUserInputAt
      : null,
  };
}

export function plannerGreetingPrompt(
  emptyProject: boolean,
  attemptId?: string,
): string {
  const question = emptyProject
    ? "Ask exactly one open-ended question about what kind of agent architecture the user wants to build."
    : "Briefly acknowledge that a current plan exists, then ask exactly one open-ended question about what the user wants to review, extend, or change.";
  return [
    "This is a private Agent Studio control turn.",
    "Respond as the project planning agent with one brief greeting.",
    "Explain that you and the user will plan the agents, responsibilities, data flow, resources, and connectors together.",
    question,
    "Do not propose an architecture, create nodes or relationships, invoke tools, or ask a second question before the user replies.",
    ...(attemptId
      ? [`Internal attempt ID: ${attemptId}. Never mention this ID in your response.`]
      : []),
  ].join(" ");
}

const PLANNER_SESSION_SOURCES = new Set([
  "startup",
  "resume",
  "clear",
  "compact",
  "codex",
]);
const MAX_TELEMETRY_TOKEN_COUNT = 1_000_000_000_000;

function telemetrySource(value: unknown): string {
  return typeof value === "string" && PLANNER_SESSION_SOURCES.has(value)
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
      return { source: telemetrySource(event.payload.source), planner: true };
    case "prompt.submitted":
      return {
        planner: true,
        origin: event.payload.plannerOrigin ?? "user",
        ...(typeof event.payload.plannerInputId === "string"
          ? { plannerInputId: event.payload.plannerInputId }
          : {}),
        ...(typeof event.payload.plannerAttemptId === "string"
          ? { plannerAttemptId: event.payload.plannerAttemptId }
          : {}),
      };
    case "tool.call":
      return { planner: true, toolObserved: true };
    case "turn.completed":
      return {
        planner: true,
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
      return { planner: true };
  }
}

export class PlannerGreetingCoordinator {
  private readonly root: string;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly deliveryTimeoutMs: number;
  private readonly states = new Map<string, PersistedPlannerState>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly expected = new Map<string, ExpectedPrompt[]>();
  private readonly observedAttempts = new Map<
    string,
    Array<ObservedGreetingAttempt | null>
  >();
  private readonly correlationOverflow = new Set<string>();
  private readonly timers = new Map<string, AttemptTimer>();
  /** Status hooks can race a freshly spawned PTY ahead of register/handoff. */
  private readonly registeredSessions = new Set<string>();
  /** A successfully handed-off predecessor can never dispatch or mutate its
   * retired FIFO again, even if a late status/hook callback arrives. */
  private readonly retiredSessions = new Set<string>();
  /** Successors loaded after a crash between the atomic directory move and
   * the best-effort embedded-identity rewrite. */
  private readonly adoptedSessions = new Set<string>();

  constructor(private readonly options: PlannerGreetingCoordinatorOptions) {
    this.root = path.resolve(options.root);
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 45_000;
  }

  private sessionDirectory(sessionId: string): string {
    const directory = path.resolve(this.root, sessionId);
    const rootPrefix = `${this.root}${path.sep}`;
    if (!directory.startsWith(rootPrefix)) {
      throw new Error("invalid planner session storage identity");
    }
    return directory;
  }

  private file(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "input-queue.json");
  }

  private acceptedFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "accepted-inputs.json");
  }

  private emit(event: PlannerLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Telemetry is best effort and must never change planner semantics.
    }
  }

  private async canDispatch(session: HarnessSession): Promise<boolean> {
    try {
      return (await this.options.canDispatch?.(session)) ?? true;
    } catch {
      return false;
    }
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
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
  ): PersistedPlannerState {
    if (!session.planning) throw new Error("planner metadata missing");
    return {
      schemaVersion: 1,
      metadata: {
        ...structuredClone(session.planning),
        // The queue file owns FIFO membership. If that file is missing or was
        // quarantined, stale registry IDs cannot resurrect content we no
        // longer possess or make the replacement state invalid on next boot.
        queuedInputIds: [],
      },
      inputs: [],
      dispatchingInputId: null,
      lastAcceptedUserInputId: null,
      lastAcceptedUserInputAt: null,
      retryCount: 0,
      emptyProject,
    };
  }

  private async quarantine(sessionId: string): Promise<void> {
    const file = this.file(sessionId);
    const quarantine = path.join(
      path.dirname(file),
      `input-queue.corrupt-${this.now().replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.json`,
    );
    await fs.rename(file, quarantine).catch(() => {});
  }

  private async load(
    session: HarnessSession,
    emptyProject = true,
  ): Promise<PersistedPlannerState> {
    const cached = this.states.get(session.id);
    // Every transition works on an isolated snapshot. Nothing may mutate the
    // authoritative cache until persist() commits the primary queue file.
    if (cached) return structuredClone(cached);
    let state: PersistedPlannerState;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.file(session.id), "utf8"),
      );
      if (isPersistedPlannerState(parsed, session)) {
        const hasAcceptedInput =
          parsed.lastAcceptedUserInputId != null &&
          parsed.lastAcceptedUserInputAt != null;
        state = {
          ...parsed,
          // Backward-compatible with queue files written by the first SAP-3055
          // review head before dispatch intent became explicit.
          dispatchingInputId: parsed.dispatchingInputId ?? null,
          lastAcceptedUserInputId: hasAcceptedInput
            ? parsed.lastAcceptedUserInputId
            : null,
          lastAcceptedUserInputAt: hasAcceptedInput
            ? parsed.lastAcceptedUserInputAt
            : null,
        };
      } else {
        const adopted = adoptRehydratedState(parsed, session);
        if (!adopted) throw new Error("invalid planner state");
        state = adopted;
        this.adoptedSessions.add(session.id);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A single damaged or unreadable session queue is local corruption,
        // never a reason to prevent the rest of the harness from booting.
        await this.quarantine(session.id);
      }
      state = this.newState(session, emptyProject);
    }
    this.states.set(session.id, structuredClone(state));
    return state;
  }

  private async writeState(file: string, state: PersistedPlannerState): Promise<void> {
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
    state: PersistedPlannerState,
    inputId: string,
  ): Promise<void> {
    const sessionId = state.metadata.identity.sessionId;
    const accepted = await this.acceptedInputIds(sessionId);
    if (accepted === null) {
      throw new Error("planner input acceptance ledger unavailable");
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
    state: PersistedPlannerState,
  ): Promise<PersistedPlannerState> {
    const sessionId = state.metadata.identity.sessionId;
    const accepted = await this.acceptedInputIds(sessionId);
    if (accepted === null || accepted.size === 0) return state;
    const acceptedInputs = state.inputs.filter((input) => accepted.has(input.id));
    const latestAcceptedInput = newestAcceptedUserInput(
      state,
      acceptedInputs
        .filter((input) => input.text.trim() !== "")
        .map((input) => ({
          inputId: input.id,
          acceptedAt: input.acceptedAt,
        })),
    );
    const remaining = state.inputs.filter((input) => !accepted.has(input.id));
    if (remaining.length === state.inputs.length) return state;
    const reconciled: PersistedPlannerState = {
      ...structuredClone(state),
      inputs: remaining,
      lastAcceptedUserInputId: latestAcceptedInput?.inputId ?? null,
      lastAcceptedUserInputAt: latestAcceptedInput?.acceptedAt ?? null,
      dispatchingInputId:
        state.dispatchingInputId && accepted.has(state.dispatchingInputId)
          ? null
          : state.dispatchingInputId,
      metadata: {
        ...structuredClone(state.metadata),
        queuedInputIds: remaining.map((input) => input.id),
      },
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
    state: PersistedPlannerState,
  ): Promise<PersistedPlannerState> {
    const inputId = state.dispatchingInputId;
    if (inputId === null || state.inputs[0]?.id !== inputId) return state;
    const remaining = state.inputs.slice(1);
    const resolved: PersistedPlannerState = {
      ...structuredClone(state),
      inputs: remaining,
      dispatchingInputId: null,
      metadata: {
        ...structuredClone(state.metadata),
        queuedInputIds: remaining.map((input) => input.id),
      },
    };
    await this.persist(state.metadata.identity.sessionId, resolved);
    this.emit({
      name: "planner_session.input_delivery_uncertain",
      projectId: state.metadata.identity.projectId,
      sessionId: state.metadata.identity.sessionId,
      inputId,
      errorCode: "delivery_uncertain",
      queueDepth: remaining.length,
    });
    // There was no readable acceptance proof for this ID. Any stale ledger is
    // cleanup residue or was quarantined; reset it after the queue resolution.
    await this.writeAcceptedInputIds(
      state.metadata.identity.sessionId,
      [],
    ).catch(() => {});
    return resolved;
  }

  private clearTimer(sessionId: string, key?: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer || (key !== undefined && timer.key !== key)) return;
    clearTimeout(timer.handle);
    this.timers.delete(sessionId);
  }

  private armTimer(sessionId: string, key: "pending" | string): void {
    if (this.timers.get(sessionId)?.key === key) return;
    this.clearTimer(sessionId);
    const handle = setTimeout(() => {
      void this.fail(
        sessionId,
        key,
        key === "pending" ? "session_not_ready" : "delivery_timeout",
        true,
      ).catch(() => {
        // Timer callbacks have no request boundary to receive a rejection.
        // persist() already projects/emits `persistence_failed` wherever one
        // durable store remains; log only a fixed local classification here,
        // never the provider/storage error or planner content.
        console.error(
          "[harness] planner greeting timeout transition failed: persistence_failed",
        );
      });
    }, this.deliveryTimeoutMs);
    handle.unref?.();
    this.timers.set(sessionId, { key, handle });
  }

  private retireAttemptCorrelation(sessionId: string, attemptId: string): void {
    const expected = this.expected.get(sessionId);
    if (expected) {
      this.expected.set(
        sessionId,
        expected.map((entry) =>
          entry.kind === "greeting" && entry.id === attemptId
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
          entry?.id === attemptId ? { ...entry, retired: true } : entry,
        ),
      );
    }
  }

  private removeExpectedGreeting(sessionId: string, attemptId: string): void {
    const expected = this.expected.get(sessionId);
    if (!expected) return;
    const remaining = expected.filter(
      (entry) => !(entry.kind === "greeting" && entry.id === attemptId),
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
    state: PersistedPlannerState,
  ): Promise<void> {
    try {
      await this.writeState(this.file(sessionId), state);
    } catch {
      if (!isTerminal(state.metadata)) {
        const attemptId =
          state.metadata.greeting.status === "generating"
            ? state.metadata.greeting.attemptId
            : undefined;
        this.clearTimer(sessionId);
        state.metadata.greeting = {
          status: "failed",
          retryable: true,
          errorCode: "persistence_failed",
        };
        // At least one of the two stores may still be available. Keep the
        // bounded classification wherever possible; never persist raw errors.
        let fallbackCommitted = false;
        try {
          await this.options.sessionManager.setPlanningMetadata(
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
        if (fallbackCommitted) this.states.set(sessionId, structuredClone(state));
        this.emit({
          name: "planner_greeting.failed",
          projectId: state.metadata.identity.projectId,
          sessionId,
          ...(attemptId ? { attemptId } : {}),
          errorCode: "persistence_failed",
          retryable: true,
          queueDepth: state.inputs.length,
        });
      }
      throw new Error("planner state persistence failed");
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
      .setPlanningMetadata(sessionId, state.metadata)
      .catch(() => {});
  }

  /**
   * Merge the two durable stores under a single serialized registration CAS.
   * Queue-file inputs are authoritative. A terminal manager greeting is newer
   * than a non-terminal queue greeting (resume suppression), while a terminal
   * queue greeting is newer than a stale non-terminal manager snapshot.
   */
  private mergeRegistration(
    state: PersistedPlannerState,
    session: HarnessSession,
  ): void {
    if (!session.planning) return;
    const managerTerminal = isTerminal(session.planning);
    const queueTerminal = isTerminal(state.metadata);
    if (managerTerminal && !queueTerminal) {
      state.metadata.greeting = structuredClone(session.planning.greeting);
    }
    state.metadata.queuedInputIds = state.inputs.map((input) => input.id);
  }

  private async retireHandoffPredecessor(
    predecessor: HarnessSession,
    source?: PersistedPlannerState,
  ): Promise<void> {
    const predecessorId = predecessor.id;
    const retired: PersistedPlannerState | undefined = source
      ? {
          ...structuredClone(source),
          inputs: [],
          dispatchingInputId: null,
          metadata: {
            ...structuredClone(source.metadata),
            queuedInputIds: [],
          },
        }
      : undefined;
    if (retired) this.states.set(predecessorId, retired);
    const metadata =
      retired?.metadata ??
      (predecessor.planning
        ? { ...structuredClone(predecessor.planning), queuedInputIds: [] }
        : undefined);
    if (metadata) {
      await this.options.sessionManager
        .setPlanningMetadata(predecessorId, metadata)
        .catch(() => {});
    }
    this.clearTimer(predecessorId);
    this.clearCorrelation(predecessorId);
    this.registeredSessions.delete(predecessorId);
    this.retiredSessions.add(predecessorId);
  }

  /** Atomically move a predecessor's entire coordinator directory into its
   * rehydrated replacement. There is never a point with two durable FIFO
   * copies: before rename only the predecessor exists; after rename only the
   * exact successor exists. The embedded identity rewrite is best effort and
   * recoverable through `adoptRehydratedState` after a crash. Accepted entries
   * are removed and unresolved dispatch intent is classified uncertain before
   * the move, so neither can become replayable under the successor. */
  private async handoffRehydratedInputs(
    session: HarnessSession,
    replacementState: PersistedPlannerState,
  ): Promise<{ state: PersistedPlannerState; moved: boolean }> {
    const predecessorId = session.rehydratedFrom;
    if (!predecessorId || predecessorId === session.id) {
      return { state: replacementState, moved: false };
    }
    const predecessor = this.options.sessionManager.get(predecessorId);
    const sourceIdentity = predecessor?.planning?.identity;
    const targetIdentity = session.planning?.identity;
    if (
      !predecessor ||
      !sourceIdentity ||
      !targetIdentity ||
      sourceIdentity.role !== "map-planner" ||
      targetIdentity.role !== "map-planner" ||
      sourceIdentity.projectId !== targetIdentity.projectId ||
      sourceIdentity.userId !== targetIdentity.userId
    ) {
      return { state: replacementState, moved: false };
    }

    return this.serialize(predecessorId, async () => {
      // A canonical or adoptable target file proves a prior atomic move
      // already committed. On a later boot the old HarnessSession may register
      // first and recreate an empty source queue; never rename that directory
      // over the authoritative target. A non-empty second source is an
      // impossible/conflicting dual owner and fails closed.
      try {
        await fs.access(this.file(session.id));
        let recreatedSource: PersistedPlannerState | undefined;
        try {
          await fs.access(this.file(predecessorId));
          recreatedSource = await this.load(predecessor);
          recreatedSource = await this.reconcileAcceptedInputs(recreatedSource);
          if (recreatedSource.dispatchingInputId !== null) {
            recreatedSource = await this.resolveUncertainDispatch(recreatedSource);
          }
          if (recreatedSource.inputs.length > 0) {
            throw new Error("conflicting planner handoff queues");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await this.retireHandoffPredecessor(predecessor, recreatedSource);
        return { state: replacementState, moved: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      try {
        await fs.access(this.file(predecessorId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            state: replacementState,
            moved: this.adoptedSessions.has(session.id),
          };
        }
        throw error;
      }
      let source = await this.load(predecessor);
      source = await this.reconcileAcceptedInputs(source);
      if (source.dispatchingInputId !== null) {
        source = await this.resolveUncertainDispatch(source);
      }

      const transferred = source.inputs.map((input) => ({
        ...structuredClone(input),
        sessionId: session.id,
      }));
      const transferredIds = new Set(transferred.map((input) => input.id));
      const mergedInputs = [
        ...transferred,
        ...replacementState.inputs.filter(
          (input) => !transferredIds.has(input.id),
        ),
      ];
      const replacement: PersistedPlannerState = {
        ...structuredClone(source),
        inputs: mergedInputs,
        dispatchingInputId: null,
        metadata: {
          ...structuredClone(source.metadata),
          identity: structuredClone(targetIdentity),
          queuedInputIds: mergedInputs.map((input) => input.id),
        },
      };
      const sourceDirectory = path.dirname(this.file(predecessorId));
      const targetDirectory = path.dirname(this.file(session.id));
      const move = this.options.moveStateDirectory ?? fs.rename;
      await move(sourceDirectory, targetDirectory);

      // The rename above is the only ownership commit. Publish the re-keyed
      // cache immediately; rewriting the moved file is merely canonicalization
      // because a crash can always adopt its predecessor identity in place.
      this.states.set(session.id, structuredClone(replacement));
      this.states.delete(predecessorId);
      try {
        await this.writeState(this.file(session.id), replacement);
        this.adoptedSessions.delete(session.id);
      } catch {
        this.adoptedSessions.add(session.id);
      }
      await this.writeAcceptedInputIds(session.id, []).catch(() => {});

      await this.retireHandoffPredecessor(predecessor, source);
      return { state: replacement, moved: true };
    });
  }

  async register(
    session: HarnessSession,
    context: PlannerRegistrationContext,
  ): Promise<void> {
    if (!session.planning) return;
    let shouldStart = false;
    let shouldDrain = false;
    await this.serialize(session.id, async () => {
      const cached = this.states.has(session.id);
      let state = await this.load(session, context.emptyProject);
      let handoffMoved = false;
      // A crash can occur after the replacement queue commit but before the
      // predecessor retirement commit. `rehydratedFrom` is persisted on the
      // HarnessSession, so repeat this idempotent handoff during process boot
      // as well as the original rehydration callback.
      if (session.rehydratedFrom) {
        const handoff = await this.handoffRehydratedInputs(session, state);
        state = handoff.state;
        handoffMoved = handoff.moved;
      }
      this.mergeRegistration(state, session);

      // Only a process-boot load proves an in-flight dispatch was abandoned.
      // Live re-registration is idempotent and must not fail its active turn.
      if (
        context.mode === "boot" &&
        !cached &&
        state.metadata.greeting.status === "generating"
      ) {
        const attemptId = state.metadata.greeting.attemptId;
        state.metadata.greeting = state.inputs.length
          ? { status: "skipped", reason: "user-proceeded" }
          : {
              status: "failed",
              retryable: true,
              errorCode: "delivery_timeout",
            };
        if (state.inputs.length) {
          this.emit({
            name: "planner_greeting.skipped",
            projectId: state.metadata.identity.projectId,
            sessionId: session.id,
            attemptId,
            reason: "user-proceeded",
            queueDepth: state.inputs.length,
          });
        } else {
          this.emit({
            name: "planner_greeting.failed",
            projectId: state.metadata.identity.projectId,
            sessionId: session.id,
            attemptId,
            errorCode: "delivery_timeout",
            retryable: true,
            queueDepth: 0,
          });
        }
      }
      if (handoffMoved) {
        // The directory rename already durably committed FIFO ownership. A
        // failed canonical rewrite must not reject the exact successor and let
        // a later open mint a second owner; future pre-PTY transitions retry
        // the normal authoritative queue write.
        this.states.set(session.id, structuredClone(state));
        try {
          await this.writeState(this.file(session.id), state);
          this.adoptedSessions.delete(session.id);
        } catch {
          this.adoptedSessions.add(session.id);
        }
        await this.options.sessionManager
          .setPlanningMetadata(session.id, state.metadata)
          .catch(() => {});
      } else {
        await this.persist(session.id, state);
      }
      this.registeredSessions.add(session.id);
      if (state.metadata.greeting.status === "pending") {
        const allowed = await this.canDispatch(session);
        if (
          session.ready &&
          session.status === "running" &&
          allowed
        ) shouldStart = true;
        else if (allowed) this.armTimer(session.id, "pending");
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
    if (!session.planning) return;
    if (
      !this.registeredSessions.has(session.id) ||
      this.retiredSessions.has(session.id)
    ) return;
    if (
      session.ready &&
      session.status === "running" &&
      (await this.canDispatch(session))
    ) {
      this.clearTimer(session.id, "pending");
      const state = this.states.get(session.id);
      if (state && isTerminal(state.metadata)) await this.drainSession(session.id);
      else await this.startGreeting(session.id, false);
      return;
    }
    if (session.status === "exited") {
      const timer = this.timers.get(session.id);
      this.clearTimer(session.id);
      this.expected.delete(session.id);
      this.observedAttempts.delete(session.id);
      this.correlationOverflow.delete(session.id);
      await this.fail(
        session.id,
        timer?.key ?? "pending",
        "session_exited",
        false,
      );
    }
  }

  private async startGreeting(sessionId: string, retry: boolean): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      if (!(await this.canDispatch(session))) {
        if (retry) throw new PlannerDispatchForbiddenError();
        if (state.metadata.greeting.status === "pending") {
          await this.setFailure(state, "pending", "session_exited", false);
        }
        return;
      }
      if (retry) {
        if (
          state.metadata.greeting.status !== "failed" ||
          !state.metadata.greeting.retryable ||
          state.inputs.length > 0 ||
          state.retryCount >= MAX_RETRIES
        ) {
          throw new PlannerGreetingRetryUnavailableError();
        }
        state.retryCount += 1;
      } else if (state.metadata.greeting.status !== "pending") {
        return;
      }
      this.clearTimer(sessionId, "pending");
      const attemptId = this.generateId();
      state.metadata.greeting = { status: "generating", attemptId };
      await this.persist(sessionId, state);
      this.emit({
        name: retry ? "planner_greeting.retried" : "planner_greeting.attempted",
        projectId: state.metadata.identity.projectId,
        sessionId,
        attemptId,
        queueDepth: state.inputs.length,
      });
      const prompt = plannerGreetingPrompt(state.emptyProject, attemptId);
      if (!(await this.canDispatch(session))) {
        await this.setFailure(state, attemptId, "session_exited", false);
        if (retry) throw new PlannerDispatchForbiddenError();
        return;
      }
      // Register before crossing the PTY boundary. A prompt hook may arrive
      // immediately after the write, before submitInput's delayed Enter has
      // resolved; registering afterward loses the only safe correlation.
      const queue = this.expected.get(sessionId) ?? [];
      queue.push({
        kind: "greeting",
        id: attemptId,
        text: prompt,
        retired: false,
      });
      this.expected.set(sessionId, queue);
      try {
        const accepted = await this.options.sessionManager.submitInput(
          sessionId,
          prompt,
          true,
          () => this.canDispatch(session),
        );
        if (!accepted) {
          // A false return proves the prompt did not cross the PTY boundary.
          this.removeExpectedGreeting(sessionId, attemptId);
          await this.setFailure(state, attemptId, "session_exited", false);
          return;
        }
        this.armTimer(sessionId, attemptId);
      } catch (error) {
        if (
          error instanceof SessionNotReadyError ||
          (error instanceof SessionInputGuardRejectedError && !error.staged)
        ) {
          // Both cases prove absence at the PTY boundary. A guard rejection
          // after staging is intentionally retained/retired as uncertain.
          this.removeExpectedGreeting(sessionId, attemptId);
        }
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
          throw new PlannerDispatchForbiddenError();
        }
      }
    });
  }

  private async setFailure(
    state: PersistedPlannerState,
    expectedKey: "pending" | string,
    errorCode: PlannerGreetingErrorCode,
    retryable: boolean,
  ): Promise<void> {
    const greeting = state.metadata.greeting;
    const matches =
      (expectedKey === "pending" && greeting.status === "pending") ||
      (greeting.status === "generating" && greeting.attemptId === expectedKey);
    if (!matches) return;
    const sessionId = state.metadata.identity.sessionId;
    const attemptId = greeting.status === "generating" ? greeting.attemptId : undefined;
    this.clearTimer(sessionId, expectedKey);
    if (attemptId) this.retireAttemptCorrelation(sessionId, attemptId);
    if (state.inputs.length > 0) {
      state.metadata.greeting = { status: "skipped", reason: "user-proceeded" };
      await this.persist(sessionId, state);
      this.clearCorrelation(sessionId);
      this.emit({
        name: "planner_greeting.skipped",
        projectId: state.metadata.identity.projectId,
        sessionId,
        ...(attemptId ? { attemptId } : {}),
        reason: "user-proceeded",
        queueDepth: state.inputs.length,
      });
      await this.drain(state);
      return;
    }
    state.metadata.greeting = { status: "failed", retryable, errorCode };
    await this.persist(sessionId, state);
    if (!retryable) this.clearCorrelation(sessionId);
    this.emit({
      name: "planner_greeting.failed",
      projectId: state.metadata.identity.projectId,
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
    errorCode: PlannerGreetingErrorCode,
    retryable: boolean,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      await this.setFailure(state, expectedKey, errorCode, retryable);
    });
  }

  retry(sessionId: string): Promise<void> {
    return this.startGreeting(sessionId, true);
  }

  async enqueue(sessionId: string, text: string): Promise<PlannerSessionMetadata> {
    return this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) {
        throw new PlannerDispatchForbiddenError();
      }
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) throw new Error("planner session not found");
      if (!(await this.canDispatch(session))) {
        throw new PlannerDispatchForbiddenError();
      }
      const state = await this.load(session);
      const input: PlannerQueuedInput = {
        id: this.generateId(),
        sessionId,
        text,
        acceptedAt: this.now(),
      };
      state.inputs.push(input);
      state.metadata.queuedInputIds.push(input.id);
      if (state.metadata.greeting.status === "failed") {
        state.metadata.greeting = { status: "skipped", reason: "user-proceeded" };
        this.emit({
          name: "planner_greeting.skipped",
          projectId: state.metadata.identity.projectId,
          sessionId,
          reason: "user-proceeded",
          queueDepth: state.inputs.length,
        });
      }
      await this.persist(sessionId, state);
      if (isTerminal(state.metadata)) await this.drain(state, true);
      // drain() advances through immutable queue-state clones. Return the
      // latest authoritative projection rather than the pre-drain object so a
      // 202 response never reports IDs that were already durably dequeued.
      return structuredClone(this.states.get(sessionId)?.metadata ?? state.metadata);
    });
  }

  private async drainSession(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      if (isTerminal(state.metadata)) await this.drain(state);
    });
  }

  private async drain(
    initialState: PersistedPlannerState,
    throwOnForbidden = false,
  ): Promise<void> {
    let state: PersistedPlannerState;
    try {
      // An accepted-input ledger is the commit/ack boundary. If the prior
      // process reached the PTY but failed to rewrite the FIFO, finish that
      // dequeue without submitting the prompt again.
      state = await this.reconcileAcceptedInputs(initialState);
    } catch {
      return;
    }
    while (state.inputs.length > 0) {
      const input = state.inputs[0]!;
      const session = this.options.sessionManager.get(input.sessionId);
      if (
        !session?.ready ||
        session.status !== "running"
      ) return;
      if (!(await this.canDispatch(session))) {
        if (throwOnForbidden) throw new PlannerDispatchForbiddenError();
        return;
      }

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
        continue;
      }

      const prepared: PersistedPlannerState = {
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
        const rollback: PersistedPlannerState = {
          ...structuredClone(state),
          dispatchingInputId: null,
        };
        await this.persist(input.sessionId, rollback).catch(() => {});
        if (throwOnForbidden) throw new PlannerDispatchForbiddenError();
        return;
      }
      let accepted = false;
      try {
        accepted = await this.options.sessionManager.submitInput(
          input.sessionId,
          input.text,
          true,
          () => this.canDispatch(session),
        );
      } catch (error) {
        const rollback: PersistedPlannerState = {
          ...structuredClone(state),
          dispatchingInputId: null,
        };
        await this.persist(input.sessionId, rollback).catch(() => {});
        if (
          throwOnForbidden &&
          error instanceof SessionInputGuardRejectedError
        ) {
          throw new PlannerDispatchForbiddenError();
        }
        return;
      }
      if (!accepted) {
        const rollback: PersistedPlannerState = {
          ...structuredClone(state),
          dispatchingInputId: null,
        };
        await this.persist(input.sessionId, rollback).catch(() => {});
        return;
      }
      // Register local correlation only after acceptance. The accepted ledger
      // then commits the external side effect before the FIFO is rewritten.
      const queue = this.expected.get(input.sessionId) ?? [];
      queue.push({ kind: "user", id: input.id, text: input.text });
      this.expected.set(input.sessionId, queue);
      try {
        await this.recordAcceptedInput(state, input.id);
      } catch {
        // The durable intent remains unresolved and will not be replayed after
        // restart. True PTY exactly-once is impossible without this ack.
        return;
      }

      const latestAcceptedInput = newestAcceptedUserInput(
        state,
        input.text.trim() === ""
          ? []
          : [{ inputId: input.id, acceptedAt: input.acceptedAt }],
      );
      const committed: PersistedPlannerState = {
        ...structuredClone(state),
        inputs: state.inputs.slice(1),
        dispatchingInputId: null,
        lastAcceptedUserInputId: latestAcceptedInput?.inputId ?? null,
        lastAcceptedUserInputAt: latestAcceptedInput?.acceptedAt ?? null,
        metadata: {
          ...structuredClone(state.metadata),
          queuedInputIds: state.metadata.queuedInputIds.slice(1),
        },
      };
      try {
        await this.persist(input.sessionId, committed);
      } catch {
        // The accepted ledger is durable. A restart will finish this exact
        // dequeue without submitting the input twice.
        return;
      }
      state = committed;
      await this.writeAcceptedInputIds(input.sessionId, []).catch(() => {});
    }
  }

  /** Return the latest server-accepted user turn after all earlier queue work
   * for this planner session has settled. The shared serialization boundary is
   * what prevents a fast model tool call from racing the message dequeue. */
  latestAcceptedUserInput(
    sessionId: string,
  ): Promise<AcceptedPlannerUserInput | null> {
    return this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) return null;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return null;
      const state = await this.reconcileAcceptedInputs(await this.load(session));
      if (
        state.lastAcceptedUserInputId === null ||
        state.lastAcceptedUserInputAt === null
      )
        return null;
      return {
        inputId: state.lastAcceptedUserInputId,
        acceptedAt: state.lastAcceptedUserInputAt,
      };
    });
  }

  /** Persist a content-free token for a non-empty raw line observed on the
   * authenticated terminal transport. SessionManager filters empty Enter/TUI
   * navigation and invokes this only for raw input, never greetings or other
   * programmatic prompts. Calling serialize synchronously queues this write
   * before the planner can make a follow-up MCP request on the submitted turn. */
  recordRawUserSubmission(sessionId: string): Promise<void> {
    if (
      this.retiredSessions.has(sessionId) ||
      !this.options.sessionManager.get(sessionId)?.planning
    )
      return Promise.resolve();
    const inputId = this.generateId();
    const acceptedAt = this.now();
    return this.serialize(sessionId, async () => {
      if (this.retiredSessions.has(sessionId)) return;
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.reconcileAcceptedInputs(
        await this.load(session),
      );
      const latestAcceptedInput = newestAcceptedUserInput(state, [
        { inputId, acceptedAt },
      ]);
      await this.persist(sessionId, {
        ...structuredClone(state),
        lastAcceptedUserInputId: latestAcceptedInput?.inputId ?? null,
        lastAcceptedUserInputAt: latestAcceptedInput?.acceptedAt ?? null,
      });
    });
  }

  /** Add local-only correlation without removing transcript content. */
  decorateLocalEvent(event: AnalyticsEvent): AnalyticsEvent {
    if (this.retiredSessions.has(event.harnessSessionId)) return event;
    const session = this.options.sessionManager.get(event.harnessSessionId);
    if (!session?.planning || event.type !== "prompt.submitted") return event;
    const prompt = typeof event.payload.prompt === "string" ? event.payload.prompt : "";
    const queue = this.expected.get(event.harnessSessionId) ?? [];
    const index = queue.findIndex((entry) => entry.text === prompt);
    const [match] = index < 0 ? [] : queue.splice(index, 1);
    if (queue.length === 0) this.expected.delete(event.harnessSessionId);
    const observed = this.observedAttempts.get(event.harnessSessionId) ?? [];
    // One barrier per observed planner prompt, including unmatched/user
    // prompts. turn.completed has no attempt token, so skipping those barriers
    // would let their completion shift a later greeting attempt instead.
    if (observed.length >= 256) {
      this.clearCorrelation(event.harnessSessionId);
      this.correlationOverflow.add(event.harnessSessionId);
    } else {
      observed.push(
        match?.kind === "greeting"
          ? { id: match.id, retired: match.retired === true }
          : null,
      );
      this.observedAttempts.set(event.harnessSessionId, observed);
    }
    if (!match) return event;
    return {
      ...event,
      payload: {
        ...event.payload,
        plannerOrigin: match.kind === "greeting" ? "infrastructure" : "user",
        ...(match.kind === "greeting"
          ? { plannerAttemptId: match.id }
          : { plannerInputId: match.id }),
      },
    };
  }

  /** Product telemetry receives no planning content, paths, or provider text. */
  redactForTelemetry(event: AnalyticsEvent): AnalyticsEvent {
    const session = this.options.sessionManager.get(event.harnessSessionId);
    return session?.planning
      ? {
          ...event,
          // The normalized hook envelope is attacker-controlled too: every
          // hook can supply `payload.session_id`. The harness session ID is the
          // server-owned planner correlation key, so provider identity is not
          // needed in remote planner telemetry at all.
          agentSessionId: null,
          payload: telemetryPayload(event),
        }
      : event;
  }

  async onEventPersisted(event: AnalyticsEvent): Promise<void> {
    if (event.type !== "turn.completed") return;
    await this.serialize(event.harnessSessionId, async () => {
      if (this.retiredSessions.has(event.harnessSessionId)) return;
      // Consume exactly one prompt barrier for every completion before looking
      // at lifecycle state. In particular, a late completion while attempt 1
      // is failed must not remain queued to satisfy a later retry.
      const observed = this.observedAttempts.get(event.harnessSessionId);
      const completedAttempt = observed?.shift();
      if (observed?.length === 0) {
        this.observedAttempts.delete(event.harnessSessionId);
      }
      const session = this.options.sessionManager.get(event.harnessSessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      if (this.correlationOverflow.delete(event.harnessSessionId)) {
        if (state.metadata.greeting.status === "generating") {
          await this.setFailure(
            state,
            state.metadata.greeting.attemptId,
            "model_turn_failed",
            true,
          );
        }
        return;
      }
      if (state.metadata.greeting.status !== "generating") return;
      const attemptId = state.metadata.greeting.attemptId;
      if (!completedAttempt) return;
      // Stop/turn.completed carries no attempt token. Consume correlations in
      // prompt-observation order: a retired older turn is a tombstone, never
      // evidence that the currently generating retry completed.
      if (completedAttempt.retired || completedAttempt.id !== attemptId) return;
      const text = event.payload.assistantText;
      if (typeof text !== "string" || text.trim() === "") {
        await this.setFailure(state, attemptId, "model_turn_failed", true);
        return;
      }
      this.clearTimer(event.harnessSessionId, attemptId);
      state.metadata.greeting = {
        status: "delivered",
        messageId: event.eventId,
      };
      await this.persist(event.harnessSessionId, state);
      this.clearCorrelation(event.harnessSessionId);
      this.emit({
        name: "planner_greeting.delivered",
        projectId: state.metadata.identity.projectId,
        sessionId: event.harnessSessionId,
        attemptId,
        queueDepth: state.inputs.length,
      });
      await this.drain(state);
    });
  }
}
