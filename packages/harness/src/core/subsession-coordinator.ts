import { randomUUID } from "node:crypto";

import type {
  ProjectAgentSession,
  StudioProjectId,
} from "../shared/agent-map.js";
import { canonicalDigest } from "../shared/agent-map-canonical.js";
import {
  agentMapVersionRefsEqual,
  projectBuildPlanVersionRefsEqual,
  type AgentBriefVersion,
} from "../shared/build-plan.js";
import {
  parseProjectSubsessionRequest,
  SubsessionDelegationValidationError,
} from "../shared/subsession-delegation-codec.js";
import type {
  DelegationError,
  DelegationFocusRef,
  DelegationItemOutcome,
  DelegationItemResult,
  ProjectSubsessionRequest,
  ProjectSubsessionResult,
  SubsessionBindingRecord,
  SubsessionProjectionDigest,
} from "../shared/subsession-delegation.js";
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import type { BuildPlanStore } from "./build-plan-store.js";
import type { EventReader } from "./collector/store.js";
import {
  serializeFocusedSessionContext,
  type FocusedSessionContextProjection,
} from "./focused-session-context.js";
import {
  SessionNotReadyError,
  SubsessionBindingMismatchError,
  SubsessionFreshRestartForbiddenError,
} from "./errors.js";
import type {
  SessionManager,
  TrustedSubsessionBindingMarker,
} from "./session-manager.js";
import {
  SubsessionCoordinatorStore,
  SubsessionCoordinatorStoreError,
  type ReservedReleases,
} from "./subsession-coordinator-store.js";

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const ADAPTER_IDENTITY_POLL_MS = 25;
const KICKOFF_MARKER = /<sapiom-project-delegation\s+binding="([A-Za-z0-9._-]+)"\s+delivery="([A-Za-z0-9._-]+)"\s+input="([A-Za-z0-9._-]+)"\s+context="([1-9][0-9]*)"\s+spawn="([1-9][0-9]*)"\s*\/>/u;

export interface SubsessionCoordinatorEvent {
  name:
    | "subsession.requested"
    | "subsession.created"
    | "subsession.reused"
    | "subsession.released"
    | "subsession.ready"
    | "subsession.failed"
    | "subsession.kickoff_submitted"
    | "subsession.kickoff_acknowledged"
    | "subsession.kickoff_uncertain"
    | "subsession.context_stale"
    | "subsession.manual_session_protected";
  projectId: StudioProjectId;
  sessionId?: string;
  code?: DelegationError["code"];
}

export class SubsessionCoordinatorError extends Error {
  constructor(readonly detail: DelegationError) {
    super(detail.code);
    this.name = "SubsessionCoordinatorError";
  }
}

export interface SubsessionCoordinatorOptions {
  store: SubsessionCoordinatorStore;
  sessionManager: SessionManager;
  planningStore: BuildPlanStore;
  eventReader: EventReader;
  ownerId?: string;
  readinessTimeoutMs?: number;
  onEvent?: (event: SubsessionCoordinatorEvent) => void | Promise<void>;
}

type ResolvedFocus = Readonly<{
  state: "none" | "current" | "stale";
  projection: FocusedSessionContextProjection | null;
  projectionDigest: SubsessionProjectionDigest | null;
}>;

type DelegateRequest = Omit<ProjectSubsessionRequest, "operation"> &
  Readonly<{
    operation: Extract<
      ProjectSubsessionRequest["operation"],
      { kind: "delegate" }
    >;
  }>;
type RefreshRequest = Omit<ProjectSubsessionRequest, "operation"> &
  Readonly<{
    operation: Extract<
      ProjectSubsessionRequest["operation"],
      { kind: "refresh-focused-context" }
    >;
  }>;
type ReleaseRequest = Omit<ProjectSubsessionRequest, "operation"> &
  Readonly<{
    operation: Extract<
      ProjectSubsessionRequest["operation"],
      { kind: "release" }
    >;
  }>;
type DormantReleaseRequest = Omit<ProjectSubsessionRequest, "operation"> &
  Readonly<{
    operation: Extract<
      ProjectSubsessionRequest["operation"],
      { kind: "release-dormant" }
    >;
  }>;

const error = (
  code: DelegationError["code"],
  retryable: boolean,
  recovery: DelegationError["recovery"],
  issues?: DelegationError["issues"],
): DelegationError => ({
  code,
  retryable,
  recovery,
  ...(issues === undefined ? {} : { issues }),
});

const currentDelivery = (binding: SubsessionBindingRecord) =>
  binding.deliveries.find(
    ({ contextEpoch }) => contextEpoch === binding.contextEpoch,
  ) ?? binding.deliveries.at(-1)!;

const bindingIdentity = (
  caller: ProjectAgentSession,
  binding: SubsessionBindingRecord,
): ProjectAgentSession => ({
  projectId: binding.projectId,
  userId: caller.userId,
  sessionId: binding.parentSessionId,
});

const markerFor = (
  binding: SubsessionBindingRecord,
  incarnation: number,
): TrustedSubsessionBindingMarker => ({
  projectId: binding.projectId,
  parentSessionId: binding.parentSessionId,
  bindingId: binding.bindingId,
  sessionId: binding.sessionId,
  incarnation,
  spawnEpoch: binding.spawnEpoch,
});

const refsMatchBrief = (
  brief: AgentBriefVersion,
  focus: Extract<DelegationFocusRef, { kind: "brief" }>,
) =>
  brief.projectId === focus.brief.projectId &&
  brief.briefId === focus.brief.briefId &&
  brief.versionId === focus.brief.versionId &&
  brief.semanticDigest === focus.brief.semanticDigest;

export class SubsessionCoordinator {
  private readonly ownerId: string;
  private readonly readinessTimeoutMs: number;

