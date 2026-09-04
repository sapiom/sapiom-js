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
const target = { harness: "codex" as const, projectRoot: "/project/root" };

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
    expect(first.binding.deliveries).toHaveLength(2);
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
      store.reserveDelegations(identity, delegate(), target),
    ).rejects.toMatchObject({ code: "session_closed" });
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

  it("reports exhausted permanent tombstone history as a terminal quota", async () => {
    const root = await fixture();
    const store = new SubsessionCoordinatorStore(root, {
      receiptRetentionLimit: 1,
      historyTombstoneLimit: 1,
    });
    await store.reserveDelegations(identity, delegate("request-1"), target);
    await store.reserveDelegations(identity, delegate("request-2"), target);
    await expect(
      store.reserveDelegations(identity, delegate("request-1"), target),
    ).resolves.toMatchObject({ replayed: true });
    const before = await store.read(projectId);

    await expect(
      store.reserveDelegations(identity, delegate("request-3"), target),
    ).rejects.toMatchObject({ code: "history_quota_exceeded" });
    expect(await store.read(projectId)).toEqual(before);
  });
});
