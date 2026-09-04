import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAgentSession, StudioProjectId } from "../shared/agent-map.js";
import { canonicalDigest } from "../shared/agent-map-canonical.js";
import {
  hasAgentMapControlCharacter,
  parseProjectAgentActorRef,
} from "../shared/agent-map-codec.js";
import type { HarnessKind } from "../shared/types.js";
import {
  computeCanonicalDelegationBindingDigest,
  computeCanonicalDelegationRequestDigest,
  computeSubsessionContextDigest,
  parseProjectSubsessionRequest,
} from "../shared/subsession-delegation-codec.js";
import {
  PROJECT_SUBSESSION_CLAIM_TTL_MS,
  PROJECT_SUBSESSION_LIVE_SESSION_LIMIT,
  PROJECT_SUBSESSION_MAX_DEPTH,
  PROJECT_SUBSESSION_SCHEMA_VERSION,
  SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION,
  type CanonicalDelegationRequestDigest,
  type DelegatedSessionState,
  type DelegationError,
  type ProjectSubsessionRequest,
  type SubsessionBindingId,
  type SubsessionBindingRecord,
  type SubsessionClaim,
  type SubsessionKickoffDelivery,
  type SubsessionProjectionDigest,
} from "../shared/subsession-delegation.js";
import { DurableFileLock } from "./durable-file-lock.js";
import { isStudioProjectId } from "./studio-project-catalog.js";

export const SUBSESSION_COORDINATOR_BINDING_LIMIT = 8_192;
export const SUBSESSION_COORDINATOR_RECEIPT_LIMIT = 8_192;
export const SUBSESSION_COORDINATOR_RECEIPT_RETENTION_LIMIT = 256;
export const SUBSESSION_COORDINATOR_DELIVERY_LIMIT = 64;

export type SubsessionCoordinatorStoreErrorCode =
  | "malformed_state"
  | "unsupported_schema"
  | "storage_unavailable"
  | "capacity_exceeded"
  | "history_quota_exceeded"
  | "live_session_limit_reached"
  | "delegation_depth_exceeded"
  | "request_key_reused"
  | "request_key_expired"
  | "delegation_key_reused"
  | "binding_not_found"
  | "binding_scope_mismatch"
  | "lifecycle_conflict"
  | "claim_conflict"
  | "session_closed";

export class SubsessionCoordinatorStoreError extends Error {
  constructor(
    readonly code: SubsessionCoordinatorStoreErrorCode,
    readonly schemaVersion?: number,
  ) {
    super(
      code === "storage_unavailable"
        ? "Subsession coordinator storage is unavailable"
        : code === "unsupported_schema"
          ? "Subsession coordinator state uses an unsupported schema"
          : "Subsession coordinator operation was rejected",
    );
    this.name = "SubsessionCoordinatorStoreError";
  }
}

export type SubsessionCoordinatorRequestReceipt = Readonly<{
  parentSessionId: string;
  requestKey: string;
  requestDigest: CanonicalDelegationRequestDigest;
  operation: ProjectSubsessionRequest["operation"]["kind"];
  bindingIds: readonly SubsessionBindingId[];
  createdAt: string;
}>;

export type SubsessionCoordinatorRequestTombstone =
  SubsessionCoordinatorRequestReceipt;

export type SubsessionCoordinatorBindingTombstone = Readonly<{
  bindingId: SubsessionBindingId;
  parentSessionId: string;
  parentBindingId: SubsessionBindingId | null;
  delegationDepth: number;
  delegationKey: string;
  bindingDigest: string;
  sessionId: string;
  disposition: "terminal" | "dormant-evicted";
  closedAt: string;
}>;

export type SubsessionCoordinatorAggregate = Readonly<{
  schemaVersion: typeof SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION;
  recordVersion: number;
  projectId: StudioProjectId;
  requestReceipts: readonly SubsessionCoordinatorRequestReceipt[];
  requestTombstones: readonly SubsessionCoordinatorRequestTombstone[];
  bindingTombstones: readonly SubsessionCoordinatorBindingTombstone[];
  bindings: readonly SubsessionBindingRecord[];
  createdAt: string;
  updatedAt: string;
  aggregateDigest: string;
}>;

export interface SubsessionCoordinatorStoreEvent {
  name:
    | "subsession.store_initialized"
    | "subsession.binding_reserved"
    | "subsession.duplicate_prevented"
    | "subsession.spawn_claimed"
    | "subsession.kickoff_claimed"
    | "subsession.kickoff_uncertain";
  projectId: StudioProjectId;
  count?: number;
}

export interface ReservedDelegations {
  replayed: boolean;
  requestDigest: CanonicalDelegationRequestDigest;
  bindings: readonly SubsessionBindingRecord[];
}

export type ReleasableSubsessionBinding =
  | Readonly<{
      state: "bound";
      binding: SubsessionBindingRecord;
    }>
  | Readonly<{
      /** This request atomically committed the dormant eviction. */
      state: "evicted";
      binding: SubsessionCoordinatorBindingTombstone;
    }>
  | Readonly<{
      state: "released";
      binding: SubsessionCoordinatorBindingTombstone;
    }>
  | Readonly<{
      state: "absent";
      delegationKey: string;
    }>;

export interface ReservedReleases {
  replayed: boolean;
  requestDigest: CanonicalDelegationRequestDigest;
  bindings: readonly ReleasableSubsessionBinding[];
}

export type SpawnClaimResult =
  | Readonly<{ claimed: true; binding: SubsessionBindingRecord }>
  | Readonly<{
      claimed: false;
      reason: "active" | "expired-requires-inspection";
      binding: SubsessionBindingRecord;
    }>;

export type KickoffClaimResult =
  | Readonly<{ claimed: true; binding: SubsessionBindingRecord }>
  | Readonly<{
      claimed: false;
      reason: "already-claimed" | "expired-requires-reconciliation" | "terminal";
      binding: SubsessionBindingRecord;
    }>;

export type FocusedContextRefreshResult = Readonly<{
  replayed: boolean;
  requestDigest: CanonicalDelegationRequestDigest;
  binding: SubsessionBindingRecord;
}>;

type ShallowMutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableClaim = ShallowMutable<SubsessionClaim>;
type MutableDelivery = Omit<
  ShallowMutable<SubsessionKickoffDelivery>,
  "claim"
> & { claim: MutableClaim | null };
type MutableRuntime = ShallowMutable<
  NonNullable<SubsessionBindingRecord["runtime"]>
>;
type MutableBinding = Omit<
  ShallowMutable<SubsessionBindingRecord>,
  "spawnClaim" | "runtime" | "deliveries" | "lastError"
> & {
  spawnClaim: MutableClaim | null;
  runtime: MutableRuntime | null;
  deliveries: MutableDelivery[];
  lastError: DelegationError | null;
};
type MutableAggregate = Omit<
  ShallowMutable<SubsessionCoordinatorAggregate>,
  "requestReceipts" | "requestTombstones" | "bindingTombstones" | "bindings"
> & {
  requestReceipts: SubsessionCoordinatorRequestReceipt[];
  requestTombstones: SubsessionCoordinatorRequestTombstone[];
  bindingTombstones: SubsessionCoordinatorBindingTombstone[];
  bindings: MutableBinding[];
};

const storageError = () =>
  new SubsessionCoordinatorStoreError("storage_unavailable");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);

const identifier = (value: unknown, prefix?: string): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !hasAgentMapControlCharacter(value) &&
  (prefix === undefined || value.startsWith(`${prefix}_`));

const parseClaim = (value: unknown): SubsessionClaim | null => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !exact(value, ["claimId", "ownerId", "claimedAt", "expiresAt"]) ||
    !identifier(value.claimId) ||
    !identifier(value.ownerId) ||
    !timestamp(value.claimedAt) ||
    !timestamp(value.expiresAt) ||
    value.expiresAt <= value.claimedAt
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return structuredClone(value) as unknown as SubsessionClaim;
};