  constructor(private readonly options: SubsessionCoordinatorOptions) {
    this.ownerId = options.ownerId ?? `coordinator_${randomUUID()}`;
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  }

  private emit(event: SubsessionCoordinatorEvent): void {
    try {
      void Promise.resolve(this.options.onEvent?.(event)).catch(() => {});
    } catch {
      // Content-free telemetry cannot change delegation behavior.
    }
  }

  async execute(
    identity: ProjectAgentSession,
    rawRequest: unknown,
  ): Promise<ProjectSubsessionResult> {
    let request: ProjectSubsessionRequest;
    try {
      request = parseProjectSubsessionRequest(rawRequest, identity.projectId);
    } catch (cause) {
      if (cause instanceof SubsessionDelegationValidationError) {
        throw new SubsessionCoordinatorError(
          error(
            cause.code,
            false,
            cause.code === "capacity_exceeded" ? "reduce_request" : "correct",
            cause.issues,
          ),
        );
      }
      throw new SubsessionCoordinatorError(
        error("invalid_request", false, "correct"),
      );
    }
    this.assertCaller(identity);
    this.emit({ name: "subsession.requested", projectId: identity.projectId });
    if (request.operation.kind === "refresh-focused-context")
      return this.refresh(identity, request as RefreshRequest);
    if (request.operation.kind === "release")
      return this.release(identity, request as ReleaseRequest);
    if (request.operation.kind === "release-dormant")
      return this.releaseDormant(identity, request as DormantReleaseRequest);
    return this.delegate(identity, request as DelegateRequest);
  }

  private assertCaller(identity: ProjectAgentSession): HarnessSession {
    const caller = this.options.sessionManager.get(identity.sessionId);
    if (
      !caller?.agentMapIdentity ||
      caller.agentMapIdentity.projectId !== identity.projectId ||
      caller.agentMapIdentity.userId !== identity.userId ||
      caller.agentMapIdentity.sessionId !== identity.sessionId
    ) {
      throw new SubsessionCoordinatorError(
        error("capability_scope_mismatch", false, "none"),
      );
    }
    return caller;
  }

  private async delegate(
    identity: ProjectAgentSession,
    request: DelegateRequest,
  ): Promise<ProjectSubsessionResult> {
    const caller = this.assertCaller(identity);
    let reserved;
    try {
      reserved = await this.options.store.reserveDelegations(identity, request, {
        harness: caller.harness,
        projectRoot: caller.cwd,
        ownerId: this.ownerId,
      });
    } catch (cause) {
      throw this.wholeCallError(cause);
    }
    const results: DelegationItemResult[] = [];
    for (const binding of reserved.bindings) {
      results.push(await this.reconcileBinding(identity, binding, reserved.replayed));
    }
    return {
      schemaVersion: 1,
      requestKey: request.requestKey,
      requestDigest: reserved.requestDigest,
      replayed: reserved.replayed,
      results: results.sort((left, right) =>
        left.delegationKey.localeCompare(right.delegationKey),
      ),
    };
  }

  private async refresh(
    identity: ProjectAgentSession,
    request: RefreshRequest,
  ): Promise<ProjectSubsessionResult> {
    let refreshed;
    try {
      refreshed = await this.options.store.refreshFocusedContext(identity, request);
    } catch (cause) {
      throw this.wholeCallError(cause, true);
    }
    const result = await this.reconcileBinding(
      identity,
      refreshed.binding,
      refreshed.replayed,
    );
    return {
      schemaVersion: 1,
      requestKey: request.requestKey,
      requestDigest: refreshed.requestDigest,
      replayed: refreshed.replayed,
      results: [result],
    };
  }

  private async release(
    identity: ProjectAgentSession,
    request: ReleaseRequest,
  ): Promise<ProjectSubsessionResult> {
    let reserved;
    try {
      reserved = await this.options.store.reserveReleases(identity, request);
    } catch (cause) {
      throw this.wholeCallError(cause);
    }
    return this.releaseReserved(identity, request.requestKey, reserved);
  }

