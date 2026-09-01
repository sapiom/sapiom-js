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
  SessionManager,
  SessionNotReadyError,
} from "./session-manager.js";

interface PersistedPlannerState {
  schemaVersion: 1;
  metadata: PlannerSessionMetadata;
  inputs: PlannerQueuedInput[];
  retryCount: number;
  emptyProject: boolean;
}

interface ExpectedPrompt {
  kind: "greeting" | "user";
  id: string;
  text: string;
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
  onEvent?: (event: PlannerLifecycleEvent) => Promise<void> | void;
}

export class PlannerGreetingRetryUnavailableError extends Error {
  readonly code = "greeting_retry_unavailable";

  constructor() {
    super("greeting retry is not available");
    this.name = "PlannerGreetingRetryUnavailableError";
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
        typeof input.acceptedAt === "string",
    ) ||
    metadata.queuedInputIds.length !== inputs.length ||
    metadata.queuedInputIds.some(
      (id, index) => id !== (inputs[index] as Record<string, unknown>).id,
    )
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

export function plannerGreetingPrompt(emptyProject: boolean): string {
  const question = emptyProject
    ? "Ask exactly one open-ended question about what the system should accomplish."
    : "Briefly acknowledge that a current plan exists, then ask exactly one open-ended question about what the user wants to review, extend, or change.";
  return [
    "This is a private Agent Studio control turn.",
    "Respond as the project planning agent with one brief greeting.",
    "Explain that you and the user will plan the agents, responsibilities, data flow, resources, and connectors together.",
    question,
    "Do not propose an architecture, create nodes or relationships, invoke tools, or ask a second question before the user replies.",
  ].join(" ");
}

function telemetryPayload(event: AnalyticsEvent): Record<string, unknown> {
  switch (event.type) {
    case "session.start":
      return { source: event.payload.source ?? null, planner: true };
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
        model: event.payload.model ?? null,
        usage: event.payload.usage ?? null,
      };
    default:
      return { planner: true };
  }
}

export class PlannerGreetingCoordinator {
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly deliveryTimeoutMs: number;
  private readonly states = new Map<string, PersistedPlannerState>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly expected = new Map<string, ExpectedPrompt[]>();
  private readonly observedAttempts = new Map<string, string[]>();
  private readonly timers = new Map<string, AttemptTimer>();

  constructor(private readonly options: PlannerGreetingCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 45_000;
  }

  private file(sessionId: string): string {
    return path.join(this.options.root, sessionId, "input-queue.json");
  }