const parseDelivery = (value: unknown): SubsessionKickoffDelivery => {
  if (
    !isRecord(value) ||
    !exact(value, [
      "contextEpoch",
      "deliveryId",
      "inputId",
      "eventWatermark",
      "state",
      "attempt",
      "claim",
      "submittedAt",
      "acknowledgedAt",
    ]) ||
    !Number.isSafeInteger(value.contextEpoch) ||
    (value.contextEpoch as number) < 1 ||
    !identifier(value.deliveryId) ||
    !identifier(value.inputId) ||
    (value.eventWatermark !== null && !identifier(value.eventWatermark)) ||
    ![
      "pending",
      "claimed",
      "submitted-unacknowledged",
      "acknowledged",
      "uncertain",
    ].includes(String(value.state)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    (value.submittedAt !== null && !timestamp(value.submittedAt)) ||
    (value.acknowledgedAt !== null && !timestamp(value.acknowledgedAt))
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  const claim = parseClaim(value.claim);
  if (
    (value.state === "claimed") !== (claim !== null) ||
    (value.state === "acknowledged") !== (value.acknowledgedAt !== null)
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return { ...structuredClone(value), claim } as unknown as SubsessionKickoffDelivery;
};

const parseBoundedError = (value: unknown): DelegationError | null => {
  if (value === null) return null;
  if (!isRecord(value))
    throw new SubsessionCoordinatorStoreError("malformed_state");
  const allowed = ["code", "retryable", "recovery", "issues"];
  if (
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    !exact(
      Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
      ),
      value.issues === undefined
        ? ["code", "retryable", "recovery"]
        : allowed,
    ) ||
    !identifier(value.code) ||
    typeof value.retryable !== "boolean" ||
    !identifier(value.recovery) ||
    (value.issues !== undefined &&
      (!Array.isArray(value.issues) ||
        value.issues.length > 32 ||
        !value.issues.every(
          (issue) =>
            isRecord(issue) &&
            exact(issue, ["path", "code"]) &&
            identifier(issue.path) &&
            identifier(issue.code),
        )))
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return structuredClone(value) as unknown as DelegationError;
};

function parseBinding(
  value: unknown,
  projectId: StudioProjectId,
): SubsessionBindingRecord {
  if (
    !isRecord(value) ||
    !exact(value, [
      "bindingId",
      "projectId",
      "parentSessionId",
      "parentBindingId",
      "delegationDepth",
      "delegationKey",
      "bindingDigest",
      "outcome",
      "kickoffContext",
      "initialFocus",
      "sessionId",
      "harness",
      "projectRoot",
      "lifecycleEpoch",
      "spawnEpoch",
      "contextEpoch",
      "contextDigest",
      "contextState",
      "currentFocus",
      "projectionDigest",
      "sessionState",
      "spawnClaim",
      "runtime",
      "deliveries",
      "lastError",
      "createdAt",
      "updatedAt",
    ]) ||
    value.projectId !== projectId ||
    !identifier(value.bindingId, "binding") ||
    !identifier(value.parentSessionId) ||
    (value.parentBindingId !== null &&
      !identifier(value.parentBindingId, "binding")) ||
    !Number.isSafeInteger(value.delegationDepth) ||
    (value.delegationDepth as number) < 1 ||
    (value.delegationDepth as number) > PROJECT_SUBSESSION_MAX_DEPTH ||
    !identifier(value.sessionId) ||
    !["claude-code", "codex"].includes(String(value.harness)) ||
    typeof value.projectRoot !== "string" ||
    !path.isAbsolute(value.projectRoot) ||
    !Number.isSafeInteger(value.lifecycleEpoch) ||
    (value.lifecycleEpoch as number) < 1 ||
    !Number.isSafeInteger(value.spawnEpoch) ||
    (value.spawnEpoch as number) < 0 ||
    !Number.isSafeInteger(value.contextEpoch) ||
    (value.contextEpoch as number) < 1 ||
    !digest(value.bindingDigest) ||
    !digest(value.contextDigest) ||
    (value.projectionDigest !== null && !digest(value.projectionDigest)) ||
    !["none", "current", "stale", "refreshing"].includes(
      String(value.contextState),
    ) ||
    ![
      "reserved",
      "spawn-claimed",
      "starting",
      "awaiting-ready",
      "ready",
      "exited",
      "failed",
      "closed",
    ].includes(String(value.sessionState)) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.length < 1 ||
    value.deliveries.length > SUBSESSION_COORDINATOR_DELIVERY_LIMIT
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }

  const parsedRequest = parseProjectSubsessionRequest(
    {
      schemaVersion: PROJECT_SUBSESSION_SCHEMA_VERSION,
      requestKey: "persistence-check",
      operation: {
        kind: "delegate",
        delegations: [
          {
            delegationKey: value.delegationKey,
            outcome: value.outcome,
            ...(value.kickoffContext === null
              ? {}
              : { kickoffContext: value.kickoffContext }),
            ...(value.initialFocus === null
              ? {}
              : { focus: value.initialFocus }),
          },
        ],
      },
    },
    projectId,
  );
  if (parsedRequest.operation.kind !== "delegate")
    throw new SubsessionCoordinatorStoreError("malformed_state");
  const delegation = parsedRequest.operation.delegations[0]!;
  const currentFocus =
    value.currentFocus === null
      ? null
      : (() => {
          const parsed = parseProjectSubsessionRequest(
            {
              schemaVersion: PROJECT_SUBSESSION_SCHEMA_VERSION,
              requestKey: "context-check",
              operation: {
                kind: "delegate",
                delegations: [
                  {
                    delegationKey: "context-check",
                    outcome: "Context integrity check",
                    focus: value.currentFocus,
                  },
                ],
              },
            },
            projectId,
          );
          if (parsed.operation.kind !== "delegate")
            throw new SubsessionCoordinatorStoreError("malformed_state");
          return parsed.operation.delegations[0]!.focus!;
        })();
  if (
    computeCanonicalDelegationBindingDigest(delegation) !==
      value.bindingDigest ||
    computeSubsessionContextDigest(currentFocus) !== value.contextDigest
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  const spawnClaim = parseClaim(value.spawnClaim);
  if ((value.sessionState === "spawn-claimed") !== (spawnClaim !== null))
    throw new SubsessionCoordinatorStoreError("malformed_state");
  let runtime: SubsessionBindingRecord["runtime"] = null;
  if (value.runtime !== null) {
    if (
      !isRecord(value.runtime) ||
      !exact(value.runtime, ["runtimeToken", "incarnation", "spawnEpoch"]) ||
      !identifier(value.runtime.runtimeToken) ||
      !Number.isSafeInteger(value.runtime.incarnation) ||
      (value.runtime.incarnation as number) < 1 ||
      value.runtime.spawnEpoch !== value.spawnEpoch
    ) {
      throw new SubsessionCoordinatorStoreError("malformed_state");
    }
    runtime = structuredClone(value.runtime) as SubsessionBindingRecord["runtime"];
  }
  const deliveries = value.deliveries.map(parseDelivery);
  if (
    new Set(deliveries.map(({ contextEpoch }) => contextEpoch)).size !==
      deliveries.length ||
    deliveries.at(-1)?.contextEpoch !== value.contextEpoch
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return {
    ...structuredClone(value),
    initialFocus: delegation.focus ?? null,
    currentFocus,
    spawnClaim,
    runtime,
    deliveries,
    lastError: parseBoundedError(value.lastError),
  } as unknown as SubsessionBindingRecord;
}

const aggregateDigest = (
  value: Omit<SubsessionCoordinatorAggregate, "aggregateDigest"> | SubsessionCoordinatorAggregate,
) =>
  canonicalDigest(
    "sapiom.project-subsession.aggregate.v1",
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "aggregateDigest"),
    ),
  );

function parseReceipt(
  value: unknown,
): SubsessionCoordinatorRequestReceipt {
  if (
    !isRecord(value) ||
    !exact(value, [
      "parentSessionId",
      "requestKey",
      "requestDigest",
      "operation",
      "bindingIds",
      "createdAt",
    ]) ||
    !identifier(value.parentSessionId) ||
    !identifier(value.requestKey) ||
    !digest(value.requestDigest) ||
    ![
      "delegate",
      "refresh-focused-context",
      "release",
      "release-dormant",
    ].includes(
      String(value.operation),
    ) ||
    !Array.isArray(value.bindingIds) ||
    value.bindingIds.length > 16 ||
    !value.bindingIds.every((entry) => identifier(entry, "binding")) ||
    new Set(value.bindingIds).size !== value.bindingIds.length ||
    !timestamp(value.createdAt)
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return structuredClone(value) as unknown as SubsessionCoordinatorRequestReceipt;
}

function parseBindingTombstone(
  value: unknown,
): SubsessionCoordinatorBindingTombstone {
  if (
    !isRecord(value) ||
    !exact(value, [
      "bindingId",
      "parentSessionId",
      "parentBindingId",
      "delegationDepth",
      "delegationKey",
      "bindingDigest",
      "sessionId",
      "disposition",
      "closedAt",
    ]) ||
    !identifier(value.bindingId, "binding") ||
    !identifier(value.parentSessionId) ||
    (value.parentBindingId !== null &&
      !identifier(value.parentBindingId, "binding")) ||
    !Number.isSafeInteger(value.delegationDepth) ||
    (value.delegationDepth as number) < 1 ||
    (value.delegationDepth as number) > PROJECT_SUBSESSION_MAX_DEPTH ||
    !identifier(value.delegationKey) ||
    !digest(value.bindingDigest) ||
    !identifier(value.sessionId) ||
    !["terminal", "dormant-evicted"].includes(String(value.disposition)) ||
    !timestamp(value.closedAt)
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return structuredClone(value) as unknown as SubsessionCoordinatorBindingTombstone;
}

export function parseSubsessionCoordinatorAggregate(
  value: unknown,
  expectedProjectId: StudioProjectId,
): SubsessionCoordinatorAggregate {
  if (!isRecord(value))
    throw new SubsessionCoordinatorStoreError("malformed_state");
  if (
    value.schemaVersion !== SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION
  ) {
    throw new SubsessionCoordinatorStoreError(
      "unsupported_schema",
      typeof value.schemaVersion === "number" ? value.schemaVersion : undefined,
    );
  }
  if (
    !exact(value, [
      "schemaVersion",
      "recordVersion",
      "projectId",
      "requestReceipts",
      "requestTombstones",
      "bindingTombstones",
      "bindings",
      "createdAt",
      "updatedAt",
      "aggregateDigest",
    ]) ||
    value.projectId !== expectedProjectId ||
    !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 ||
    !Array.isArray(value.requestReceipts) ||
    value.requestReceipts.length > SUBSESSION_COORDINATOR_RECEIPT_LIMIT ||
    !Array.isArray(value.requestTombstones) ||
    value.requestTombstones.length > SUBSESSION_COORDINATOR_RECEIPT_LIMIT ||
    !Array.isArray(value.bindingTombstones) ||
    value.bindingTombstones.length > SUBSESSION_COORDINATOR_BINDING_LIMIT ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > SUBSESSION_COORDINATOR_BINDING_LIMIT ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !digest(value.aggregateDigest) ||
    aggregateDigest(value as unknown as SubsessionCoordinatorAggregate) !==
      value.aggregateDigest
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  const requestReceipts = value.requestReceipts.map(parseReceipt);
  const requestTombstones = value.requestTombstones.map(parseReceipt);
  const bindingTombstones = value.bindingTombstones.map(parseBindingTombstone);
  const bindings = value.bindings.map((entry) =>
    parseBinding(entry, expectedProjectId),
  );
  const requestKeys = [...requestReceipts, ...requestTombstones].map(
    ({ parentSessionId, requestKey }) => `${parentSessionId}\0${requestKey}`,
  );
  const bindingKeys = bindings.map(
    ({ parentSessionId, delegationKey }) =>
      `${parentSessionId}\0${delegationKey}`,
  );
  const allBindings = [...bindings, ...bindingTombstones];
  const terminalBindingKeys = [
    ...bindingKeys,
    ...bindingTombstones.map(
      ({ disposition, parentSessionId, delegationKey }) =>
        disposition === "terminal"
          ? `${parentSessionId}\0${delegationKey}`
          : null,
    ),
  ].filter((key): key is string => key !== null);
  if (
    new Set(requestKeys).size !== requestKeys.length ||
    new Set(terminalBindingKeys).size !== terminalBindingKeys.length ||
    new Set(allBindings.map(({ bindingId }) => bindingId)).size !==
      allBindings.length ||
    new Set(allBindings.map(({ sessionId }) => sessionId)).size !==
      allBindings.length
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  if (
    requestReceipts.some(({ bindingIds: ids }) =>
      ids.some(
        (bindingId) =>
          !bindings.some((binding) => binding.bindingId === bindingId) &&
          !bindingTombstones.some(
            (binding) => binding.bindingId === bindingId,
          ),
      ),
    )
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  const bindingsById = new Map(
    allBindings.map((binding) => [binding.bindingId, binding]),
  );
  if (
    allBindings.some((binding) => {
      if (binding.parentBindingId === null)
        return binding.delegationDepth !== 1;
      const parent = bindingsById.get(binding.parentBindingId);
      return parent !== undefined &&
        binding.delegationDepth !== parent.delegationDepth + 1;
    })
  ) {
    throw new SubsessionCoordinatorStoreError("malformed_state");
  }
  return {
    ...structuredClone(value),
    requestReceipts,
    requestTombstones,
    bindingTombstones,
    bindings,
  } as unknown as SubsessionCoordinatorAggregate;
}

const transitions: Readonly<Record<DelegatedSessionState, readonly DelegatedSessionState[]>> = {
  reserved: ["spawn-claimed", "failed", "closed"],
  "spawn-claimed": ["reserved", "starting", "failed", "closed"],
  starting: ["awaiting-ready", "ready", "exited", "failed", "closed"],
  "awaiting-ready": ["ready", "exited", "failed", "closed"],
  ready: ["exited", "failed", "closed"],
  exited: ["spawn-claimed", "failed", "closed"],
  failed: ["spawn-claimed", "closed"],
  closed: [],
};

export class SubsessionCoordinatorStore {
  private readonly queues = new Map<StudioProjectId, Promise<void>>();

  constructor(
    private readonly agentMapRoot: string,
    private readonly options: {
      now?: () => Date;
      generateId?: () => string;
      generateSessionId?: () => string;
      claimTtlMs?: number;
      receiptRetentionLimit?: number;
      historyTombstoneLimit?: number;
      bindingLimit?: number;
      liveSessionLimit?: number;
      maxDelegationDepth?: number;
      onEvent?: (event: SubsessionCoordinatorStoreEvent) => void | Promise<void>;
      beforePersistStep?: (
        step: "write" | "file-sync" | "rename" | "directory-sync",
      ) => void | Promise<void>;
    } = {},
  ) {}

  private filePath(projectId: StudioProjectId): string {
    return path.join(
      this.agentMapRoot,
      "projects",
      projectId,
      "subsessions.json",
    );
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private id(): string {
    return (this.options.generateId ?? randomUUID)();
  }

  private bindingLimit(): number {
    return Math.max(
      1,
      Math.min(
        this.options.bindingLimit ?? SUBSESSION_COORDINATOR_BINDING_LIMIT,
        SUBSESSION_COORDINATOR_BINDING_LIMIT,
      ),
    );
  }

  private compactTerminalHistory(aggregate: MutableAggregate): void {
    const historyLimit = Math.max(
      1,
      Math.min(
        this.options.historyTombstoneLimit ?? SUBSESSION_COORDINATOR_RECEIPT_LIMIT,
        SUBSESSION_COORDINATOR_RECEIPT_LIMIT,
      ),
    );
    const retention = Math.max(
      1,
      Math.min(
        this.options.receiptRetentionLimit ??
          SUBSESSION_COORDINATOR_RECEIPT_RETENTION_LIMIT,
        SUBSESSION_COORDINATOR_RECEIPT_LIMIT,
      ),
    );
    const expiring = Math.max(0, aggregate.requestReceipts.length - retention);
    for (let count = 0; count < expiring; count += 1) {
      const expired = aggregate.requestReceipts.shift();
      if (expired) {
        aggregate.requestTombstones.push({
          parentSessionId: expired.parentSessionId,
          requestKey: expired.requestKey,
          requestDigest: expired.requestDigest,
          operation: expired.operation,
          bindingIds: expired.bindingIds,
          createdAt: expired.createdAt,
        });
      }
    }
    if (aggregate.requestTombstones.length > historyLimit) {
      aggregate.requestTombstones.splice(
        0,
        aggregate.requestTombstones.length - historyLimit,
      );
    }

    const referenced = new Set(
      aggregate.requestReceipts.flatMap(({ bindingIds }) => bindingIds),
    );
    const reclaimable = aggregate.bindings.filter(
      (binding) =>
        binding.sessionState === "closed" && !referenced.has(binding.bindingId),
    );
    for (const binding of reclaimable) {
      aggregate.bindingTombstones.push({
        bindingId: binding.bindingId,
        parentSessionId: binding.parentSessionId,
        parentBindingId: binding.parentBindingId,
        delegationDepth: binding.delegationDepth,
        delegationKey: binding.delegationKey,
        bindingDigest: binding.bindingDigest,
        sessionId: binding.sessionId,
        disposition: "terminal",
        closedAt: binding.updatedAt,
      });
    }
    if (aggregate.bindingTombstones.length > historyLimit) {
      let remaining = aggregate.bindingTombstones.length - historyLimit;
      aggregate.bindingTombstones = aggregate.bindingTombstones.filter(
        ({ bindingId }) => {
          if (remaining === 0 || referenced.has(bindingId)) return true;
          remaining -= 1;
          return false;
        },
      );
    }
    if (reclaimable.length > 0) {
      const reclaimed = new Set(reclaimable.map(({ bindingId }) => bindingId));
      aggregate.bindings = aggregate.bindings.filter(
        ({ bindingId }) => !reclaimed.has(bindingId),
      );
    }
  }

  private emit(event: SubsessionCoordinatorStoreEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Content-free observability cannot alter durable state.
    }
  }

  private initial(projectId: StudioProjectId): SubsessionCoordinatorAggregate {
    const now = this.now();
    const initial = {
      schemaVersion: SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION,
      recordVersion: 1,
      projectId,
      requestReceipts: [],
      requestTombstones: [],
      bindingTombstones: [],
      bindings: [],
      createdAt: now,
      updatedAt: now,
    } as const;
    return { ...initial, aggregateDigest: aggregateDigest(initial) };
  }

  private async readDisk(projectId: StudioProjectId): Promise<{
    aggregate: SubsessionCoordinatorAggregate;
    created: boolean;
  }> {
    try {
      const decoded = JSON.parse(
        await fs.readFile(this.filePath(projectId), "utf8"),
      ) as unknown;
      return {
        aggregate: parseSubsessionCoordinatorAggregate(decoded, projectId),
        created: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { aggregate: this.initial(projectId), created: true };
      if (
        error instanceof SubsessionCoordinatorStoreError &&
        error.code !== "storage_unavailable"
      ) {
        throw error;
      }
      if (error instanceof SyntaxError)
        throw new SubsessionCoordinatorStoreError("malformed_state");
      throw storageError();
    }
  }

  private async persist(
    projectId: StudioProjectId,
    aggregate: SubsessionCoordinatorAggregate,
  ): Promise<void> {
    const file = this.filePath(projectId);
    const directory = path.dirname(file);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    let handle: fs.FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await fs.open(temporary, "wx", 0o600);
      await this.options.beforePersistStep?.("write");
      await handle.writeFile(`${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
      await this.options.beforePersistStep?.("file-sync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.options.beforePersistStep?.("rename");
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
      const directoryHandle = await fs.open(directory, "r");
      try {
        await this.options.beforePersistStep?.("directory-sync");
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      throw storageError();
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private enqueue<T>(
    projectId: StudioProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(projectId, tail);
    void tail.finally(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return result;
  }

  private async transact<T>(
    projectId: StudioProjectId,
    operation: (
      aggregate: MutableAggregate,
    ) => Promise<{ value: T; next?: MutableAggregate }>,
  ): Promise<T> {
    if (!isStudioProjectId(projectId))
      throw new SubsessionCoordinatorStoreError("malformed_state");
    return this.enqueue(projectId, async () => {
      const release = await new DurableFileLock(this.filePath(projectId), {
        storageError,
      }).acquire();
      try {
        const loaded = await this.readDisk(projectId);
        const outcome = await operation(
          structuredClone(loaded.aggregate) as unknown as MutableAggregate,
        );
        if (loaded.created || outcome.next) {
          const candidate = outcome.next ??
            (structuredClone(loaded.aggregate) as unknown as MutableAggregate);
          const sealed = parseSubsessionCoordinatorAggregate(
            {
              ...candidate,
              aggregateDigest: aggregateDigest(candidate),
            },
            projectId,
          );
          await this.persist(projectId, sealed);
        }
        if (loaded.created)
          this.emit({ name: "subsession.store_initialized", projectId });
        return structuredClone(outcome.value);
      } finally {
        await release();
      }
    });
  }

  read(projectId: StudioProjectId): Promise<SubsessionCoordinatorAggregate> {
    return this.transact(projectId, async (aggregate) => ({ value: aggregate }));
  }

  readBinding(
    identity: ProjectAgentSession,
    selector: Readonly<
      | { kind: "binding-id"; bindingId: SubsessionBindingId }
      | { kind: "child"; delegationKey: string }
      | { kind: "self" }
    >,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding =
        selector.kind === "binding-id"
          ? aggregate.bindings.find(
              (entry) =>
                entry.bindingId === selector.bindingId &&
                entry.parentSessionId === identity.sessionId,
            )
          : selector.kind === "child"
            ? aggregate.bindings.find(
                (entry) =>
                  entry.parentSessionId === identity.sessionId &&
                  entry.delegationKey === selector.delegationKey,
              )
            : aggregate.bindings.find(
                (entry) => entry.sessionId === identity.sessionId,
              );
      if (!binding)
        throw new SubsessionCoordinatorStoreError("binding_not_found");
      if (binding.projectId !== identity.projectId)
        throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
      return { value: binding };
    });
  }

  setFocusedContextState(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      expectedContextEpoch: number;
      expectedContextDigest: string;
      state: "none" | "current" | "stale";
      projectionDigest: SubsessionProjectionDigest | null;
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (
        binding.contextEpoch !== request.expectedContextEpoch ||
        binding.contextDigest !== request.expectedContextDigest
      ) {
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      }
      if (
        binding.contextState === request.state &&
        binding.projectionDigest === request.projectionDigest
      ) {
        return { value: binding };
      }
      const now = this.now();
      binding.contextState = request.state;
      binding.projectionDigest = request.projectionDigest;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }

  closeBinding(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    expectedSessionId: string,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (binding.sessionId !== expectedSessionId)
        throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
      if (binding.sessionState === "closed") return { value: binding };
      const now = this.now();
      binding.sessionState = "closed";
      binding.lifecycleEpoch += 1;
      binding.spawnClaim = null;
      binding.runtime = null;
      binding.updatedAt = now;
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }

  /** Compacts an exact durably closed binding while release receipts retain replay. */
  finalizeReleasedBinding(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    expectedSessionId: string,
  ): Promise<SubsessionCoordinatorBindingTombstone> {
    return this.transact(identity.projectId, async (aggregate) => {
      const existing = aggregate.bindingTombstones.find(
        (entry) => entry.bindingId === bindingId,
      );
      if (existing) {
        if (
          existing.parentSessionId !== identity.sessionId ||
          existing.sessionId !== expectedSessionId
        ) {
          throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
        }
        return { value: existing };
      }
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (binding.sessionId !== expectedSessionId)
        throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
      if (binding.sessionState !== "closed")
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      const tombstone: SubsessionCoordinatorBindingTombstone = {
        bindingId: binding.bindingId,
        parentSessionId: binding.parentSessionId,
        parentBindingId: binding.parentBindingId,
        delegationDepth: binding.delegationDepth,
        delegationKey: binding.delegationKey,
        bindingDigest: binding.bindingDigest,
        sessionId: binding.sessionId,
        disposition: "terminal",
        closedAt: binding.updatedAt,
      };
      aggregate.bindings = aggregate.bindings.filter(
        (entry) => entry.bindingId !== bindingId,
      );
      aggregate.bindingTombstones.push(tombstone);
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = this.now();
      return { value: tombstone, next: aggregate };
    });
  }

  reserveReleases(
    identity: ProjectAgentSession,
    rawRequest: unknown,
  ): Promise<ReservedReleases> {
    const request = parseProjectSubsessionRequest(rawRequest, identity.projectId);
    if (request.operation.kind !== "release")
      throw new SubsessionCoordinatorStoreError("malformed_state");
    const operation = request.operation;
    const requestDigest = computeCanonicalDelegationRequestDigest(request);
    return this.transact<ReservedReleases>(identity.projectId, async (aggregate) => {
      const sameRequest = (
        receipt: Pick<SubsessionCoordinatorRequestReceipt, "parentSessionId" | "requestKey">,
      ) =>
        receipt.parentSessionId === identity.sessionId &&
        receipt.requestKey === request.requestKey;
      const resolve = (bindingId: SubsessionBindingId): ReleasableSubsessionBinding => {
        const binding = aggregate.bindings.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (binding) {
          if (binding.parentSessionId !== identity.sessionId)
            throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
          return { state: "bound", binding };
        }
        const released = aggregate.bindingTombstones.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (!released || released.parentSessionId !== identity.sessionId)
          throw new SubsessionCoordinatorStoreError("malformed_state");
        return { state: "released", binding: released };
      };
      const previous = aggregate.requestReceipts.find(sameRequest);
      if (previous) {
        if (
          previous.requestDigest !== requestDigest ||
          previous.operation !== "release"
        ) {
          throw new SubsessionCoordinatorStoreError("request_key_reused");
        }
        const resolved = previous.bindingIds.map(resolve);
        return {
          value: {
            replayed: true,
            requestDigest,
            bindings: operation.delegationKeys.map(
              (delegationKey) =>
                resolved.find(
                  (entry) =>
                    entry.state !== "absent" &&
                    entry.binding.delegationKey === delegationKey,
                ) ?? { state: "absent", delegationKey },
            ),
          },
        };
      }
      if (aggregate.requestTombstones.some(sameRequest))
        throw new SubsessionCoordinatorStoreError("request_key_expired");
      const bindings = operation.delegationKeys.map(
        (delegationKey): ReleasableSubsessionBinding => {
          const binding = aggregate.bindings.find(
            (entry) =>
              entry.parentSessionId === identity.sessionId &&
              entry.delegationKey === delegationKey,
          );
          if (binding) return { state: "bound", binding };
          const released = aggregate.bindingTombstones.find(
            (entry) =>
              entry.parentSessionId === identity.sessionId &&
              entry.delegationKey === delegationKey,
          );
          if (released) return { state: "released", binding: released };
          return { state: "absent", delegationKey };
        },
      );
      const now = this.now();
      aggregate.requestReceipts.push({
        parentSessionId: identity.sessionId,
        requestKey: request.requestKey,
        requestDigest,
        operation: "release",
        bindingIds: bindings.flatMap((entry) =>
          entry.state === "absent" ? [] : [entry.binding.bindingId],
        ),
        createdAt: now,
      });
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return {
        value: { replayed: false, requestDigest, bindings },
        next: aggregate,
      };
    });
  }

  /**
   * Reserves an explicit project-scoped cleanup of dormant coordinator-owned
   * bindings. Candidate IDs are selected by the trusted coordinator and never
   * accepted from the public request. The transaction rechecks the child state;
   * parent liveness is intentionally irrelevant to this explicit project-wide
   * destructive operation.
   */
  reserveDormantReleases(
    identity: ProjectAgentSession,
    rawRequest: unknown,
    candidateBindingIds: readonly SubsessionBindingId[],
  ): Promise<ReservedReleases> {
    const request = parseProjectSubsessionRequest(rawRequest, identity.projectId);
    if (request.operation.kind !== "release-dormant")
      throw new SubsessionCoordinatorStoreError("malformed_state");
    if (
      candidateBindingIds.length > request.operation.limit ||
      new Set(candidateBindingIds).size !== candidateBindingIds.length ||
      !candidateBindingIds.every((bindingId) =>
        identifier(bindingId, "binding"),
      )
    ) {
      throw new SubsessionCoordinatorStoreError("malformed_state");
    }
    const requestDigest = computeCanonicalDelegationRequestDigest(request);
    return this.transact<ReservedReleases>(identity.projectId, async (aggregate) => {
      const sameRequest = (
        receipt: Pick<SubsessionCoordinatorRequestReceipt, "parentSessionId" | "requestKey">,
      ) =>
        receipt.parentSessionId === identity.sessionId &&
        receipt.requestKey === request.requestKey;
      const resolve = (
        bindingId: SubsessionBindingId,
      ): ReleasableSubsessionBinding => {
        const binding = aggregate.bindings.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (binding) return { state: "bound", binding };
        const released = aggregate.bindingTombstones.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (released) return { state: "released", binding: released };
        throw new SubsessionCoordinatorStoreError("malformed_state");
      };
      const previous = aggregate.requestReceipts.find(sameRequest);
      if (previous) {
        if (
          previous.requestDigest !== requestDigest ||
          previous.operation !== "release-dormant"
        ) {
          throw new SubsessionCoordinatorStoreError("request_key_reused");
        }
        return {
          value: {
            replayed: true,
            requestDigest,
            bindings: previous.bindingIds.map(resolve),
          },
        };
      }
      if (aggregate.requestTombstones.some(sameRequest))
        throw new SubsessionCoordinatorStoreError("request_key_expired");
      this.compactTerminalHistory(aggregate);
      const now = this.now();
      const bindings: ReleasableSubsessionBinding[] = [];
      const evictedBindingIds = new Set<SubsessionBindingId>();
      for (const bindingId of candidateBindingIds) {
        const binding = aggregate.bindings.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (binding) {
          if (["exited", "failed"].includes(binding.sessionState)) {
            // The explicit destructive boundary and request receipt commit in
            // the same transaction. A concurrent resume must lose this fence
            // before any exact private ownership marker is removed.
            const tombstone: SubsessionCoordinatorBindingTombstone = {
              bindingId: binding.bindingId,
              parentSessionId: binding.parentSessionId,
              parentBindingId: binding.parentBindingId,
              delegationDepth: binding.delegationDepth,
              delegationKey: binding.delegationKey,
              bindingDigest: binding.bindingDigest,
              sessionId: binding.sessionId,
              disposition: "dormant-evicted",
              closedAt: now,
            };
            aggregate.bindingTombstones.push(tombstone);
            evictedBindingIds.add(binding.bindingId);
            bindings.push({ state: "evicted", binding: tombstone });
          }
          continue;
        }
        const released = aggregate.bindingTombstones.find(
          (entry) => entry.bindingId === bindingId,
        );
        if (released) bindings.push({ state: "released", binding: released });
      }
      if (evictedBindingIds.size > 0) {
        const retainedReceipts: SubsessionCoordinatorRequestReceipt[] = [];
        for (const receipt of aggregate.requestReceipts) {
          if (
            receipt.operation !== "release-dormant" &&
            receipt.bindingIds.some((bindingId) =>
              evictedBindingIds.has(bindingId),
            )
          ) {
            aggregate.requestTombstones.push(receipt);
          } else {
            retainedReceipts.push(receipt);
          }
        }
        aggregate.requestReceipts = retainedReceipts;
        aggregate.bindings = aggregate.bindings.filter(
          ({ bindingId }) => !evictedBindingIds.has(bindingId),
        );
      }
      aggregate.requestReceipts.push({
        parentSessionId: identity.sessionId,
        requestKey: request.requestKey,
        requestDigest,
        operation: "release-dormant",
        bindingIds: bindings.flatMap((entry) =>
          entry.state === "absent" ? [] : [entry.binding.bindingId],
        ),
        createdAt: now,
      });
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return {
        value: { replayed: false, requestDigest, bindings },
        next: aggregate,
      };
    });
  }

  /** Server-only bridge from SessionManager's private two-sided marker. */
  closeOwnedBinding(marker: Readonly<{
    projectId: StudioProjectId;
    parentSessionId: string;
    bindingId: string;
    sessionId: string;
  }>): Promise<void> {
    return this.transact<void>(marker.projectId, async (aggregate) => {
      const binding = aggregate.bindings.find(
        ({ bindingId }) => bindingId === marker.bindingId,
      );
      if (!binding) {
        const tombstone = aggregate.bindingTombstones.find(
          ({ bindingId }) => bindingId === marker.bindingId,
        );
        if (
          tombstone?.parentSessionId === marker.parentSessionId &&
          tombstone.sessionId === marker.sessionId
        ) {
          return { value: undefined };
        }
        throw new SubsessionCoordinatorStoreError("binding_not_found");
      }
      if (
        binding.parentSessionId !== marker.parentSessionId ||
        binding.sessionId !== marker.sessionId
      ) {
        throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
      }
      if (binding.sessionState === "closed") return { value: undefined };
      const now = this.now();
      binding.sessionState = "closed";
      binding.lifecycleEpoch += 1;
      binding.spawnClaim = null;
      binding.runtime = null;
      binding.updatedAt = now;
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: undefined, next: aggregate };
    });
  }

  refreshFocusedContext(
    identity: ProjectAgentSession,
    rawRequest: unknown,
  ): Promise<FocusedContextRefreshResult> {
    const request = parseProjectSubsessionRequest(rawRequest, identity.projectId);
    if (request.operation.kind !== "refresh-focused-context")
      throw new SubsessionCoordinatorStoreError("malformed_state");
    const operation = request.operation;
    const targetSelector = operation.target;
    const requestDigest = computeCanonicalDelegationRequestDigest(request);
    return this.transact<FocusedContextRefreshResult>(identity.projectId, async (aggregate) => {
      const sameRequest = (
        receipt: Pick<SubsessionCoordinatorRequestReceipt, "parentSessionId" | "requestKey">,
      ) =>
        receipt.parentSessionId === identity.sessionId &&
        receipt.requestKey === request.requestKey;
      const previous = aggregate.requestReceipts.find(sameRequest);
      if (previous) {
        if (
          previous.requestDigest !== requestDigest ||
          previous.operation !== "refresh-focused-context" ||
          previous.bindingIds.length !== 1
        ) {
          throw new SubsessionCoordinatorStoreError("request_key_reused");
        }
        const binding = aggregate.bindings.find(
          ({ bindingId }) => bindingId === previous.bindingIds[0],
        );
        if (!binding && aggregate.bindingTombstones.some(
          ({ bindingId }) => bindingId === previous.bindingIds[0],
        )) {
          throw new SubsessionCoordinatorStoreError("session_closed");
        }
        if (!binding)
          throw new SubsessionCoordinatorStoreError("malformed_state");
        return { value: { replayed: true, requestDigest, binding } };
      }
      if (aggregate.requestTombstones.some(sameRequest))
        throw new SubsessionCoordinatorStoreError("request_key_expired");
      const target =
        targetSelector.kind === "self"
          ? aggregate.bindings.find(
              ({ sessionId }) => sessionId === identity.sessionId,
            )
          : aggregate.bindings.find(
              ({ parentSessionId, delegationKey }) =>
                parentSessionId === identity.sessionId &&
                delegationKey === targetSelector.delegationKey,
            );
      if (!target)
        throw new SubsessionCoordinatorStoreError("binding_not_found");
      if (
        target.contextEpoch !== operation.expectedContextEpoch ||
        target.contextDigest !== operation.expectedContextDigest
      ) {
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      }
      const currentDelivery = target.deliveries.find(
        ({ contextEpoch }) => contextEpoch === target.contextEpoch,
      );
      if (currentDelivery?.state === "uncertain")
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      target.deliveries = target.deliveries.filter(({ state }) =>
        ["claimed", "submitted-unacknowledged", "uncertain"].includes(state),
      );
      if (target.deliveries.length >= SUBSESSION_COORDINATOR_DELIVERY_LIMIT)
        throw new SubsessionCoordinatorStoreError("history_quota_exceeded");

      const now = this.now();
      target.contextEpoch += 1;
      target.contextDigest = computeSubsessionContextDigest(
        operation.focus,
      );
      target.contextState =
        operation.focus === null ? "none" : "refreshing";
      target.currentFocus = operation.focus;
      target.projectionDigest = null;
      target.deliveries.push({
        contextEpoch: target.contextEpoch,
        deliveryId: `delivery_${this.id()}`,
        inputId: `input_${this.id()}`,
        eventWatermark: null,
        state: "pending",
        attempt: 0,
        claim: null,
        submittedAt: null,
        acknowledgedAt: null,
      });
      target.updatedAt = now;
      aggregate.requestReceipts.push({
        parentSessionId: identity.sessionId,
        requestKey: request.requestKey,
        requestDigest,
        operation: "refresh-focused-context",
        bindingIds: [target.bindingId],
        createdAt: now,
      });
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return {
        value: { replayed: false, requestDigest, binding: target },
        next: aggregate,
      };
    });
  }

  async reserveDelegations(
    identity: ProjectAgentSession,
    rawRequest: unknown,
    target: Readonly<{
      harness: HarnessKind;
      projectRoot: string;
      ownerId: string;
    }>,
  ): Promise<ReservedDelegations> {
    parseProjectAgentActorRef({
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
    const request = parseProjectSubsessionRequest(rawRequest, identity.projectId);
    if (request.operation.kind !== "delegate")
      throw new SubsessionCoordinatorStoreError("malformed_state");
    if (
      !["claude-code", "codex"].includes(target.harness) ||
      !path.isAbsolute(target.projectRoot) ||
      target.projectRoot.includes("\0") ||
      !identifier(target.ownerId)
    ) {
      throw new SubsessionCoordinatorStoreError("malformed_state");
    }
    const requestDigest = computeCanonicalDelegationRequestDigest(request);
    const operation = request.operation;
    return this.transact<ReservedDelegations>(identity.projectId, async (aggregate) => {
      const now = this.now();
      const activeCount = () =>
        aggregate.bindings.filter(({ sessionState }) =>
          [
            "reserved",
            "spawn-claimed",
            "starting",
            "awaiting-ready",
            "ready",
          ].includes(sessionState),
        ).length;
      const activateDormant = (binding: MutableBinding): void => {
        binding.spawnEpoch += 1;
        binding.lifecycleEpoch += 1;
        binding.spawnClaim = this.claim(now, target.ownerId) as MutableClaim;
        binding.sessionState = "spawn-claimed";
        binding.updatedAt = now;
      };
      const sameRequest = (
        receipt: Pick<SubsessionCoordinatorRequestReceipt, "parentSessionId" | "requestKey">,
      ): boolean =>
        receipt.parentSessionId === identity.sessionId &&
        receipt.requestKey === request.requestKey;
      const previous = aggregate.requestReceipts.find(sameRequest);
      if (previous) {
        if (
          previous.requestDigest !== requestDigest ||
          previous.operation !== "delegate"
        ) {
          throw new SubsessionCoordinatorStoreError("request_key_reused");
        }
        const bindings = previous.bindingIds.map((bindingId) => {
          const binding = aggregate.bindings.find(
            (entry) => entry.bindingId === bindingId,
          );
          if (!binding && aggregate.bindingTombstones.some(
            (entry) => entry.bindingId === bindingId,
          )) {
            throw new SubsessionCoordinatorStoreError("session_closed");
          }
          if (!binding)
            throw new SubsessionCoordinatorStoreError("malformed_state");
          return binding;
        });
        const dormant = bindings.filter(({ sessionState }) =>
          ["exited", "failed"].includes(sessionState),
        );
        if (
          activeCount() + dormant.length >
          (this.options.liveSessionLimit ??
            PROJECT_SUBSESSION_LIVE_SESSION_LIMIT)
        ) {
          throw new SubsessionCoordinatorStoreError(
            "live_session_limit_reached",
          );
        }
        for (const binding of dormant) activateDormant(binding);
        this.emit({
          name: "subsession.duplicate_prevented",
          projectId: identity.projectId,
          count: bindings.length,
        });
        if (dormant.length === 0)
          return { value: { replayed: true, requestDigest, bindings } };
        aggregate.recordVersion += 1;
        aggregate.updatedAt = now;
        return {
          value: { replayed: true, requestDigest, bindings },
          next: aggregate,
        };
      }
      if (aggregate.requestTombstones.some(sameRequest))
        throw new SubsessionCoordinatorStoreError("request_key_expired");
      this.compactTerminalHistory(aggregate);
      const bindings: SubsessionBindingRecord[] = [];
      let created = 0;
      const live = activeCount();
      const parentBinding = aggregate.bindings.find(
        ({ sessionId }) => sessionId === identity.sessionId,
      );
      const delegationDepth = (parentBinding?.delegationDepth ?? 0) + 1;
      if (
        delegationDepth >
        Math.min(
          this.options.maxDelegationDepth ?? PROJECT_SUBSESSION_MAX_DEPTH,
          PROJECT_SUBSESSION_MAX_DEPTH,
        )
      ) {
        throw new SubsessionCoordinatorStoreError("delegation_depth_exceeded");
      }
      let additionalLive = 0;
      for (const delegation of operation.delegations) {
        const bindingDigest =
          computeCanonicalDelegationBindingDigest(delegation);
        const existing = aggregate.bindings.find(
          (entry) =>
            entry.parentSessionId === identity.sessionId &&
            entry.delegationKey === delegation.delegationKey,
        );
        if (existing) {
          if (existing.bindingDigest !== bindingDigest)
            throw new SubsessionCoordinatorStoreError(
              "delegation_key_reused",
            );
          if (existing.sessionState === "closed")
            throw new SubsessionCoordinatorStoreError("session_closed");
          if (["exited", "failed"].includes(existing.sessionState)) {
            additionalLive += 1;
            activateDormant(existing);
          }
          bindings.push(existing);
          continue;
        }
        const terminal = aggregate.bindingTombstones.find(
          (entry) =>
            entry.parentSessionId === identity.sessionId &&
            entry.delegationKey === delegation.delegationKey &&
            entry.disposition === "terminal",
        );
        if (terminal) {
          if (terminal.bindingDigest !== bindingDigest)
            throw new SubsessionCoordinatorStoreError("delegation_key_reused");
          throw new SubsessionCoordinatorStoreError("session_closed");
        }
        if (aggregate.bindings.length >= this.bindingLimit()) {
          throw new SubsessionCoordinatorStoreError("history_quota_exceeded");
        }
        additionalLive += 1;
        const contextFocus = delegation.focus ?? null;
        const contextEpoch = 1;
        const binding: SubsessionBindingRecord = {
          bindingId: `binding_${this.id()}` as SubsessionBindingId,
          projectId: identity.projectId,
          parentSessionId: identity.sessionId,
          parentBindingId: parentBinding?.bindingId ?? null,
          delegationDepth,
          delegationKey: delegation.delegationKey,
          bindingDigest,
          outcome: delegation.outcome,
          kickoffContext: delegation.kickoffContext ?? null,
          initialFocus: contextFocus,
          sessionId: (this.options.generateSessionId ?? randomUUID)(),
          harness: target.harness,
          projectRoot: target.projectRoot,
          lifecycleEpoch: 1,
          spawnEpoch: 0,
          contextEpoch,
          contextDigest: computeSubsessionContextDigest(contextFocus),
          contextState: contextFocus === null ? "none" : "current",
          currentFocus: contextFocus,
          projectionDigest: null,
          sessionState: "reserved",
          spawnClaim: null,
          runtime: null,
          deliveries: [
            {
              contextEpoch,
              deliveryId: `delivery_${this.id()}`,
              inputId: `input_${this.id()}`,
              eventWatermark: null,
              state: "pending",
              attempt: 0,
              claim: null,
              submittedAt: null,
              acknowledgedAt: null,
            },
          ],
          lastError: null,
          createdAt: now,
          updatedAt: now,
        };
        aggregate.bindings.push(binding as unknown as MutableBinding);
        bindings.push(binding);
        created += 1;
      }
      if (
        live + additionalLive >
        (this.options.liveSessionLimit ?? PROJECT_SUBSESSION_LIVE_SESSION_LIMIT)
      ) {
        throw new SubsessionCoordinatorStoreError("live_session_limit_reached");
      }
      const receipt: SubsessionCoordinatorRequestReceipt = {
        parentSessionId: identity.sessionId,
        requestKey: request.requestKey,
        requestDigest,
        operation: "delegate",
        bindingIds: bindings.map(({ bindingId }) => bindingId),
        createdAt: now,
      };
      aggregate.requestReceipts.push(receipt);
      this.compactTerminalHistory(aggregate);
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      this.emit({
        name: "subsession.binding_reserved",
        projectId: identity.projectId,
        count: created,
      });
      return {
        value: { replayed: false, requestDigest, bindings },
        next: aggregate,
      };
    });
  }

  private scopedBinding(
    aggregate: MutableAggregate,
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
  ): MutableBinding {
    const binding = aggregate.bindings.find(
      (entry) => entry.bindingId === bindingId,
    );
    if (!binding)
      throw new SubsessionCoordinatorStoreError("binding_not_found");
    if (
      binding.projectId !== identity.projectId ||
      binding.parentSessionId !== identity.sessionId
    ) {
      throw new SubsessionCoordinatorStoreError("binding_scope_mismatch");
    }
    return binding;
  }

  private claim(now: string, ownerId: string): SubsessionClaim {
    return {
      claimId: `claim_${this.id()}`,
      ownerId,
      claimedAt: now,
      expiresAt: new Date(
        new Date(now).getTime() +
          (this.options.claimTtlMs ?? PROJECT_SUBSESSION_CLAIM_TTL_MS),
      ).toISOString(),
    };
  }

  claimSpawn(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      ownerId: string;
      expectedLifecycleEpoch: number;
      expectedSpawnEpoch: number;
    }>,
  ): Promise<SpawnClaimResult> {
    return this.transact<SpawnClaimResult>(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (binding.sessionState === "closed")
        throw new SubsessionCoordinatorStoreError("session_closed");
      if (binding.spawnClaim) {
        return {
          value: {
            claimed: false,
            reason:
              binding.spawnClaim.expiresAt <= this.now()
                ? "expired-requires-inspection"
                : "active",
            binding,
          },
        };
      }
      if (
        binding.lifecycleEpoch !== request.expectedLifecycleEpoch ||
        binding.spawnEpoch !== request.expectedSpawnEpoch ||
        !["reserved", "exited", "failed"].includes(binding.sessionState) ||
        binding.runtime !== null
      ) {
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      }
      const now = this.now();
      binding.spawnEpoch += 1;
      binding.lifecycleEpoch += 1;
      binding.spawnClaim = this.claim(now, request.ownerId) as MutableClaim;
      binding.sessionState = "spawn-claimed";
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      this.emit({
        name: "subsession.spawn_claimed",
        projectId: identity.projectId,
      });
      return {
        value: { claimed: true, binding },
        next: aggregate,
      };
    });
  }

  takeoverExpiredSpawnClaim(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      ownerId: string;
      expiredClaimId: string;
      expectedLifecycleEpoch: number;
      expectedSpawnEpoch: number;
    }>,
  ): Promise<SpawnClaimResult> {
    return this.transact<SpawnClaimResult>(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      const now = this.now();
      if (
        !binding.spawnClaim ||
        binding.spawnClaim.claimId !== request.expiredClaimId ||
        binding.spawnClaim.expiresAt > now ||
        binding.lifecycleEpoch !== request.expectedLifecycleEpoch ||
        binding.spawnEpoch !== request.expectedSpawnEpoch ||
        binding.sessionState !== "spawn-claimed" ||
        binding.runtime !== null
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      binding.spawnEpoch += 1;
      binding.lifecycleEpoch += 1;
      binding.spawnClaim = this.claim(now, request.ownerId) as MutableClaim;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return {
        value: { claimed: true, binding },
        next: aggregate,
      };
    });
  }

  releaseUnspawnedClaim(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      claimId: string;
      spawnEpoch: number;
      proof: "no-process-created";
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (
        binding.spawnClaim?.claimId !== request.claimId ||
        binding.spawnEpoch !== request.spawnEpoch ||
        binding.sessionState !== "spawn-claimed" ||
        binding.runtime !== null
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      const now = this.now();
      binding.spawnClaim = null;
      binding.sessionState = "reserved";
      binding.lifecycleEpoch += 1;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }

  attachSpawnedRuntime(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      claimId: string;
      spawnEpoch: number;
      runtimeToken: string;
      incarnation: number;
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (
        binding.spawnClaim?.claimId !== request.claimId ||
        binding.spawnEpoch !== request.spawnEpoch ||
        binding.sessionState !== "spawn-claimed" ||
        binding.runtime !== null ||
        !identifier(request.runtimeToken) ||
        !Number.isSafeInteger(request.incarnation) ||
        request.incarnation < 1
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      const now = this.now();
      binding.runtime = {
        runtimeToken: request.runtimeToken,
        incarnation: request.incarnation,
        spawnEpoch: request.spawnEpoch,
      };
      binding.spawnClaim = null;
      binding.sessionState = "starting";
      binding.lifecycleEpoch += 1;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }

  transitionSession(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      expectedLifecycleEpoch: number;
      expectedSpawnEpoch: number;
      expectedRuntimeToken: string | null;
      state: DelegatedSessionState;
      error?: DelegationError | null;
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      if (
        binding.lifecycleEpoch !== request.expectedLifecycleEpoch ||
        binding.spawnEpoch !== request.expectedSpawnEpoch ||
        (binding.runtime?.runtimeToken ?? null) !== request.expectedRuntimeToken ||
        !transitions[binding.sessionState].includes(request.state)
      ) {
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      }
      const now = this.now();
      binding.sessionState = request.state;
      binding.lifecycleEpoch += 1;
      if (["exited", "failed", "closed"].includes(request.state))
        binding.runtime = null;
      binding.lastError = request.error ?? null;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }

  claimKickoff(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      ownerId: string;
      expectedLifecycleEpoch: number;
      expectedSpawnEpoch: number;
      expectedContextEpoch: number;
      eventWatermark: string;
    }>,
  ): Promise<KickoffClaimResult> {
    return this.transact<KickoffClaimResult>(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      const delivery = binding.deliveries.find(
        (entry) => entry.contextEpoch === request.expectedContextEpoch,
      );
      if (!delivery)
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      if (
        binding.lifecycleEpoch !== request.expectedLifecycleEpoch ||
        binding.spawnEpoch !== request.expectedSpawnEpoch ||
        binding.contextEpoch !== request.expectedContextEpoch ||
        binding.sessionState !== "ready" ||
        !binding.runtime
      ) {
        throw new SubsessionCoordinatorStoreError("lifecycle_conflict");
      }
      if (delivery.state !== "pending") {
        const expired =
          delivery.state === "claimed" &&
          delivery.claim !== null &&
          delivery.claim.expiresAt <= this.now();
        return {
          value: {
            claimed: false,
            reason: expired
              ? "expired-requires-reconciliation"
              : delivery.state === "claimed"
                ? "already-claimed"
                : "terminal",
            binding,
          },
        };
      }
      const now = this.now();
      delivery.state = "claimed";
      delivery.attempt += 1;
      delivery.claim = this.claim(now, request.ownerId) as MutableClaim;
      delivery.eventWatermark = request.eventWatermark;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      this.emit({
        name: "subsession.kickoff_claimed",
        projectId: identity.projectId,
      });
      return {
        value: { claimed: true, binding },
        next: aggregate,
      };
    });
  }

  recordKickoffWrite(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      contextEpoch: number;
      deliveryId: string;
      inputId: string;
      claimId: string;
      phase: "not-written" | "text-staged" | "enter-written";
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      const delivery = binding.deliveries.find(
        (entry) => entry.contextEpoch === request.contextEpoch,
      );
      if (
        !delivery ||
        delivery.deliveryId !== request.deliveryId ||
        delivery.inputId !== request.inputId ||
        delivery.state !== "claimed" ||
        delivery.claim?.claimId !== request.claimId
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      const now = this.now();
      delivery.claim = null;
      if (request.phase === "not-written") {
        delivery.state = "pending";
        delivery.eventWatermark = null;
      } else if (request.phase === "enter-written") {
        delivery.state = "submitted-unacknowledged";
        delivery.submittedAt = now;
      } else {
        delivery.state = "uncertain";
      }
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      if (request.phase === "text-staged")
        this.emit({
          name: "subsession.kickoff_uncertain",
          projectId: identity.projectId,
        });
      return { value: binding, next: aggregate };
    });
  }

  markKickoffUncertain(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      contextEpoch: number;
      deliveryId: string;
      inputId: string;
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      const delivery = binding.deliveries.find(
        (entry) => entry.contextEpoch === request.contextEpoch,
      );
      if (
        !delivery ||
        delivery.deliveryId !== request.deliveryId ||
        delivery.inputId !== request.inputId ||
        !["claimed", "submitted-unacknowledged", "uncertain"].includes(
          delivery.state,
        )
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      if (delivery.state === "uncertain") return { value: binding };
      const now = this.now();
      delivery.state = "uncertain";
      delivery.claim = null;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      this.emit({
        name: "subsession.kickoff_uncertain",
        projectId: identity.projectId,
      });
      return { value: binding, next: aggregate };
    });
  }

  acknowledgeKickoff(
    identity: ProjectAgentSession,
    bindingId: SubsessionBindingId,
    request: Readonly<{
      contextEpoch: number;
      deliveryId: string;
      inputId: string;
      eventWatermark: string;
    }>,
  ): Promise<SubsessionBindingRecord> {
    return this.transact(identity.projectId, async (aggregate) => {
      const binding = this.scopedBinding(aggregate, identity, bindingId);
      const delivery = binding.deliveries.find(
        (entry) => entry.contextEpoch === request.contextEpoch,
      );
      if (
        !delivery ||
        delivery.deliveryId !== request.deliveryId ||
        delivery.inputId !== request.inputId ||
        delivery.eventWatermark !== request.eventWatermark ||
        ![
          "claimed",
          "submitted-unacknowledged",
          "uncertain",
          "acknowledged",
        ].includes(delivery.state)
      ) {
        throw new SubsessionCoordinatorStoreError("claim_conflict");
      }
      if (delivery.state === "acknowledged") return { value: binding };
      const now = this.now();
      delivery.state = "acknowledged";
      delivery.claim = null;
      delivery.acknowledgedAt = now;
      binding.updatedAt = now;
      aggregate.recordVersion += 1;
      aggregate.updatedAt = now;
      return { value: binding, next: aggregate };
    });
  }
}