  private async releaseDormant(
    identity: ProjectAgentSession,
    request: DormantReleaseRequest,
  ): Promise<ProjectSubsessionResult> {
    let reserved;
    try {
      const aggregate = await this.options.store.read(identity.projectId);
      const candidateBindingIds = aggregate.bindings
        .filter(({ sessionState }) =>
          ["exited", "failed"].includes(sessionState),
        )
        .filter(({ parentSessionId }) => {
          const parent = this.options.sessionManager.get(parentSessionId);
          return !parent || parent.status === "exited";
        })
        .sort((left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.bindingId.localeCompare(right.bindingId),
        )
        .slice(0, request.operation.limit)
        .map(({ bindingId }) => bindingId);
      reserved = await this.options.store.reserveDormantReleases(
        identity,
        request,
        candidateBindingIds,
      );
    } catch (cause) {
      throw this.wholeCallError(cause);
    }
    return this.releaseReserved(identity, request.requestKey, reserved);
  }

  private async releaseReserved(
    identity: ProjectAgentSession,
    requestKey: string,
    reserved: ReservedReleases,
  ): Promise<ProjectSubsessionResult> {
    const results: DelegationItemResult[] = [];
    for (const target of reserved.bindings) {
      if (target.state === "absent") {
        results.push({
          delegationKey: target.delegationKey,
          bindingId: null,
          sessionId: null,
          outcome: "released",
          sessionState: "closed",
          contextState: "none",
          kickoffState: "pending",
        });
        continue;
      }
      if (target.state === "released") {
        const binding = target.binding;
        try {
          const privateMarker =
            this.options.sessionManager.getSubsessionBinding(binding.sessionId);
          if (privateMarker) {
            if (
              privateMarker.projectId !== identity.projectId ||
              privateMarker.parentSessionId !== binding.parentSessionId ||
              privateMarker.bindingId !== binding.bindingId ||
              privateMarker.sessionId !== binding.sessionId
            ) {
              throw error(
                "binding_session_mismatch",
                false,
                "inspect_session",
              );
            }
            await this.options.sessionManager.closeBound(privateMarker);
          }
          results.push(this.releasedResult(binding));
        } catch (cause) {
          const detail = this.itemError(cause);
          this.emit({
            name:
              detail.code === "binding_session_mismatch"
                ? "subsession.manual_session_protected"
                : "subsession.failed",
            projectId: identity.projectId,
            sessionId: binding.sessionId,
            code: detail.code,
          });
          results.push({
            ...this.releasedResult(binding),
            outcome: "failed",
            error: detail,
          });
        }
        continue;
      }
      const binding = target.binding;
      const scopedIdentity = bindingIdentity(identity, binding);
      try {
        const privateMarker = this.options.sessionManager.getSubsessionBinding(
          binding.sessionId,
        );
        const session = this.options.sessionManager.get(binding.sessionId);
        if (privateMarker) {
          const expected = markerFor(
            binding,
            binding.runtime?.incarnation ?? privateMarker.incarnation,
          );
          if (!this.options.sessionManager.matchesSubsessionBinding(expected))
            throw error(
              "binding_session_mismatch",
              false,
              "inspect_session",
            );
          await this.options.sessionManager.closeBound(expected);
        } else if (binding.sessionState === "closed") {
          // The durable coordinator close won before private marker cleanup.
        } else if (
          session ||
          binding.runtime !== null ||
          !["reserved", "spawn-claimed"].includes(binding.sessionState)
        ) {
          throw error(
            "binding_session_mismatch",
            false,
            "inspect_session",
          );
        }
        await this.options.store.closeBinding(
          scopedIdentity,
          binding.bindingId,
          binding.sessionId,
        );
        const closed = await this.options.store.finalizeReleasedBinding(
          scopedIdentity,
          binding.bindingId,
          binding.sessionId,
        );
        this.emit({
          name: "subsession.released",
          projectId: binding.projectId,
          sessionId: binding.sessionId,
        });
        results.push(this.releasedResult(closed));
      } catch (cause) {
        const detail = this.itemError(cause);
        this.emit({
          name:
            detail.code === "binding_session_mismatch"
              ? "subsession.manual_session_protected"
              : "subsession.failed",
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          code: detail.code,
        });
        results.push(this.failedResult(binding, detail));
      }
    }
    return {
      schemaVersion: 1,
      requestKey,
      requestDigest: reserved.requestDigest,
      replayed: reserved.replayed,
      results: results.sort((left, right) =>
        left.delegationKey.localeCompare(right.delegationKey),
      ),
    };
  }

  private async reconcileBinding(
    caller: ProjectAgentSession,
    initial: SubsessionBindingRecord,
    replayed: boolean,
  ): Promise<DelegationItemResult> {
    const identity = bindingIdentity(caller, initial);
    let binding = initial;
    try {
      binding = await this.reconcileHistoricalDelivery(identity, binding);
      const focused = await this.resolveFocus(binding);
      binding = await this.options.store.setFocusedContextState(
        identity,
        binding.bindingId,
        {
          expectedContextEpoch: binding.contextEpoch,
          expectedContextDigest: binding.contextDigest,
          state: focused.state,
          projectionDigest: focused.projectionDigest,
        },
      );
      if (focused.state === "stale") {
        this.emit({
          name: "subsession.context_stale",
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          code: "context_stale",
        });
        return this.failedResult(
          binding,
          error("context_stale", false, "refresh_context"),
        );
      }
      const ensured = await this.ensureSession(caller, binding, focused.projection);
      binding = ensured.binding;
      if (binding.sessionState !== "ready")
        return this.result(binding, "already-running");
      binding = await this.deliver(identity, binding, focused.projection);
      const outcome: DelegationItemOutcome = ensured.created
        ? "created"
        : replayed || ensured.reused
          ? "reused"
          : "already-running";
      this.emit({
        name: ensured.created ? "subsession.created" : "subsession.reused",
        projectId: binding.projectId,
        sessionId: binding.sessionId,
      });
      return this.result(binding, outcome);
    } catch (cause) {
      binding =
        (await this.options.store
          .readBinding(identity, {
            kind: "binding-id",
            bindingId: binding.bindingId,
          })
          .catch(() => null)) ?? binding;
      const detail = this.itemError(cause);
      this.emit({
        name:
          detail.code === "binding_session_mismatch"
            ? "subsession.manual_session_protected"
            : "subsession.failed",
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        code: detail.code,
      });
      return this.failedResult(binding, detail);
    }
  }

  private async resolveFocus(
    binding: SubsessionBindingRecord,
  ): Promise<ResolvedFocus> {
    const focus = binding.currentFocus;
    if (!focus)
      return { state: "none", projection: null, projectionDigest: null };
    const aggregate = await this.options.planningStore.read(binding.projectId);
    const mapRef = focus.kind === "brief" ? null : focus.map;
    const map = aggregate.mapVersions.find(
      ({ versionId }) => versionId === (mapRef?.versionId ?? ""),
    );
    if (focus.kind === "brief") {
      const brief = Object.values(aggregate.briefVersionsById)
        .flat()
        .find((candidate) => refsMatchBrief(candidate, focus));
      if (!brief) throw error("context_not_found", false, "reread");
      const exactMap = aggregate.mapVersions.find(
        ({ versionId }) => versionId === brief.map.versionId,
      );
      const exactPlan = aggregate.buildPlanVersions.find(
        ({ versionId }) => versionId === brief.plan.versionId,
      );
      if (!exactMap || !exactPlan)
        throw error("context_not_found", false, "reread");
      const pointer = Object.values(aggregate.current.briefsByScope).find(
        ({ briefId }) => briefId === brief.briefId,
      );
      const stale =
        !aggregate.current.map ||
        !aggregate.current.buildPlan ||
        !agentMapVersionRefsEqual(aggregate.current.map, brief.map) ||
        !projectBuildPlanVersionRefsEqual(
          aggregate.current.buildPlan,
          brief.plan,
        ) ||
        !pointer ||
        pointer.status !== "active" ||
        pointer.version.versionId !== brief.versionId ||
        pointer.version.semanticDigest !== brief.semanticDigest;
      if (stale)
        return { state: "stale", projection: null, projectionDigest: null };
      const projection = serializeFocusedSessionContext({
        map: exactMap,
        plan: exactPlan,
        brief,
      });
      if (!projection.ok)
        throw error("context_not_found", false, "reread");
      return {
        state: "current",
        projection: projection.projection,
        projectionDigest: canonicalDigest(
          "sapiom.subsession.focused-projection.v1",
          projection.projection,
        ) as SubsessionProjectionDigest,
      };
    }
    if (
      !map ||
      !agentMapVersionRefsEqual(
        {
          projectId: map.projectId,
          versionId: map.versionId,
          contentDigest: map.contentDigest,
        },
        focus.map,
      )
    ) {
      throw error("context_not_found", false, "reread");
    }
    const currentMap = aggregate.current.map;
    let stale = !currentMap || !agentMapVersionRefsEqual(currentMap, focus.map);
    if (focus.kind === "assignment") {
      const plan = aggregate.buildPlanVersions.find(
        ({ versionId }) => versionId === focus.plan.versionId,
      );
      if (
        !plan ||
        !projectBuildPlanVersionRefsEqual(
          {
            projectId: plan.projectId,
            planId: plan.planId,
            versionId: plan.versionId,
            semanticDigest: plan.semanticDigest,
          },
          focus.plan,
        ) ||
        !plan.content.assignments.some(({ id }) => id === focus.assignmentId)
      ) {
        throw error("context_not_found", false, "reread");
      }
      stale =
        stale ||
        !aggregate.current.buildPlan ||
        !projectBuildPlanVersionRefsEqual(
          aggregate.current.buildPlan,
          focus.plan,
        );
    } else {
      if (!map.graph.nodes.some(({ id }) => id === focus.nodeId))
        throw error("context_not_found", false, "reread");
      if (focus.plan) {
        const plan = aggregate.buildPlanVersions.find(
          ({ versionId }) => versionId === focus.plan!.versionId,
        );
        if (
          !plan ||
          !projectBuildPlanVersionRefsEqual(
            {
              projectId: plan.projectId,
              planId: plan.planId,
              versionId: plan.versionId,
              semanticDigest: plan.semanticDigest,
            },
            focus.plan,
          )
        ) {
          throw error("context_not_found", false, "reread");
        }
        stale =
          stale ||
          !aggregate.current.buildPlan ||
          !projectBuildPlanVersionRefsEqual(
            aggregate.current.buildPlan,
            focus.plan,
          );
      }
    }
    return {
      state: stale ? "stale" : "current",
      projection: null,
      projectionDigest: null,
    };
  }

  private async ensureSession(
    caller: ProjectAgentSession,
    initial: SubsessionBindingRecord,
    projection: FocusedSessionContextProjection | null,
  ): Promise<{
    binding: SubsessionBindingRecord;
    created: boolean;
    reused: boolean;
  }> {
    const identity = bindingIdentity(caller, initial);
    let binding = await this.options.store.readBinding(identity, {
      kind: "binding-id",
      bindingId: initial.bindingId,
    });
    const existing = this.options.sessionManager.get(binding.sessionId);
    const privateMarker =
      this.options.sessionManager.getSubsessionBinding(binding.sessionId);
    if (existing || privateMarker) {
      const incarnation = binding.runtime?.incarnation ?? privateMarker?.incarnation ?? 1;
      const expected = markerFor(binding, incarnation);
      if (
        !privateMarker ||
        !this.options.sessionManager.matchesSubsessionBinding(expected)
      ) {
        throw new SubsessionBindingMismatchError();
      }
      if (!existing) {
        if (
          !binding.spawnClaim ||
          binding.spawnClaim.expiresAt > new Date().toISOString()
        ) {
          return { binding, created: false, reused: true };
        }
        const session = await this.options.sessionManager.createReserved(
          binding.sessionId,
          { cwd: binding.projectRoot, harness: binding.harness },
          expected,
          {
            agentMapIdentity: (sessionId) => ({
              projectId: binding.projectId,
              userId: caller.userId,
              sessionId,
            }),
            initialTitle: this.title(binding.outcome),
            ...(projection ? { focusedContext: () => projection } : {}),
          },
        );
        const runtimeToken = this.options.sessionManager.getRuntimeEpoch(
          session.id,
        );
        if (!runtimeToken)
          throw error("session_create_failed", true, "retry");
        binding = await this.options.store.attachSpawnedRuntime(
          identity,
          binding.bindingId,
          {
            claimId: binding.spawnClaim.claimId,
            spawnEpoch: binding.spawnEpoch,
            runtimeToken,
            incarnation: expected.incarnation,
          },
        );
        binding = await this.advanceToReady(identity, binding, runtimeToken);
        return { binding, created: false, reused: true };
      }
      if (this.options.sessionManager.wasSubsessionClosedByUser(expected)) {
        await this.options.store.closeBinding(
          identity,
          binding.bindingId,
          binding.sessionId,
        );
        throw error("session_closed", false, "inspect_session");
      }
      if (this.options.sessionManager.isLive(binding.sessionId)) {
        const runtimeToken =
          this.options.sessionManager.getRuntimeEpoch(binding.sessionId)!;
        if (binding.runtime?.runtimeToken === runtimeToken) {
          binding = await this.advanceToReady(identity, binding, runtimeToken);
          return { binding, created: false, reused: true };
        }
        if (binding.spawnClaim) {
          if (binding.spawnClaim.expiresAt > new Date().toISOString())
            return { binding, created: false, reused: true };
          binding = await this.options.store.attachSpawnedRuntime(
            identity,
            binding.bindingId,
            {
              claimId: binding.spawnClaim.claimId,
              spawnEpoch: binding.spawnEpoch,
              runtimeToken,
              incarnation: privateMarker.incarnation,
            },
          );
          binding = await this.advanceToReady(identity, binding, runtimeToken);
          return { binding, created: false, reused: true };
        }
        throw error("binding_session_mismatch", false, "inspect_session");
      }
      if (existing.status === "exited") {
        binding = await this.recoverExitedSession(
          caller,
          identity,
          binding,
          privateMarker,
          projection,
        );
        return { binding, created: false, reused: true };
      }
      throw error("session_unreachable", true, "inspect_session");
    }

    let claim =
      binding.sessionState === "spawn-claimed" &&
      binding.spawnClaim?.ownerId === this.ownerId &&
      binding.spawnClaim.expiresAt > new Date().toISOString()
        ? { claimed: true as const, binding }
        : await this.options.store.claimSpawn(
            identity,
            binding.bindingId,
            {
              ownerId: this.ownerId,
              expectedLifecycleEpoch: binding.lifecycleEpoch,
              expectedSpawnEpoch: binding.spawnEpoch,
            },
          );
    if (!claim.claimed) {
      if (claim.reason !== "expired-requires-inspection")
        return { binding: claim.binding, created: false, reused: true };
      const expired = claim.binding.spawnClaim;
      if (!expired)
        throw error("session_unreachable", true, "inspect_session");
      claim = await this.options.store.takeoverExpiredSpawnClaim(
        identity,
        claim.binding.bindingId,
        {
          ownerId: this.ownerId,
          expiredClaimId: expired.claimId,
          expectedLifecycleEpoch: claim.binding.lifecycleEpoch,
          expectedSpawnEpoch: claim.binding.spawnEpoch,
        },
      );
      if (!claim.claimed)
        return { binding: claim.binding, created: false, reused: true };
    }
    binding = claim.binding;
    const spawnClaim = binding.spawnClaim!;
    const marker = markerFor(binding, 1);
    let session: HarnessSession;
    try {
      session = await this.options.sessionManager.createReserved(
        binding.sessionId,
        { cwd: binding.projectRoot, harness: binding.harness },
        marker,
        {
          agentMapIdentity: (sessionId) => ({
            projectId: binding.projectId,
            userId: caller.userId,
            sessionId,
          }),
          initialTitle: this.title(binding.outcome),
          ...(projection
            ? { focusedContext: () => projection }
            : {}),
        },
      );
    } catch (cause) {
      // A missing session row is positive proof that createWithId never
      // reached its first durable row/process side effect. Every later failure
      // keeps the claim fenced for exact inspection instead of guessing.
      if (!this.options.sessionManager.get(binding.sessionId)) {
        await this.options.store
          .releaseUnspawnedClaim(identity, binding.bindingId, {
            claimId: spawnClaim.claimId,
            spawnEpoch: binding.spawnEpoch,
            proof: "no-process-created",
          })
          .catch(() => {});
      }
      throw cause;
    }
    const runtimeToken = this.options.sessionManager.getRuntimeEpoch(session.id);
    if (!runtimeToken)
      throw error("session_create_failed", true, "retry");
    binding = await this.options.store.attachSpawnedRuntime(
      identity,
      binding.bindingId,
      {
        claimId: spawnClaim.claimId,
        spawnEpoch: binding.spawnEpoch,
        runtimeToken,
        incarnation: marker.incarnation,
      },
    );
    binding = await this.advanceToReady(identity, binding, runtimeToken);
    return { binding, created: true, reused: false };
  }

  private async recoverExitedSession(
    caller: ProjectAgentSession,
    identity: ProjectAgentSession,
    initial: SubsessionBindingRecord,
    currentMarker: TrustedSubsessionBindingMarker,
    projection: FocusedSessionContextProjection | null,
  ): Promise<SubsessionBindingRecord> {
    let binding = initial;
    if (
      binding.runtime &&
      ["starting", "awaiting-ready", "ready"].includes(binding.sessionState)
    ) {
      binding = await this.options.store.transitionSession(
        identity,
        binding.bindingId,
        {
          expectedLifecycleEpoch: binding.lifecycleEpoch,
          expectedSpawnEpoch: binding.spawnEpoch,
          expectedRuntimeToken: binding.runtime.runtimeToken,
          state: "exited",
        },
      );
    }
    const resumable = await this.options.sessionManager.canResumeSession(
      binding.sessionId,
    );
    if (!resumable && currentDelivery(binding).state !== "pending") {
      throw error("session_unreachable", false, "inspect_session");
    }
    let claim;
    if (binding.sessionState === "spawn-claimed" && binding.spawnClaim) {
      if (
        binding.spawnClaim.ownerId === this.ownerId &&
        binding.spawnClaim.expiresAt > new Date().toISOString()
      ) {
        claim = { claimed: true as const, binding };
      } else {
        if (binding.spawnClaim.expiresAt > new Date().toISOString()) return binding;
        claim = await this.options.store.takeoverExpiredSpawnClaim(
          identity,
          binding.bindingId,
          {
            ownerId: this.ownerId,
            expiredClaimId: binding.spawnClaim.claimId,
            expectedLifecycleEpoch: binding.lifecycleEpoch,
            expectedSpawnEpoch: binding.spawnEpoch,
          },
        );
      }
    } else {
      claim = await this.options.store.claimSpawn(
        identity,
        binding.bindingId,
        {
          ownerId: this.ownerId,
          expectedLifecycleEpoch: binding.lifecycleEpoch,
          expectedSpawnEpoch: binding.spawnEpoch,
        },
      );
    }
    if (!claim.claimed) return claim.binding;
    binding = claim.binding;
    const spawnClaim = binding.spawnClaim!;
    const nextMarker = markerFor(binding, currentMarker.incarnation + 1);
    const trusted = projection ? { focusedContext: projection } : {};
    if (resumable) {
      await this.options.sessionManager.resumeBound(
        binding.sessionId,
        currentMarker,
        nextMarker,
        trusted,
      );
    } else {
      const index = await this.options.eventReader.index();
      const hasRecordedTurns = async () =>
        (index.bySession.get(binding.sessionId)?.turnCount ?? 0) > 0;
      await this.options.sessionManager.restartFreshBound(
        binding.sessionId,
        currentMarker,
        nextMarker,
        {
          agentMapIdentity: (sessionId) => ({
            projectId: binding.projectId,
            userId: caller.userId,
            sessionId,
          }),
          initialTitle: this.title(binding.outcome),
          ...(projection ? { focusedContext: () => projection } : {}),
        },
        hasRecordedTurns,
      );
    }
    const runtimeToken = this.options.sessionManager.getRuntimeEpoch(
      binding.sessionId,
    );
    if (!runtimeToken)
      throw error("session_restart_failed", true, "retry");
    binding = await this.options.store.attachSpawnedRuntime(
      identity,
      binding.bindingId,
      {
        claimId: spawnClaim.claimId,
        spawnEpoch: binding.spawnEpoch,
        runtimeToken,
        incarnation: nextMarker.incarnation,
      },
    );
    return this.advanceToReady(identity, binding, runtimeToken);
  }

  private async advanceToReady(
    identity: ProjectAgentSession,
    initial: SubsessionBindingRecord,
    runtimeToken: string,
  ): Promise<SubsessionBindingRecord> {
    let binding = initial;
    if (binding.sessionState === "starting") {
      binding = await this.options.store.transitionSession(
        identity,
        binding.bindingId,
        {
          expectedLifecycleEpoch: binding.lifecycleEpoch,
          expectedSpawnEpoch: binding.spawnEpoch,
          expectedRuntimeToken: runtimeToken,
          state: "awaiting-ready",
        },
      );
    }
    if (binding.sessionState === "awaiting-ready") {
      const ready = await this.waitForReady(binding.sessionId, runtimeToken);
      if (!ready) throw new SessionNotReadyError(binding.sessionId);
      await this.waitForAdapterIdentity(binding.sessionId, runtimeToken);
      binding = await this.options.store.transitionSession(
        identity,
        binding.bindingId,
        {
          expectedLifecycleEpoch: binding.lifecycleEpoch,
          expectedSpawnEpoch: binding.spawnEpoch,
          expectedRuntimeToken: runtimeToken,
          state: "ready",
        },
      );
    }
    if (binding.sessionState === "ready")
      this.emit({
        name: "subsession.ready",
        projectId: binding.projectId,
        sessionId: binding.sessionId,
      });
    return binding;
  }

  private async waitForAdapterIdentity(
    sessionId: string,
    runtimeToken: string,
  ): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (;;) {
      if (!this.options.sessionManager.isCurrentRuntimeEpoch(sessionId, runtimeToken))
        throw error("session_unreachable", true, "inspect_session");
      const state = this.options.sessionManager.getAdapterIdentityState(
        sessionId,
        runtimeToken,
      );
      if (state === "ready" || state === "not-required") return;
      if (state === "ambiguous")
        throw error("adapter_identity_ambiguous", false, "inspect_session");
      if (state === "unavailable")
        throw error("adapter_unavailable", true, "retry");
      if (Date.now() >= deadline)
        throw error("adapter_unavailable", true, "retry");
      await new Promise((resolve) => setTimeout(resolve, ADAPTER_IDENTITY_POLL_MS));
    }
  }

