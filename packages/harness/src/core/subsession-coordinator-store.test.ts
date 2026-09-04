import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectAgentSession } from "../shared/agent-map.js";
import type { SubsessionBindingId } from "../shared/subsession-delegation.js";
import {
  SubsessionCoordinatorStore,
  SubsessionCoordinatorStoreError,
} from "./subsession-coordinator-store.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const identity: ProjectAgentSession = {
  projectId,
  userId: "user-1",
  sessionId: "parent-session-1",
};
const target = {
  harness: "codex" as const,
  projectRoot: "/project/root",
  ownerId: "coordinator-1",
};

const delegate = (
  requestKey = "request-1",
  delegations: Array<{
    delegationKey: string;
    outcome: string;
    kickoffContext?: string;
  }> = [{ delegationKey: "research", outcome: "Collect evidence" }],
) => ({
  schemaVersion: 1,
  requestKey,
  operation: { kind: "delegate", delegations },
});
const release = (
  requestKey = "release-1",
  delegationKeys = ["research"],
) => ({
  schemaVersion: 1,
  requestKey,
  operation: { kind: "release", delegationKeys },
});
const releaseDormant = (requestKey = "release-dormant-1", limit = 16) => ({
  schemaVersion: 1,
  requestKey,
  operation: { kind: "release-dormant", limit },
});
describe("SubsessionCoordinatorStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function fixture() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "subsession-coordinator-store-"),
    );
    roots.push(root);
    return root;
  }

  it("converges concurrent instances on one receipt, binding, and reserved real session id", async () => {
    const root = await fixture();
    const firstEvent = vi.fn();
    const secondEvent = vi.fn();
    const first = new SubsessionCoordinatorStore(root, {
      onEvent: firstEvent,
    });
    const second = new SubsessionCoordinatorStore(root, {
      onEvent: secondEvent,
    });

    const [left, right] = await Promise.all([
      first.reserveDelegations(identity, delegate(), target),
      second.reserveDelegations(identity, delegate(), target),
    ]);
    const restarted = await new SubsessionCoordinatorStore(root).read(projectId);

    expect(left.bindings).toEqual(right.bindings);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(restarted.requestReceipts).toHaveLength(1);
    expect(restarted.bindings).toHaveLength(1);
    expect(restarted.bindings[0]!.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const file = path.join(root, "projects", projectId, "subsessions.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(
      firstEvent.mock.calls.filter(
        ([event]) => event.name === "subsession.binding_reserved",
      ).length +
        secondEvent.mock.calls.filter(
          ([event]) => event.name === "subsession.binding_reserved",
        ).length,
    ).toBe(1);
  });

  it("rejects changed request and binding keys without changing the original", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const original = await store.reserveDelegations(
      identity,
      delegate(),
      target,
    );

    await expect(
      store.reserveDelegations(
        identity,
        delegate("request-1", [
          { delegationKey: "research", outcome: "Different task" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "request_key_reused" });
    await expect(
      store.reserveDelegations(
        identity,
        delegate("request-2", [
          { delegationKey: "research", outcome: "Different task" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "delegation_key_reused" });

    const aggregate = await store.read(projectId);
    expect(aggregate.requestReceipts).toHaveLength(1);
    expect(aggregate.bindings).toEqual(original.bindings);
  });

  it("reserves idempotent releases only for the trusted parent binding", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;

    const first = await store.reserveReleases(identity, release());
    const replay = await store.reserveReleases(identity, release());
    expect(first).toMatchObject({
      replayed: false,
      bindings: [{ state: "bound", binding: { bindingId: binding.bindingId } }],
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const foreign = { ...identity, sessionId: "manual-session" };
    await expect(
      store.reserveReleases(foreign, release("foreign-release")),
    ).resolves.toMatchObject({
      replayed: false,
      bindings: [{ state: "absent", delegationKey: "research" }],
    });
    expect((await store.read(projectId)).requestReceipts).toHaveLength(3);
  });

  it("reserves known and unknown release keys independently and replays both", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const request = release("mixed-release", ["missing", "research"]);

    const first = await store.reserveReleases(identity, request);
    const replay = await store.reserveReleases(identity, request);

    expect(first.bindings).toEqual([
      { state: "absent", delegationKey: "missing" },
      { state: "bound", binding },
    ]);
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await store.read(projectId)).requestReceipts.at(-1)).toMatchObject({
      operation: "release",
      bindingIds: [binding.bindingId],
    });
  });

  it("retains a released binding tombstone while an active release receipt references it", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 2,
      historyTombstoneLimit: 1,
    });
    const first = (
      await store.reserveDelegations(identity, delegate("request-1"), target)
    ).bindings[0]!;
    await store.closeBinding(identity, first.bindingId, first.sessionId);
    const second = (
      await store.reserveDelegations(
        identity,
        delegate("request-2", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        target,
      )
    ).bindings[0]!;
    await store.reserveDelegations(
      identity,
      delegate("request-3", [
        { delegationKey: "writer", outcome: "Write evidence" },
      ]),
      target,
    );
    const releaseRequest = release("release-first");
    const released = await store.reserveReleases(identity, releaseRequest);
    expect(released.bindings[0]).toMatchObject({
      state: "released",
      binding: { bindingId: first.bindingId },
    });

    await store.closeBinding(identity, second.bindingId, second.sessionId);
    await store.reserveDelegations(
      identity,
      delegate("request-4", [
        { delegationKey: "editor", outcome: "Edit evidence" },
      ]),
      target,
    );

    const aggregate = await store.read(projectId);
    expect(aggregate.bindingTombstones).toContainEqual(
      expect.objectContaining({ bindingId: first.bindingId }),
    );
    expect(await store.reserveReleases(identity, releaseRequest)).toMatchObject({
      replayed: true,
      bindings: [
        { state: "released", binding: { bindingId: first.bindingId } },
      ],
    });
  });

  it("refreshes child context with an idempotent receipt and a new delivery epoch", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const reserved = await store.reserveDelegations(
      identity,
      delegate(),
      target,
    );
    const binding = reserved.bindings[0]!;
    const request = {
      schemaVersion: 1,
      requestKey: "refresh-1",
      operation: {
        kind: "refresh-focused-context",
        target: { kind: "child", delegationKey: "research" },
        expectedContextEpoch: binding.contextEpoch,
        expectedContextDigest: binding.contextDigest,
        focus: null,
      },
    } as const;

    const first = await store.refreshFocusedContext(identity, request);
    const replay = await store.refreshFocusedContext(identity, request);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(first.binding.contextEpoch).toBe(2);
    expect(first.binding.deliveries).toHaveLength(1);
    expect(first.binding.deliveries[0]!.contextEpoch).toBe(2);
    expect(replay.binding).toEqual(first.binding);
    await expect(
      store.refreshFocusedContext(identity, {
        ...request,
        operation: { ...request.operation, expectedContextEpoch: 7 },
      }),
    ).rejects.toMatchObject({ code: "request_key_reused" });
  });

  it("reuses a compatible binding across request keys and reserves a batch atomically", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const first = await store.reserveDelegations(identity, delegate(), target);
    const second = await store.reserveDelegations(
      identity,
      delegate("request-2"),
      target,
    );
    expect(second.replayed).toBe(false);
    expect(second.bindings[0]!.bindingId).toBe(first.bindings[0]!.bindingId);

    await expect(
      store.reserveDelegations(
        identity,
        delegate("request-3", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
          { delegationKey: "research", outcome: "Changed task" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "delegation_key_reused" });
    const aggregate = await store.read(projectId);
    expect(aggregate.bindings.map(({ delegationKey }) => delegationKey)).toEqual([
      "research",
    ]);
    expect(aggregate.requestReceipts).toHaveLength(2);
  });

  it.each(["write", "file-sync", "rename", "directory-sync"] as const)(
    "exposes only complete state when %s fails",
    async (failedStep) => {
      const root = await fixture();
      let fail = false;
      const store = new SubsessionCoordinatorStore(root, {
        beforePersistStep: (step) => {
          if (fail && step === failedStep) throw new Error("injected failure");
        },
      });
      await store.read(projectId);
      fail = true;
      await expect(
        store.reserveDelegations(identity, delegate(), target),
      ).rejects.toMatchObject({ code: "storage_unavailable" });

      const restarted = await new SubsessionCoordinatorStore(root).read(
        projectId,
      );
      expect(restarted.bindings.length).toBe(
        failedStep === "directory-sync" ? 1 : 0,
      );
      expect(restarted.requestReceipts.length).toBe(restarted.bindings.length);
    },
  );

  it("allows one spawn claimant and requires inspection before expired takeover", async () => {
    const root = await fixture();
    let now = new Date("2026-09-04T12:00:00.000Z");
    const options = {
      now: () => now,
      claimTtlMs: 1_000,
    };
    const first = new SubsessionCoordinatorStore(root, options);
    const second = new SubsessionCoordinatorStore(root, options);
    const reserved = await first.reserveDelegations(
      identity,
      delegate(),
      target,
    );
    const binding = reserved.bindings[0]!;

    const [left, right] = await Promise.all([
      first.claimSpawn(identity, binding.bindingId, {
        ownerId: "coordinator-1",
        expectedLifecycleEpoch: 1,
        expectedSpawnEpoch: 0,
      }),
      second.claimSpawn(identity, binding.bindingId, {
        ownerId: "coordinator-2",
        expectedLifecycleEpoch: 1,
        expectedSpawnEpoch: 0,
      }),
    ]);
    const winner = [left, right].find((result) => result.claimed)!;
    const loser = [left, right].find((result) => !result.claimed)!;
    expect(loser).toMatchObject({ claimed: false, reason: "active" });

    now = new Date("2026-09-04T12:00:02.000Z");
    const observed = await second.claimSpawn(identity, binding.bindingId, {
      ownerId: "coordinator-2",
      expectedLifecycleEpoch: winner.binding.lifecycleEpoch,
      expectedSpawnEpoch: winner.binding.spawnEpoch,
    });
    expect(observed).toMatchObject({
      claimed: false,
      reason: "expired-requires-inspection",
    });
    if (!winner.claimed || !winner.binding.spawnClaim)
      throw new Error("missing winning claim");
    const takeover = await second.takeoverExpiredSpawnClaim(
      identity,
      binding.bindingId,
      {
        ownerId: "coordinator-2",
        expiredClaimId: winner.binding.spawnClaim.claimId,
        expectedLifecycleEpoch: winner.binding.lifecycleEpoch,
        expectedSpawnEpoch: winner.binding.spawnEpoch,
      },
    );
    expect(takeover.claimed).toBe(true);
    expect(takeover.binding.spawnEpoch).toBe(2);
  });

  it("fences stale spawn callbacks and only releases a claim with zero-process proof", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const claim = await store.claimSpawn(identity, binding.bindingId, {
      ownerId: "coordinator-1",
      expectedLifecycleEpoch: 1,
      expectedSpawnEpoch: 0,
    });
    if (!claim.claimed || !claim.binding.spawnClaim)
      throw new Error("claim was not acquired");

    await expect(
      store.attachSpawnedRuntime(identity, binding.bindingId, {
        claimId: "claim_stale",
        spawnEpoch: claim.binding.spawnEpoch,
        runtimeToken: "runtime-stale",
        incarnation: 1,
      }),
    ).rejects.toMatchObject({ code: "claim_conflict" });
    const released = await store.releaseUnspawnedClaim(
      identity,
      binding.bindingId,
      {
        claimId: claim.binding.spawnClaim.claimId,
        spawnEpoch: claim.binding.spawnEpoch,
        proof: "no-process-created",
      },
    );
    expect(released).toMatchObject({
      sessionState: "reserved",
      spawnClaim: null,
      runtime: null,
    });
  });

  it("persists one kickoff sender and never blindly retries uncertain delivery", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const spawn = await store.claimSpawn(identity, binding.bindingId, {
      ownerId: "coordinator-1",
      expectedLifecycleEpoch: 1,
      expectedSpawnEpoch: 0,
    });
    if (!spawn.claimed || !spawn.binding.spawnClaim)
      throw new Error("spawn claim was not acquired");
    const starting = await store.attachSpawnedRuntime(
      identity,
      binding.bindingId,
      {
        claimId: spawn.binding.spawnClaim.claimId,
        spawnEpoch: spawn.binding.spawnEpoch,
        runtimeToken: "runtime-1",
        incarnation: 1,
      },
    );
    const ready = await store.transitionSession(identity, binding.bindingId, {
      expectedLifecycleEpoch: starting.lifecycleEpoch,
      expectedSpawnEpoch: starting.spawnEpoch,
      expectedRuntimeToken: "runtime-1",
      state: "ready",
    });

    const [left, right] = await Promise.all([
      store.claimKickoff(identity, binding.bindingId, {
        ownerId: "sender-1",
        expectedLifecycleEpoch: ready.lifecycleEpoch,
        expectedSpawnEpoch: ready.spawnEpoch,
        expectedContextEpoch: ready.contextEpoch,
        eventWatermark: "event-10",
      }),
      new SubsessionCoordinatorStore(root).claimKickoff(
        identity,
        binding.bindingId,
        {
          ownerId: "sender-2",
          expectedLifecycleEpoch: ready.lifecycleEpoch,
          expectedSpawnEpoch: ready.spawnEpoch,
          expectedContextEpoch: ready.contextEpoch,
          eventWatermark: "event-10",
        },
      ),
    ]);
    const winner = [left, right].find((result) => result.claimed)!;
    expect([left, right].filter((result) => result.claimed)).toHaveLength(1);
    if (!winner.claimed) throw new Error("kickoff claim was not acquired");
    const delivery = winner.binding.deliveries[0]!;
    if (!delivery.claim) throw new Error("kickoff claim was not persisted");

    const uncertain = await store.recordKickoffWrite(
      identity,
      binding.bindingId,
      {
        contextEpoch: delivery.contextEpoch,
        deliveryId: delivery.deliveryId,
        inputId: delivery.inputId,
        claimId: delivery.claim.claimId,
        phase: "text-staged",
      },
    );
    expect(uncertain.deliveries[0]!.state).toBe("uncertain");
    await expect(
      store.claimKickoff(identity, binding.bindingId, {
        ownerId: "sender-3",
        expectedLifecycleEpoch: uncertain.lifecycleEpoch,
        expectedSpawnEpoch: uncertain.spawnEpoch,
        expectedContextEpoch: uncertain.contextEpoch,
        eventWatermark: "event-10",
      }),
    ).resolves.toMatchObject({ claimed: false, reason: "terminal" });

    const acknowledged = await store.acknowledgeKickoff(
      identity,
      binding.bindingId,
      {
        contextEpoch: delivery.contextEpoch,
        deliveryId: delivery.deliveryId,
        inputId: delivery.inputId,
        eventWatermark: "event-10",
      },
    );
    expect(acknowledged.deliveries[0]!.state).toBe("acknowledged");
    await expect(
      store.acknowledgeKickoff(identity, binding.bindingId, {
        contextEpoch: delivery.contextEpoch,
        deliveryId: delivery.deliveryId,
        inputId: "input_foreign",
        eventWatermark: "event-10",
      }),
    ).rejects.toBeInstanceOf(SubsessionCoordinatorStoreError);
  });

  it("queues a refresh while the prior delivery awaits acknowledgement", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const spawn = await store.claimSpawn(identity, binding.bindingId, {
      ownerId: "coordinator-1",
      expectedLifecycleEpoch: binding.lifecycleEpoch,
      expectedSpawnEpoch: binding.spawnEpoch,
    });
    if (!spawn.claimed || !spawn.binding.spawnClaim)
      throw new Error("spawn claim was not acquired");
    const starting = await store.attachSpawnedRuntime(
      identity,
      binding.bindingId,
      {
        claimId: spawn.binding.spawnClaim.claimId,
        spawnEpoch: spawn.binding.spawnEpoch,
        runtimeToken: "runtime-refresh",
        incarnation: 1,
      },
    );
    const ready = await store.transitionSession(identity, binding.bindingId, {
      expectedLifecycleEpoch: starting.lifecycleEpoch,
      expectedSpawnEpoch: starting.spawnEpoch,
      expectedRuntimeToken: "runtime-refresh",
      state: "ready",
    });
    const claimed = await store.claimKickoff(identity, binding.bindingId, {
      ownerId: "sender-1",
      expectedLifecycleEpoch: ready.lifecycleEpoch,
      expectedSpawnEpoch: ready.spawnEpoch,
      expectedContextEpoch: ready.contextEpoch,
      eventWatermark: "event-10",
    });
    if (!claimed.claimed || !claimed.binding.deliveries[0]!.claim)
      throw new Error("kickoff claim was not acquired");
    const submitted = await store.recordKickoffWrite(
      identity,
      binding.bindingId,
      {
        contextEpoch: claimed.binding.contextEpoch,
        deliveryId: claimed.binding.deliveries[0]!.deliveryId,
        inputId: claimed.binding.deliveries[0]!.inputId,
        claimId: claimed.binding.deliveries[0]!.claim!.claimId,
        phase: "enter-written",
      },
    );

    const refreshed = await store.refreshFocusedContext(identity, {
      schemaVersion: 1,
      requestKey: "refresh-while-awaiting-ack",
      operation: {
        kind: "refresh-focused-context",
        target: { kind: "child", delegationKey: "research" },
        expectedContextEpoch: submitted.contextEpoch,
        expectedContextDigest: submitted.contextDigest,
        focus: null,
      },
    });

    expect(refreshed.binding.deliveries).toHaveLength(2);
    expect(refreshed.binding.deliveries.map(({ state }) => state)).toEqual([
      "submitted-unacknowledged",
      "pending",
    ]);
  });

  it("scopes mutations to the trusted parent and never adopts a foreign binding", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root);
    const binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const foreign: ProjectAgentSession = {
      ...identity,
      sessionId: "manual-session-with-no-binding",
    };
    await expect(
      store.claimSpawn(foreign, binding.bindingId as SubsessionBindingId, {
        ownerId: "coordinator-foreign",
        expectedLifecycleEpoch: 1,
        expectedSpawnEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: "binding_scope_mismatch" });
    expect((await store.read(projectId)).bindings[0]).toEqual(binding);
  });

  it("bounds nested delegation depth and concurrently live coordinator sessions", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      maxDelegationDepth: 2,
      liveSessionLimit: 2,
    });
    const first = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    const child: ProjectAgentSession = {
      ...identity,
      sessionId: first.sessionId,
    };
    const second = (
      await store.reserveDelegations(
        child,
        delegate("nested-1", [
          { delegationKey: "nested", outcome: "Nested task" },
        ]),
        target,
      )
    ).bindings[0]!;

    expect(first).toMatchObject({ parentBindingId: null, delegationDepth: 1 });
    expect(second).toMatchObject({
      parentBindingId: first.bindingId,
      delegationDepth: 2,
    });
    await expect(
      store.reserveDelegations(
        { ...identity, sessionId: second.sessionId },
        delegate("too-deep", [
          { delegationKey: "third", outcome: "Too deep" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "delegation_depth_exceeded" });
    await expect(
      store.reserveDelegations(
        identity,
        delegate("over-live-limit", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "live_session_limit_reached" });
    expect((await store.read(projectId)).bindings).toHaveLength(2);
  });

  it("expires receipts into tombstones and reclaims closed bindings without reopening their keys", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 1,
    });
    const first = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;
    await store.closeBinding(identity, first.bindingId, first.sessionId);
    await store.reserveDelegations(
      identity,
      delegate("request-2", [
        { delegationKey: "publisher", outcome: "Publish evidence" },
      ]),
      target,
    );

    const aggregate = await store.read(projectId);
    expect(aggregate.requestReceipts.map(({ requestKey }) => requestKey)).toEqual([
      "request-2",
    ]);
    expect(aggregate.requestTombstones).toContainEqual(
      expect.objectContaining({ requestKey: "request-1" }),
    );
    expect(aggregate.bindings.map(({ delegationKey }) => delegationKey)).toEqual([
      "publisher",
    ]);
    expect(aggregate.bindingTombstones).toContainEqual(
      expect.objectContaining({
        bindingId: first.bindingId,
        delegationKey: "research",
        sessionId: first.sessionId,
      }),
    );
    await expect(
      store.closeOwnedBinding({
        projectId,
        parentSessionId: identity.sessionId,
        bindingId: first.bindingId,
        sessionId: first.sessionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.closeOwnedBinding({
        projectId,
        parentSessionId: identity.sessionId,
        bindingId: first.bindingId,
        sessionId: "foreign-session",
      }),
    ).rejects.toMatchObject({ code: "binding_not_found" });
    await expect(
      store.reserveDelegations(identity, delegate(), target),
    ).rejects.toMatchObject({ code: "request_key_expired" });
    await expect(
      store.reserveDelegations(
        identity,
        delegate("request-3", [
          { delegationKey: "research", outcome: "Collect evidence" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "session_closed" });
  });

  it("expires oldest key and ownership tombstones instead of dead-ending the project", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 1,
      historyTombstoneLimit: 1,
    });
    const first = (
      await store.reserveDelegations(identity, delegate("request-1"), target)
    ).bindings[0]!;
    await store.closeBinding(identity, first.bindingId, first.sessionId);
    const second = (
      await store.reserveDelegations(
        identity,
        delegate("request-2", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        target,
      )
    ).bindings[0]!;
    await store.closeBinding(identity, second.bindingId, second.sessionId);
    await expect(
      store.reserveDelegations(identity, delegate("request-1"), target),
    ).rejects.toMatchObject({ code: "request_key_expired" });
    await store.reserveDelegations(
      identity,
      delegate("request-3", [
        { delegationKey: "writer", outcome: "Write evidence" },
      ]),
      target,
    );

    const aggregate = await store.read(projectId);
    expect(aggregate.requestTombstones).toHaveLength(1);
    expect(aggregate.requestTombstones[0]!.requestKey).toBe("request-2");
    expect(aggregate.bindingTombstones).toHaveLength(1);
    expect(aggregate.bindingTombstones[0]!.bindingId).toBe(second.bindingId);
  });

  it.each(["exited", "failed"] as const)(
    "keeps a %s binding resumable and charges capacity only when it is re-referenced",
    async (sessionState) => {
      const root = await fixture();
      const store = new SubsessionCoordinatorStore(root, {
        receiptRetentionLimit: 1,
        liveSessionLimit: 2,
      });
      const first = (
        await store.reserveDelegations(identity, delegate("request-1"), target)
      ).bindings[0]!;
      const claim = await store.claimSpawn(identity, first.bindingId, {
        ownerId: "coordinator-1",
        expectedLifecycleEpoch: first.lifecycleEpoch,
        expectedSpawnEpoch: first.spawnEpoch,
      });
      if (!claim.claimed || !claim.binding.spawnClaim)
        throw new Error("spawn claim was not acquired");
      const starting = await store.attachSpawnedRuntime(
        identity,
        first.bindingId,
        {
          claimId: claim.binding.spawnClaim.claimId,
          spawnEpoch: claim.binding.spawnEpoch,
          runtimeToken: "runtime-exited",
          incarnation: 1,
        },
      );
      await store.transitionSession(identity, first.bindingId, {
        expectedLifecycleEpoch: starting.lifecycleEpoch,
        expectedSpawnEpoch: starting.spawnEpoch,
        expectedRuntimeToken: "runtime-exited",
        state: sessionState,
      });

      await store.reserveDelegations(
        identity,
        delegate("request-2", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        target,
      );
      const replay = await store.reserveDelegations(
        identity,
        delegate("request-3"),
        target,
      );

      const aggregate = await store.read(projectId);
      expect(replay.bindings[0]).toMatchObject({
        bindingId: first.bindingId,
        sessionId: first.sessionId,
        sessionState: "spawn-claimed",
      });
      expect(aggregate.bindings).toContainEqual(replay.bindings[0]);
      expect(aggregate.bindingTombstones).not.toContainEqual(
        expect.objectContaining({ bindingId: first.bindingId }),
      );
      await expect(
        store.reserveDelegations(
          identity,
          delegate("request-4", [
            { delegationKey: "writer", outcome: "Write evidence" },
          ]),
          target,
        ),
      ).rejects.toMatchObject({ code: "live_session_limit_reached" });
      expect((await store.read(projectId)).bindings).toHaveLength(2);
      await store.reserveReleases(
        identity,
        release(`release-${sessionState}`),
      );
      const closed = await store.closeBinding(
        identity,
        first.bindingId,
        first.sessionId,
      );
      expect(closed.sessionState).toBe("closed");
    },
  );

  it("lets a new parent delegate after an old parent's descendants become dormant", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, { liveSessionLimit: 2 });
    const dormant = (
      await store.reserveDelegations(identity, delegate("old-request"), target)
    ).bindings[0]!;
    const claim = await store.claimSpawn(identity, dormant.bindingId, {
      ownerId: "coordinator-1",
      expectedLifecycleEpoch: dormant.lifecycleEpoch,
      expectedSpawnEpoch: dormant.spawnEpoch,
    });
    if (!claim.claimed || !claim.binding.spawnClaim)
      throw new Error("spawn claim was not acquired");
    const starting = await store.attachSpawnedRuntime(
      identity,
      dormant.bindingId,
      {
        claimId: claim.binding.spawnClaim.claimId,
        spawnEpoch: claim.binding.spawnEpoch,
        runtimeToken: "runtime-dormant",
        incarnation: 1,
      },
    );
    await store.transitionSession(identity, dormant.bindingId, {
      expectedLifecycleEpoch: starting.lifecycleEpoch,
      expectedSpawnEpoch: starting.spawnEpoch,
      expectedRuntimeToken: "runtime-dormant",
      state: "exited",
    });

    const newParent = { ...identity, sessionId: "parent-session-2" };
    const active = await store.reserveDelegations(
      newParent,
      delegate("new-request", [
        { delegationKey: "publisher", outcome: "Publish evidence" },
        { delegationKey: "writer", outcome: "Write evidence" },
      ]),
      target,
    );

    expect(active.bindings).toHaveLength(2);
    expect((await store.read(projectId)).bindings).toContainEqual(
      expect.objectContaining({
        bindingId: dormant.bindingId,
        sessionState: "exited",
      }),
    );
    await expect(
      store.reserveDelegations(
        newParent,
        delegate("new-request-2", [
          { delegationKey: "editor", outcome: "Edit evidence" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "live_session_limit_reached" });
  });

  it("fences a dormant resume racing a new parent's active reservation", async () => {
    const root = await fixture();
    const firstStore = new SubsessionCoordinatorStore(root, {
      liveSessionLimit: 1,
    });
    const secondStore = new SubsessionCoordinatorStore(root, {
      liveSessionLimit: 1,
    });
    const dormant = (
      await firstStore.reserveDelegations(
        identity,
        delegate("old-request"),
        target,
      )
    ).bindings[0]!;
    const claim = await firstStore.claimSpawn(identity, dormant.bindingId, {
      ownerId: "coordinator-1",
      expectedLifecycleEpoch: dormant.lifecycleEpoch,
      expectedSpawnEpoch: dormant.spawnEpoch,
    });
    if (!claim.claimed || !claim.binding.spawnClaim)
      throw new Error("spawn claim was not acquired");
    const starting = await firstStore.attachSpawnedRuntime(
      identity,
      dormant.bindingId,
      {
        claimId: claim.binding.spawnClaim.claimId,
        spawnEpoch: claim.binding.spawnEpoch,
        runtimeToken: "runtime-dormant-race",
        incarnation: 1,
      },
    );
    await firstStore.transitionSession(identity, dormant.bindingId, {
      expectedLifecycleEpoch: starting.lifecycleEpoch,
      expectedSpawnEpoch: starting.spawnEpoch,
      expectedRuntimeToken: "runtime-dormant-race",
      state: "exited",
    });

    const newParent = { ...identity, sessionId: "parent-session-2" };
    const results = await Promise.allSettled([
      firstStore.reserveDelegations(
        identity,
        delegate("resume-request"),
        target,
      ),
      secondStore.reserveDelegations(
        newParent,
        delegate("new-request", [
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        { ...target, ownerId: "coordinator-2" },
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "live_session_limit_reached" },
    });
    const aggregate = await firstStore.read(projectId);
    expect(
      aggregate.bindings.filter(({ sessionState }) =>
        [
          "reserved",
          "spawn-claimed",
          "starting",
          "awaiting-ready",
          "ready",
        ].includes(sessionState),
      ),
    ).toHaveLength(1);
    expect(aggregate.bindings).toContainEqual(
      expect.objectContaining({ bindingId: dormant.bindingId }),
    );
  });

  it("reclaims a bounded dormant binding at history capacity and preserves replay", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      bindingLimit: 2,
      liveSessionLimit: 2,
    });
    const dormant = (
      await store.reserveDelegations(
        identity,
        delegate("old-request", [
          { delegationKey: "research", outcome: "Collect evidence" },
          { delegationKey: "publisher", outcome: "Publish evidence" },
        ]),
        target,
      )
    ).bindings;
    for (const [index, binding] of dormant.entries()) {
      const claim = await store.claimSpawn(identity, binding.bindingId, {
        ownerId: "coordinator-1",
        expectedLifecycleEpoch: binding.lifecycleEpoch,
        expectedSpawnEpoch: binding.spawnEpoch,
      });
      if (!claim.claimed || !claim.binding.spawnClaim)
        throw new Error("spawn claim was not acquired");
      const starting = await store.attachSpawnedRuntime(
        identity,
        binding.bindingId,
        {
          claimId: claim.binding.spawnClaim.claimId,
          spawnEpoch: claim.binding.spawnEpoch,
          runtimeToken: `runtime-history-${index}`,
          incarnation: 1,
        },
      );
      await store.transitionSession(identity, binding.bindingId, {
        expectedLifecycleEpoch: starting.lifecycleEpoch,
        expectedSpawnEpoch: starting.spawnEpoch,
        expectedRuntimeToken: `runtime-history-${index}`,
        state: index === 0 ? "exited" : "failed",
      });
    }

    const newParent = { ...identity, sessionId: "parent-session-2" };
    await expect(
      store.reserveDelegations(
        newParent,
        delegate("new-request", [
          { delegationKey: "writer", outcome: "Write evidence" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "history_quota_exceeded" });

    const request = releaseDormant("sweep-at-cap", 1);
    const reserved = await store.reserveDormantReleases(
      newParent,
      request,
      [dormant[0]!.bindingId],
    );
    expect(reserved.bindings).toEqual([
      {
        state: "bound",
        binding: expect.objectContaining({
          bindingId: dormant[0]!.bindingId,
          sessionState: "closed",
        }),
      },
    ]);
    await store.closeBinding(
      identity,
      dormant[0]!.bindingId,
      dormant[0]!.sessionId,
    );
    await store.finalizeReleasedBinding(
      identity,
      dormant[0]!.bindingId,
      dormant[0]!.sessionId,
    );
    const replay = await store.reserveDormantReleases(
      newParent,
      request,
      [],
    );
    expect(replay).toMatchObject({
      replayed: true,
      bindings: [
        {
          state: "released",
          binding: { bindingId: dormant[0]!.bindingId },
        },
      ],
    });

    const created = await store.reserveDelegations(
      newParent,
      delegate("new-request", [
        { delegationKey: "writer", outcome: "Write evidence" },
      ]),
      target,
    );
    expect(created.bindings[0]).toMatchObject({ delegationKey: "writer" });
    expect((await store.read(projectId)).bindings).toContainEqual(
      expect.objectContaining({
        bindingId: dormant[1]!.bindingId,
        sessionState: "failed",
      }),
    );
  });

  it("reclaims released capacity so a sixty-fifth delegation can be reserved", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 1,
    });
    const bindings = [];
    for (let batch = 0; batch < 4; batch += 1) {
      const reserved = await store.reserveDelegations(
        identity,
        delegate(
          `capacity-${batch}`,
          Array.from({ length: 16 }, (_, index) => ({
            delegationKey: `child-${batch * 16 + index + 1}`,
            outcome: `Task ${batch * 16 + index + 1}`,
          })),
        ),
        target,
      );
      bindings.push(...reserved.bindings);
    }
    await expect(
      store.reserveDelegations(
        identity,
        delegate("capacity-65", [
          { delegationKey: "child-65", outcome: "Task 65" },
        ]),
        target,
      ),
    ).rejects.toMatchObject({ code: "live_session_limit_reached" });

    const released = await store.reserveReleases(
      identity,
      release("release-capacity", ["child-1"]),
    );
    expect(released.bindings[0]).toMatchObject({
      state: "bound",
      binding: { bindingId: bindings[0]!.bindingId },
    });
    await store.closeBinding(
      identity,
      bindings[0]!.bindingId,
      bindings[0]!.sessionId,
    );
    const sixtyFifth = await store.reserveDelegations(
      identity,
      delegate("capacity-65", [
        { delegationKey: "child-65", outcome: "Task 65" },
      ]),
      target,
    );

    expect(sixtyFifth.bindings[0]!.delegationKey).toBe("child-65");
    const aggregate = await store.read(projectId);
    expect(aggregate.bindings).toHaveLength(64);
    expect(aggregate.bindingTombstones).toContainEqual(
      expect.objectContaining({ bindingId: bindings[0]!.bindingId }),
    );
  });

  it("prunes proven terminal deliveries so long-lived focused refresh stays writable", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 1,
      historyTombstoneLimit: 2,
    });
    let binding = (
      await store.reserveDelegations(identity, delegate(), target)
    ).bindings[0]!;

    for (let index = 1; index <= 70; index += 1) {
      binding = (
        await store.refreshFocusedContext(identity, {
          schemaVersion: 1,
          requestKey: `refresh-${index}`,
          operation: {
            kind: "refresh-focused-context",
            target: { kind: "child", delegationKey: "research" },
            expectedContextEpoch: binding.contextEpoch,
            expectedContextDigest: binding.contextDigest,
            focus: null,
          },
        })
      ).binding;
    }

    expect(binding.contextEpoch).toBe(71);
    expect(binding.deliveries).toHaveLength(1);
    expect(binding.deliveries[0]!.contextEpoch).toBe(71);
  });
});
