import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ProjectBootstrapLifecycleEvent,
  ProjectBootstrapInputReceipt,
  ProjectBootstrapQueuedInput,
  ProjectBootstrapMetadata,
  ProjectAgentSession,
} from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";
import type { SessionManager } from "./session-manager.js";

export type ProjectBootstrapAttemptPhase =
  | "claimed"
  | "dispatching"
  | "not-submitted"
  | "submitted";

export interface PersistedProjectBootstrapInputReceipt extends ProjectBootstrapInputReceipt {
  payloadDigest: string;
}

export interface PersistedProjectBootstrapState {
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

export interface AcceptedInputLedger {
  schemaVersion: 1;
  inputIds: string[];
}

export interface PersistedProjectBootstrapIntent {
  schemaVersion: 1;
  projectId: string;
  userId: string;
  targetSessionId: string | null;
  status: "scheduled" | "claimed";
  createdAt: string;
  updatedAt: string;
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

export class ProjectBootstrapInputCapacityError extends Error {
  readonly code = "project_bootstrap_input_capacity";

  constructor() {
    super("project bootstrap input receipt capacity is temporarily full");
    this.name = "ProjectBootstrapInputCapacityError";
  }
}

export const MAX_RETRIES = 2;

export const MAX_INPUT_RECEIPTS = 128;

/**
 * Keep a bounded recent idempotency window. Entries that still own queued or
 * submitted work are never evicted. Only completed unkeyed bookkeeping is
 * retired; keyed receipts remain stable until the bounded store reaches
 * capacity, at which point a new logical request fails before mutation.
 */
export function compactInputReceipts(
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

export function projectBootstrapInputDigest(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, submit: true, text }))
    .digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTerminal(metadata: ProjectBootstrapMetadata): boolean {
  return (
    metadata.bootstrap.status === "delivered" ||
    metadata.bootstrap.status === "skipped"
  );
}

export function validBootstrapState(value: unknown): boolean {
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

export function parsePersistedProjectBootstrapState(
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
        storedAttempts.filter(validAttempt).map((attempt) => attempt.attemptId),
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
    ? value.attempts.filter(validAttempt).map((attempt) => ({
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
  if (
    normalizedInputs.length > 0 &&
    !isTerminal({
      projectId: expected.projectId,
      userId: expected.userId,
      targetSessionId: expected.targetSessionId,
      bootstrap: normalizedBootstrap,
      queuedInputIds: normalizedInputs.map((input) => input.id),
    })
  ) {
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
export interface ProjectBootstrapStoreOptions {
  root: string;
  legacyStateRoot?: string;
  now?: () => string;
  sessionManager: Pick<SessionManager, "get" | "setProjectBootstrapMetadata">;
  writeState?: (file: string, state: unknown) => Promise<void>;
  writeAcceptedLedger?: (file: string, state: unknown) => Promise<void>;
  onEvent?: (event: ProjectBootstrapLifecycleEvent) => Promise<void> | void;
}

/** Durable project enrollment and input state shared by the bootstrap lifecycle.
 * This storage boundary does not start sessions, timers, or model turns. */
export class ProjectBootstrapStore {
  constructor(protected readonly storageOptions: ProjectBootstrapStoreOptions) {
    this.root = path.resolve(storageOptions.root);
    this.legacyStateRoot = storageOptions.legacyStateRoot
      ? path.resolve(storageOptions.legacyStateRoot)
      : null;
    this.now = storageOptions.now ?? (() => new Date().toISOString());
  }

  protected readonly root: string;

  protected readonly legacyStateRoot: string | null;

  protected readonly now: () => string;

  protected readonly states = new Map<string, PersistedProjectBootstrapState>();

  protected readonly writes = new Map<string, Promise<unknown>>();

  /** Project claims made before SessionManager publishes the new session. */
  protected readonly provisionalProjectClaims = new Map<string, string>();

  protected readonly provisionalSessionClaims = new Map<string, string>();

  protected closed = false;

  protected sessionDirectory(sessionId: string): string {
    const directory = path.resolve(this.root, sessionId);
    const rootPrefix = `${this.root}${path.sep}`;
    if (!directory.startsWith(rootPrefix)) {
      throw new Error("invalid project bootstrap storage identity");
    }
    return directory;
  }

  protected file(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "input-queue.json");
  }

  protected legacyFile(sessionId: string, name: string): string | null {
    if (!this.legacyStateRoot) return null;
    const directory = path.resolve(this.legacyStateRoot, sessionId);
    if (!directory.startsWith(`${this.legacyStateRoot}${path.sep}`)) {
      throw new Error("invalid legacy project bootstrap storage identity");
    }
    return path.join(directory, name);
  }

  protected acceptedFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "accepted-inputs.json");
  }

  protected projectIntentFile(projectId: string): string {
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

  protected emit(event: ProjectBootstrapLifecycleEvent): void {
    try {
      void Promise.resolve(this.storageOptions.onEvent?.(event)).catch(
        () => {},
      );
    } catch {
      // Telemetry is best effort and must never change bootstrap semantics.
    }
  }

  protected assertOpen(): void {
    if (this.closed) throw new ProjectBootstrapCoordinatorClosedError();
  }

  protected receiptForInput(
    state: PersistedProjectBootstrapState,
    inputId: string,
  ): PersistedProjectBootstrapInputReceipt | undefined {
    return state.receipts.find((receipt) => receipt.inputId === inputId);
  }

  protected updateReceiptStatus(
    state: PersistedProjectBootstrapState,
    inputId: string,
    status: ProjectBootstrapInputReceipt["status"],
  ): void {
    const receipt = this.receiptForInput(state, inputId);
    if (!receipt) return;
    // `completed` and `uncertain` are distinct terminal evidence. Neither may
    // be weakened or rewritten by later boot reconciliation or a late hook.
    if (receipt.status === "completed" || receipt.status === "uncertain")
      return;
    if (receipt.status === "submitted" && status === "queued") return;
    receipt.status = status;
  }

  protected serialize<T>(
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

  protected newState(
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

  protected async load(
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

  protected async writeState(
    file: string,
    state: PersistedProjectBootstrapState,
  ): Promise<void> {
    if (this.storageOptions.writeState) {
      await this.storageOptions.writeState(file, structuredClone(state));
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  protected async writeIntent(
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

  protected async readIntent(
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
  protected async targetHasUnresolvedInput(
    sessionId: string,
  ): Promise<boolean> {
    const target = this.storageOptions.sessionManager.get(sessionId);
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
        ? this.storageOptions.sessionManager.get(intent.targetSessionId)
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
        const target = this.storageOptions.sessionManager.get(
          intent.targetSessionId!,
        );
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

  protected async acceptedInputIds(
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

  protected async quarantineAcceptedLedger(sessionId: string): Promise<void> {
    const file = this.acceptedFile(sessionId);
    const quarantine = path.join(
      path.dirname(file),
      `accepted-inputs.corrupt-${this.now().replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.json`,
    );
    await fs.rename(file, quarantine).catch(() => {});
  }

  protected async terminalizeUnreadableAcceptedLedger(
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
      if (receipt && receipt.status !== "completed")
        receipt.status = "uncertain";
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

  protected async writeAcceptedInputIds(
    sessionId: string,
    inputIds: readonly string[],
  ): Promise<void> {
    const file = this.acceptedFile(sessionId);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const ledger: AcceptedInputLedger = {
      schemaVersion: 1,
      inputIds: [...inputIds],
    };
    if (this.storageOptions.writeAcceptedLedger) {
      await this.storageOptions.writeAcceptedLedger(
        file,
        structuredClone(ledger),
      );
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

  protected async recordAcceptedInput(
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

  protected async reconcileAcceptedInputs(
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
      if (queued && receipt?.status === "uncertain") {
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

  protected async persist(
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
          await this.storageOptions.sessionManager.setProjectBootstrapMetadata(
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
    await this.storageOptions.sessionManager
      .setProjectBootstrapMetadata(sessionId, state.metadata)
      .catch(() => {});
  }

  /**
   * Merge the two durable stores under a single serialized registration CAS.
   * Queue-file inputs are authoritative. A terminal manager greeting is newer
   * than a non-terminal queue greeting (resume suppression), while a terminal
   * queue greeting is newer than a stale non-terminal manager snapshot.
   */
  protected mergeRegistration(
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
}