  private waitForReady(sessionId: string, runtimeToken: string): Promise<boolean> {
    if (
      this.options.sessionManager.get(sessionId)?.ready &&
      this.options.sessionManager.isCurrentRuntimeEpoch(sessionId, runtimeToken)
    ) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.options.sessionManager.onStatusChange(
        (session, context) => {
          if (session.id !== sessionId) return;
          if (context.runtimeEpoch !== runtimeToken || session.status === "exited")
            finish(false);
          else if (session.ready) finish(true);
        },
      );
      const timer = setTimeout(
        () => finish(false),
        this.readinessTimeoutMs,
      );
    });
  }

  private async deliver(
    identity: ProjectAgentSession,
    initial: SubsessionBindingRecord,
    projection: FocusedSessionContextProjection | null,
  ): Promise<SubsessionBindingRecord> {
    let binding = await this.reconcileHistoricalDelivery(identity, initial);
    let delivery = currentDelivery(binding);
    if (delivery.state !== "pending") return binding;
    const watermark = await this.latestEventId(binding.sessionId);
    const claimed = await this.options.store.claimKickoff(
      identity,
      binding.bindingId,
      {
        ownerId: this.ownerId,
        expectedLifecycleEpoch: binding.lifecycleEpoch,
        expectedSpawnEpoch: binding.spawnEpoch,
        expectedContextEpoch: binding.contextEpoch,
        eventWatermark: watermark,
      },
    );
    if (!claimed.claimed) {
      if (claimed.reason === "expired-requires-reconciliation")
        return this.options.store.markKickoffUncertain(
          identity,
          binding.bindingId,
          {
            contextEpoch: binding.contextEpoch,
            deliveryId: delivery.deliveryId,
            inputId: delivery.inputId,
          },
        );
      return claimed.binding;
    }
    binding = claimed.binding;
    delivery = currentDelivery(binding);
    const runtimeToken = binding.runtime?.runtimeToken;
    if (!runtimeToken)
      throw error("session_unreachable", true, "inspect_session");
    const prompt = this.kickoffPrompt(binding, delivery, projection);
    const tracked = await this.options.sessionManager.submitInputTracked(
      binding.sessionId,
      prompt,
      {
        background: true,
        canWrite: async () => {
          const current = await this.options.store.readBinding(identity, {
            kind: "binding-id",
            bindingId: binding.bindingId,
          });
          return (
            current.lifecycleEpoch === binding.lifecycleEpoch &&
            current.spawnEpoch === binding.spawnEpoch &&
            current.contextEpoch === binding.contextEpoch &&
            current.contextDigest === binding.contextDigest &&
            current.runtime?.runtimeToken === runtimeToken &&
            this.options.sessionManager.isCurrentRuntimeEpoch(
              binding.sessionId,
              runtimeToken,
            )
          );
        },
      },
    );
    const after = await this.options.store.readBinding(identity, {
      kind: "binding-id",
      bindingId: binding.bindingId,
    });
    if (currentDelivery(after).state === "acknowledged") return after;
    binding = await this.options.store.recordKickoffWrite(
      identity,
      binding.bindingId,
      {
        contextEpoch: binding.contextEpoch,
        deliveryId: delivery.deliveryId,
        inputId: delivery.inputId,
        claimId: delivery.claim!.claimId,
        phase: tracked.phase,
      },
    );
    const state = currentDelivery(binding).state;
    this.emit({
      name:
        state === "uncertain"
          ? "subsession.kickoff_uncertain"
          : "subsession.kickoff_submitted",
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    });
    return binding;
  }

  private kickoffPrompt(
    binding: SubsessionBindingRecord,
    delivery: ReturnType<typeof currentDelivery>,
    projection: FocusedSessionContextProjection | null,
  ): string {
    const marker = `<sapiom-project-delegation binding="${binding.bindingId}" delivery="${delivery.deliveryId}" input="${delivery.inputId}" context="${binding.contextEpoch}" spawn="${binding.spawnEpoch}" />`;
    if (binding.contextEpoch > 1) {
      return [
        "Focused project context refresh for your existing delegated task.",
        ...(projection
          ? [projection]
          : ["The optional focused overlay is now cleared or reference-only. Read current shared project state through the common tools when needed."]),
        "This context update does not change your tools, writable policy, or authority.",
        marker,
      ].join("\n\n");
    }
    return [
      "You are an ordinary writable project session delegated by another project session.",
      `Outcome: ${binding.outcome}`,
      ...(binding.kickoffContext
        ? [`Bounded kickoff context:\n${binding.kickoffContext}`]
        : []),
      "Plan or implement directly as appropriate. Keep shared project state current and delegate further when useful.",
      marker,
    ].join("\n\n");
  }

  async onEventPersisted(
    event: AnalyticsEvent,
    runtimeToken: string,
  ): Promise<void> {
    if (event.type !== "prompt.submitted") return;
    const prompt =
      typeof event.payload.prompt === "string" ? event.payload.prompt : "";
    const match = KICKOFF_MARKER.exec(prompt);
    if (!match) return;
    const session = this.options.sessionManager.get(event.harnessSessionId);
    if (!session?.agentMapIdentity) return;
    const aggregate = await this.options.store.read(
      session.agentMapIdentity.projectId,
    );
    const binding = aggregate.bindings.find(
      ({ sessionId, bindingId }) =>
        sessionId === event.harnessSessionId && bindingId === match[1],
    );
    if (
      !binding ||
      binding.runtime?.runtimeToken !== runtimeToken ||
      !this.options.sessionManager.isCurrentRuntimeEpoch(
        binding.sessionId,
        runtimeToken,
      )
    ) {
      return;
    }
    const delivery = binding.deliveries.find(
      ({ deliveryId, inputId, contextEpoch }) =>
        deliveryId === match[2] &&
        inputId === match[3] &&
        contextEpoch === Number(match[4]),
    );
    if (
      !delivery ||
      binding.spawnEpoch !== Number(match[5]) ||
      !delivery.eventWatermark
    ) {
      return;
    }
    const identity: ProjectAgentSession = {
      projectId: binding.projectId,
      userId: session.agentMapIdentity.userId,
      sessionId: binding.parentSessionId,
    };
    await this.options.store.acknowledgeKickoff(
      identity,
      binding.bindingId,
      {
        contextEpoch: binding.contextEpoch,
        deliveryId: delivery.deliveryId,
        inputId: delivery.inputId,
        eventWatermark: delivery.eventWatermark,
      },
    );
    this.emit({
      name: "subsession.kickoff_acknowledged",
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    });
  }

  private async reconcileHistoricalDelivery(
    identity: ProjectAgentSession,
    initial: SubsessionBindingRecord,
  ): Promise<SubsessionBindingRecord> {
    const delivery = currentDelivery(initial);
    if (
      !["claimed", "submitted-unacknowledged", "uncertain"].includes(
        delivery.state,
      )
    ) {
      return initial;
    }
    for await (const event of this.options.eventReader.read({
      harnessSessionId: initial.sessionId,
      types: ["prompt.submitted"],
    })) {
      const prompt =
        typeof event.payload.prompt === "string" ? event.payload.prompt : "";
      const match = KICKOFF_MARKER.exec(prompt);
      if (
        match?.[1] === initial.bindingId &&
        match[2] === delivery.deliveryId &&
        match[3] === delivery.inputId &&
        Number(match[4]) === initial.contextEpoch &&
        Number(match[5]) === initial.spawnEpoch &&
        delivery.eventWatermark
      ) {
        return this.options.store.acknowledgeKickoff(
          identity,
          initial.bindingId,
          {
            contextEpoch: initial.contextEpoch,
            deliveryId: delivery.deliveryId,
            inputId: delivery.inputId,
            eventWatermark: delivery.eventWatermark,
          },
        );
      }
    }
    if (
      delivery.state === "submitted-unacknowledged" ||
      delivery.state === "uncertain" ||
      (delivery.state === "claimed" &&
        delivery.claim !== null &&
        delivery.claim.expiresAt <= new Date().toISOString())
    ) {
      return this.options.store.markKickoffUncertain(
        identity,
        initial.bindingId,
        {
          contextEpoch: initial.contextEpoch,
          deliveryId: delivery.deliveryId,
          inputId: delivery.inputId,
        },
      );
    }
    return initial;
  }

  private async latestEventId(sessionId: string): Promise<string> {
    let latest = "event_none";
    for await (const event of this.options.eventReader.read({
      harnessSessionId: sessionId,
    })) {
      latest = event.eventId;
    }
    return latest;
  }

  private title(outcome: string): string {
    const first = outcome.split("\n", 1)[0]?.trim() || "Delegated task";
    return [...first].slice(0, 80).join("");
  }

  private result(
    binding: SubsessionBindingRecord,
    outcome: DelegationItemOutcome,
  ): DelegationItemResult {
    return {
      delegationKey: binding.delegationKey,
      bindingId: binding.bindingId,
      sessionId: binding.sessionId,
      outcome,
      sessionState: binding.sessionState,
      contextState: binding.contextState,
      kickoffState: currentDelivery(binding).state,
    };
  }

  private releasedResult(
    binding: Pick<
      SubsessionBindingRecord,
      "delegationKey" | "bindingId" | "sessionId"
    >,
  ): DelegationItemResult {
    return {
      delegationKey: binding.delegationKey,
      bindingId: binding.bindingId,
      sessionId: binding.sessionId,
      outcome: "released",
      sessionState: "closed",
      contextState: "none",
      kickoffState: "pending",
    };
  }

  private failedResult(
    binding: SubsessionBindingRecord,
    detail: DelegationError,
  ): DelegationItemResult {
    return { ...this.result(binding, "failed"), error: detail };
  }

  private wholeCallError(cause: unknown, refresh = false): SubsessionCoordinatorError {
    if (cause instanceof SubsessionCoordinatorError) return cause;
    if (cause instanceof SubsessionCoordinatorStoreError) {
      if (
        cause.code === "request_key_reused"
      )
        return new SubsessionCoordinatorError(
          error("request_key_reused", false, "new_request_key"),
        );
      if (cause.code === "request_key_expired")
        return new SubsessionCoordinatorError(
          error("request_key_expired", false, "new_request_key"),
        );
      if (cause.code === "delegation_key_reused")
        return new SubsessionCoordinatorError(
          error("delegation_key_reused", false, "new_delegation_key"),
        );
      if (cause.code === "capacity_exceeded")
        return new SubsessionCoordinatorError(
          error("capacity_exceeded", false, "reduce_request"),
        );
      if (cause.code === "live_session_limit_reached")
        return new SubsessionCoordinatorError(
          error("capacity_exceeded", false, "inspect_session"),
        );
      if (
        cause.code === "delegation_depth_exceeded" ||
        cause.code === "history_quota_exceeded"
      ) {
        return new SubsessionCoordinatorError(
          error("capacity_exceeded", false, "none"),
        );
      }
      if (cause.code === "session_closed")
        return new SubsessionCoordinatorError(
          error("session_closed", false, "inspect_session"),
        );
      if (cause.code === "storage_unavailable")
        return new SubsessionCoordinatorError(
          error("storage_unavailable", true, "retry"),
        );
      if (refresh && cause.code === "binding_not_found")
        return new SubsessionCoordinatorError(
          error("context_not_found", false, "reread"),
        );
      if (cause.code === "binding_not_found")
        return new SubsessionCoordinatorError(
          error("session_closed", false, "inspect_session"),
        );
      if (refresh && cause.code === "lifecycle_conflict")
        return new SubsessionCoordinatorError(
          error("context_refresh_conflict", false, "reread"),
        );
      if (refresh && cause.code === "claim_conflict")
        return new SubsessionCoordinatorError(
          error("kickoff_failed", false, "inspect_session"),
        );
    }
    return new SubsessionCoordinatorError(
      error("internal_error", true, "retry"),
    );
  }

  private itemError(cause: unknown): DelegationError {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      "retryable" in cause &&
      "recovery" in cause
    ) {
      return cause as DelegationError;
    }
    if (cause instanceof SubsessionBindingMismatchError)
      return error("binding_session_mismatch", false, "inspect_session");
    if (cause instanceof SubsessionFreshRestartForbiddenError)
      return error("session_restart_failed", false, "inspect_session");
    if (cause instanceof SessionNotReadyError)
      return error("readiness_timeout", true, "retry");
    if (cause instanceof SubsessionCoordinatorStoreError) {
      if (cause.code === "storage_unavailable")
        return error("storage_unavailable", true, "retry");
      if (cause.code === "session_closed")
        return error("session_closed", false, "inspect_session");
      if (["lifecycle_conflict", "claim_conflict"].includes(cause.code))
        return error("session_unreachable", true, "inspect_session");
    }
    return error("session_create_failed", true, "retry");
  }
}