  private emit(event: PlannerLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Telemetry is best effort and must never change planner semantics.
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
      metadata: structuredClone(session.planning),
      inputs: [],
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
    if (cached) return cached;
    let state: PersistedPlannerState;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(this.file(session.id), "utf8"),
      );
      if (!isPersistedPlannerState(parsed, session)) {
        throw new Error("invalid planner state");
      }
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A single damaged or unreadable session queue is local corruption,
        // never a reason to prevent the rest of the harness from booting.
        await this.quarantine(session.id);
      }
      state = this.newState(session, emptyProject);
    }
    this.states.set(session.id, state);
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

  private clearTimer(sessionId: string, key?: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer || (key !== undefined && timer.key !== key)) return;
    clearTimeout(timer.handle);
    this.timers.delete(sessionId);
  }

  private armTimer(sessionId: string, key: "pending" | string): void {
    this.clearTimer(sessionId);
    const handle = setTimeout(() => {
      void this.fail(sessionId, key, key === "pending" ? "session_not_ready" : "delivery_timeout", true);
    }, this.deliveryTimeoutMs);
    handle.unref?.();
    this.timers.set(sessionId, { key, handle });
  }

  private async persist(
    sessionId: string,
    state: PersistedPlannerState,
  ): Promise<void> {
    this.states.set(sessionId, state);
    try {
      await this.writeState(this.file(sessionId), state);
      await this.options.sessionManager.setPlanningMetadata(
        sessionId,
        state.metadata,
      );
    } catch {
      if (
        state.metadata.greeting.status === "pending" ||
        state.metadata.greeting.status === "generating"
      ) {
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
        await this.options.sessionManager
          .setPlanningMetadata(sessionId, state.metadata)
          .catch(() => {});
        await this.writeState(this.file(sessionId), state).catch(() => {});
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

  async register(
    session: HarnessSession,
    context: PlannerRegistrationContext,
  ): Promise<void> {
    if (!session.planning) return;
    let shouldStart = false;
    let shouldDrain = false;
    await this.serialize(session.id, async () => {
      const cached = this.states.has(session.id);
      const state = await this.load(session, context.emptyProject);
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
      await this.persist(session.id, state);
      if (state.metadata.greeting.status === "pending") {
        if (session.ready && session.status === "running") shouldStart = true;
        else this.armTimer(session.id, "pending");
      } else if (isTerminal(state.metadata)) {
        shouldDrain = session.ready && session.status === "running";
      }
    });
    if (shouldStart) await this.startGreeting(session.id, false);
    else if (shouldDrain) await this.drainSession(session.id);
  }

  async onSessionStatus(session: HarnessSession): Promise<void> {
    if (!session.planning) return;
    if (session.ready && session.status === "running") {
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
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
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
      const prompt = plannerGreetingPrompt(state.emptyProject);
      try {
        const accepted = await this.options.sessionManager.submitInput(
          sessionId,
          prompt,
          true,
        );
        if (!accepted) {
          await this.setFailure(state, attemptId, "session_exited", false);
          return;
        }
        // Correlation is registered only after the PTY accepted the write.
        const queue = this.expected.get(sessionId) ?? [];
        queue.push({ kind: "greeting", id: attemptId, text: prompt });
        this.expected.set(sessionId, queue);
        this.armTimer(sessionId, attemptId);
      } catch (error) {
        await this.setFailure(
          state,
          attemptId,
          error instanceof SessionNotReadyError
            ? "session_not_ready"
            : "injection_failed",
          true,
        );
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
    if (state.inputs.length > 0) {
      state.metadata.greeting = { status: "skipped", reason: "user-proceeded" };
      await this.persist(sessionId, state);
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
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) throw new Error("planner session not found");
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
      if (isTerminal(state.metadata)) await this.drain(state);
      return structuredClone(state.metadata);
    });
  }

  private async drainSession(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      const session = this.options.sessionManager.get(sessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      if (isTerminal(state.metadata)) await this.drain(state);
    });
  }

  private async drain(state: PersistedPlannerState): Promise<void> {
    while (state.inputs.length > 0) {
      const input = state.inputs[0]!;
      const session = this.options.sessionManager.get(input.sessionId);
      if (!session?.ready || session.status !== "running") return;
      let accepted = false;
      try {
        accepted = await this.options.sessionManager.submitInput(
          input.sessionId,
          input.text,
          true,
        );
      } catch {
        return;
      }
      if (!accepted) return;
      // Register local correlation only after acceptance, then durably dequeue.
      const queue = this.expected.get(input.sessionId) ?? [];
      queue.push({ kind: "user", id: input.id, text: input.text });
      this.expected.set(input.sessionId, queue);
      state.inputs.shift();
      state.metadata.queuedInputIds.shift();
      await this.persist(input.sessionId, state);
    }
  }

  /** Add local-only correlation without removing transcript content. */
  decorateLocalEvent(event: AnalyticsEvent): AnalyticsEvent {
    const session = this.options.sessionManager.get(event.harnessSessionId);
    if (!session?.planning || event.type !== "prompt.submitted") return event;
    const prompt = typeof event.payload.prompt === "string" ? event.payload.prompt : "";
    const queue = this.expected.get(event.harnessSessionId) ?? [];
    const index = queue.findIndex((entry) => entry.text === prompt);
    if (index < 0) return event;
    const [match] = queue.splice(index, 1);
    if (match.kind === "greeting") {
      const observed = this.observedAttempts.get(event.harnessSessionId) ?? [];
      observed.push(match.id);
      this.observedAttempts.set(event.harnessSessionId, observed);
    }
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
      ? { ...event, payload: telemetryPayload(event) }
      : event;
  }

  async onEventPersisted(event: AnalyticsEvent): Promise<void> {
    if (event.type !== "turn.completed") return;
    const observed = this.observedAttempts.get(event.harnessSessionId);
    const attemptId = observed?.shift();
    if (!attemptId) return;
    await this.serialize(event.harnessSessionId, async () => {
      const session = this.options.sessionManager.get(event.harnessSessionId);
      if (!session?.planning) return;
      const state = await this.load(session);
      if (
        state.metadata.greeting.status !== "generating" ||
        state.metadata.greeting.attemptId !== attemptId
      ) {
        return;
      }
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
