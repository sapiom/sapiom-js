import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  dirtyGraphSourceRoots,
  graphSourceRootsWithinScope,
  HarnessRegistryInventoryProvider,
  inventorySourceRoot,
  type AgentInventoryResult,
  type HarnessRegistryInventoryProviderOptions,
  type WorkspaceScope,
} from "./system-graph-inventory.js";
import type { ManifestNameInspection } from "./definition-name.js";
import { workspaceRelativeLocalKey } from "../shared/system-graph.js";

const WORKSPACE = "/private/workspaces/acme";
const SCOPE: WorkspaceScope = {
  workspaceKey: "workspace-acme",
  root: WORKSPACE,
};

function workflow(
  name: string,
  relativePath: string,
  definitionSlug: string | null,
  overrides: Partial<WorkflowInfo> = {},
): WorkflowInfo {
  return {
    name,
    path: relativePath ? `${WORKSPACE}/${relativePath}` : WORKSPACE,
    definitionId: definitionSlug ? 1 : null,
    definitionSlug,
    source: "scan",
    ...overrides,
  };
}

function provider(
  workflows: readonly WorkflowInfo[],
  options: Partial<HarnessRegistryInventoryProviderOptions> = {},
): HarnessRegistryInventoryProvider {
  return new HarnessRegistryInventoryProvider({
    listWorkflows: () => workflows,
    fingerprintSource: async (sourceRoot) => `fingerprint:${sourceRoot}`,
    ...options,
  });
}

async function enrich(
  inventory: HarnessRegistryInventoryProvider,
  initial: AgentInventoryResult,
  changed: ReturnType<typeof vi.fn>,
): Promise<AgentInventoryResult> {
  initial.startEnrichment?.();
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  return inventory.listAgents(SCOPE);
}

describe("HarnessRegistryInventoryProvider", () => {
  it("derives inventory roots using POSIX, drive, and UNC workspace flavor", () => {
    expect(inventorySourceRoot("/workspace", "nested/agent")).toBe(
      "/workspace/nested/agent",
    );
    expect(inventorySourceRoot("C:\\workspace", "nested/agent")).toBe(
      "C:\\workspace\\nested\\agent",
    );
    expect(
      inventorySourceRoot("\\\\server\\share\\workspace", "nested/agent"),
    ).toBe("\\\\server\\share\\workspace\\nested\\agent");
  });

  it("uses a checkout-invariant shared local key for a scope-root agent", () => {
    expect(workspaceRelativeLocalKey("/checkouts/one", "/checkouts/one")).toBe(
      "local:root",
    );
    expect(
      workspaceRelativeLocalKey("/different/name", "/different/name"),
    ).toBe("local:root");
  });

  it("returns linked agents provisionally before source inspection starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspectManifestName = vi.fn(async () => {
      await gate;
      return { status: "found" as const, name: "SourceName" };
    });
    const changed = vi.fn();
    const inventory = provider(
      [workflow("Research package", "research", "old-marker")],
      { inspectManifestName, onIdentityChange: changed },
    );

    const initial = await inventory.listAgents(SCOPE);

    expect(inspectManifestName).not.toHaveBeenCalled();
    expect(initial.identitySettled).toBe(false);
    expect(initial.inventory).toMatchObject({
      status: "degraded",
      agents: [
        {
          agentKey: "old-marker",
          identityStatus: "provisional",
          identityIssue: "identity-pending",
          path: "research",
          entrypoint: "index.ts",
        },
      ],
    });
    expect(initial.context[0]).toMatchObject({
      agentKey: "old-marker",
      workflowPath: `${WORKSPACE}/research`,
      resolutionAliases: ["old-marker"],
    });

    initial.startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(1),
    );
    release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const enriched = await inventory.listAgents(SCOPE);

    expect(enriched.inventory).toMatchObject({
      status: "complete",
      agents: [
        {
          agentKey: "SourceName",
          identityStatus: "canonical",
        },
      ],
    });
    expect(enriched.identitySettled).toBe(true);
    expect(enriched.context[0]?.resolutionAliases).toEqual(["old-marker"]);
  });

  it("uses a renamed source identity while retaining the marker only as an alias", async () => {
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockResolvedValueOnce({ status: "found", name: "Before" })
      .mockResolvedValueOnce({ status: "found", name: "After" });
    const changed = vi.fn();
    const inventory = provider([workflow("Package", "agent", "marker-name")], {
      inspectManifestName,
      onIdentityChange: changed,
    });

    const before = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );
    expect(before.inventory.agents[0]?.agentKey).toBe("Before");

    changed.mockClear();
    inventory.invalidateSource(`${WORKSPACE}/agent`);
    const pending = await inventory.listAgents(SCOPE);
    expect(pending.inventory.agents[0]).toMatchObject({
      agentKey: "marker-name",
      identityIssue: "identity-pending",
    });
    const after = await enrich(inventory, pending, changed);

    expect(after.inventory.agents[0]?.agentKey).toBe("After");
    expect(after.context[0]?.resolutionAliases).toEqual(["marker-name"]);
  });

  it("does not call two unsettled marker identities a collision", async () => {
    let release!: () => void;
    const inspectionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      await inspectionGate;
      return {
        status: "found" as const,
        name: sourceRoot.endsWith("/first") ? "payments" : "billing",
      };
    });
    const changed = vi.fn();
    const inventory = provider(
      [
        workflow("First", "first", "shared-marker"),
        workflow("Second", "second", "shared-marker"),
      ],
      { inspectManifestName, onIdentityChange: changed },
    );

    const pending = await inventory.listAgents(SCOPE);
    expect(pending.identitySettled).toBe(false);
    expect(pending.warnings).toEqual([]);
    expect(pending.inventory.agents).toMatchObject([
      {
        agentKey: "local:first",
        identityStatus: "provisional",
        identityIssue: "identity-pending",
      },
      {
        agentKey: "local:second",
        identityStatus: "provisional",
        identityIssue: "identity-pending",
      },
    ]);
    expect(
      pending.inventory.agents.map((agent) => agent.identityIssue),
    ).toEqual(["identity-pending", "identity-pending"]);
    expect(pending.context.map((item) => item.resolutionAliases)).toEqual([
      ["shared-marker"],
      ["shared-marker"],
    ]);

    pending.startEnrichment?.();
    release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    const settled = await inventory.listAgents(SCOPE);

    expect(settled.identitySettled).toBe(true);
    expect(settled.inventory.agents.map((agent) => agent.agentKey)).toEqual([
      "billing",
      "payments",
    ]);
    expect(settled.warnings).toEqual([]);
  });

  it("keeps shared retryable marker guesses under local identities", async () => {
    const changed = vi.fn();
    const inventory = provider(
      [
        workflow("First", "first", "shared-marker"),
        workflow("Second", "second", "shared-marker"),
      ],
      {
        inspectManifestName: async () => ({
          status: "failed",
          retryable: true,
        }),
        onIdentityChange: changed,
      },
    );

    const result = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );

    expect(result.identitySettled).toBe(false);
    expect(result.inventory.agents).toMatchObject([
      {
        agentKey: "local:first",
        identityStatus: "provisional",
        identityIssue: "identity-unavailable",
      },
      {
        agentKey: "local:second",
        identityStatus: "provisional",
        identityIssue: "identity-unavailable",
      },
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(
      result.warnings.every(
        (warning) => warning.code === "inventory-extraction-failed",
      ),
    ).toBe(true);
  });

  it("keeps duplicate source names as separate deterministic local identities", async () => {
    const inspectManifestName = vi.fn(async () => ({
      status: "found" as const,
      name: "shared",
    }));
    const changed = vi.fn();
    const inventory = provider(
      [
        workflow("First", "first", "marker-first"),
        workflow("Second", "second", "marker-second"),
      ],
      { inspectManifestName, onIdentityChange: changed },
    );
    const initial = await inventory.listAgents(SCOPE);
    initial.startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const result = await inventory.listAgents(SCOPE);

    expect(result.inventory.agents).toEqual([
      {
        agentKey: "local:first",
        identityStatus: "provisional",
        identityIssue: "duplicate-agent-key",
        candidateAgentKey: "shared",
        path: "first",
        entrypoint: "index.ts",
      },
      {
        agentKey: "local:second",
        identityStatus: "provisional",
        identityIssue: "duplicate-agent-key",
        candidateAgentKey: "shared",
        path: "second",
        entrypoint: "index.ts",
      },
    ]);
    expect(result.context.map((item) => item.resolutionAliases)).toEqual([
      ["marker-first", "shared"],
      ["marker-second", "shared"],
    ]);
    expect(result.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
  });

  it("keeps a source-canonical identity above a colliding provisional marker", async () => {
    const inspectManifestName = vi.fn(async (sourceRoot: string) =>
      sourceRoot.endsWith("/canonical")
        ? ({ status: "found", name: "payments" } as const)
        : ({ status: "absent" } as const),
    );
    const changed = vi.fn();
    const inventory = provider(
      [
        workflow("Canonical", "canonical", "old-payments"),
        workflow("Pending", "pending", "payments"),
      ],
      { inspectManifestName, onIdentityChange: changed },
    );
    const initial = await inventory.listAgents(SCOPE);
    initial.startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const result = await inventory.listAgents(SCOPE);

    expect(result.inventory.agents).toEqual([
      {
        agentKey: "local:pending",
        identityStatus: "provisional",
        identityIssue: "identity-unavailable",
        path: "pending",
        entrypoint: "index.ts",
      },
      {
        agentKey: "payments",
        identityStatus: "canonical",
        path: "canonical",
        entrypoint: "index.ts",
      },
    ]);
    expect(
      result.context.map((item) => [item.agentKey, item.resolutionAliases]),
    ).toEqual([
      ["local:pending", ["payments"]],
      ["payments", ["old-payments"]],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("preserves a provisional marker identity after inspection failure and retries only explicitly", async () => {
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockResolvedValueOnce({ status: "failed", retryable: true })
      .mockResolvedValueOnce({ status: "found", name: "recovered" });
    const changed = vi.fn();
    const inventory = provider([workflow("Research", "research", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });
    const failed = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );

    expect(failed.inventory.agents[0]).toMatchObject({
      agentKey: "marker",
      identityStatus: "provisional",
      identityIssue: "identity-unavailable",
    });
    expect(failed.warnings[0]?.code).toBe("inventory-extraction-failed");
    expect(failed.identitySettled).toBe(false);
    failed.startEnrichment?.();
    await Promise.resolve();
    expect(inspectManifestName).toHaveBeenCalledTimes(1);

    inventory.retryFailedInspections(SCOPE);
    changed.mockClear();
    const retrying = await inventory.listAgents(SCOPE);
    const recovered = await enrich(inventory, retrying, changed);
    expect(inspectManifestName).toHaveBeenCalledTimes(2);
    expect(recovered.inventory.agents[0]).toMatchObject({
      agentKey: "recovered",
      identityStatus: "canonical",
    });
  });

  it("settles an unnameable identity without hiding its warning", async () => {
    const changed = vi.fn();
    const inventory = provider(
      [workflow("Dashboard", "dashboard", null)],
      {
        inspectManifestName: async () => ({
          status: "failed",
          retryable: false,
        }),
        onIdentityChange: changed,
      },
    );

    const result = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );

    expect(result.inventory).toMatchObject({
      status: "degraded",
      agents: [
        {
          agentKey: "local:dashboard",
          identityIssue: "identity-unavailable",
        },
      ],
    });
    expect(result.identitySettled).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "inventory-extraction-failed",
        agentKey: "local:dashboard",
      }),
    ]);
  });

  it("treats an absent source definition as normal unavailable identity", async () => {
    const changed = vi.fn();
    const inspectManifestName = vi.fn(async () => ({
      status: "absent" as const,
    }));
    const inventory = provider([workflow("Research", "research", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });
    const result = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );

    expect(result.inventory.agents[0]).toMatchObject({
      agentKey: "marker",
      identityStatus: "provisional",
      identityIssue: "identity-unavailable",
    });
    expect(result.warnings).toEqual([]);
    expect(result.identitySettled).toBe(true);

    inventory.retryFailedInspections(SCOPE);
    const afterExplicitRetry = await inventory.listAgents(SCOPE);
    expect(afterExplicitRetry.inventory.agents[0]).toMatchObject({
      agentKey: "marker",
      identityIssue: "identity-unavailable",
    });
    expect(inspectManifestName).toHaveBeenCalledTimes(1);
  });

  it("keeps invalid source names provisional without leaking the candidate", async () => {
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "safe-marker")], {
      inspectManifestName: async () => ({
        status: "found",
        name: "../unsafe",
      }),
      onIdentityChange: changed,
    });
    const result = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );

    expect(result.inventory.agents[0]).toEqual({
      agentKey: "safe-marker",
      identityStatus: "provisional",
      identityIssue: "identity-invalid",
      path: "agent",
      entrypoint: "index.ts",
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "inventory-extraction-failed" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("../unsafe");
  });

  it("caps background source inspection concurrency at four", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return { status: "found" as const, name: path.basename(sourceRoot) };
    });
    const changed = vi.fn();
    const inventory = provider(
      Array.from({ length: 7 }, (_, index) =>
        workflow(`Agent ${index}`, `agent-${index}`, null),
      ),
      { inspectManifestName, onIdentityChange: changed },
    );

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(4),
    );
    expect(maximum).toBe(4);
    release();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(changed).toHaveBeenCalledWith(
      Array.from({ length: 7 }, (_, index) => `${WORKSPACE}/agent-${index}`),
    );
    expect(maximum).toBe(4);
  });

  it("surfaces settled identities within a bounded window while slower work continues", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      if (sourceRoot.endsWith("/slow")) await slow;
      return { status: "found" as const, name: path.basename(sourceRoot) };
    });
    const changed = vi.fn();
    const inventory = provider(
      [workflow("Fast", "fast", null), workflow("Slow", "slow", null)],
      {
        inspectManifestName,
        onIdentityChange: changed,
      },
    );

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(changed).toHaveBeenNthCalledWith(1, [`${WORKSPACE}/fast`]);

    const partial = await inventory.listAgents(SCOPE);
    expect(
      partial.inventory.agents.find((agent) => agent.path === "fast"),
    ).toMatchObject({ agentKey: "fast", identityStatus: "canonical" });
    expect(
      partial.inventory.agents.find((agent) => agent.path === "slow"),
    ).toMatchObject({ identityIssue: "identity-pending" });

    releaseSlow();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(changed).toHaveBeenNthCalledWith(2, [`${WORKSPACE}/slow`]);
  });

  it("drops a settled batch notification when its source is invalidated before the batch drains", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      if (sourceRoot.endsWith("/slow")) await slow;
      return { status: "found" as const, name: path.basename(sourceRoot) };
    });
    const changed = vi.fn();
    const inventory = provider(
      [workflow("Fast", "fast", null), workflow("Slow", "slow", null)],
      {
        inspectManifestName,
        onIdentityChange: changed,
        identityChangeCoalesceMs: 10_000,
      },
    );

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(async () => {
      const snapshot = await inventory.listAgents(SCOPE);
      expect(
        snapshot.inventory.agents.find((agent) => agent.path === "fast")
          ?.agentKey,
      ).toBe("fast");
      expect(
        snapshot.inventory.agents.find((agent) => agent.path === "slow")
          ?.identityIssue,
      ).toBe("identity-pending");
    });
    inventory.invalidateSource(`${WORKSPACE}/fast`);
    releaseSlow();

    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(changed).toHaveBeenCalledWith([`${WORKSPACE}/slow`]);
  });

  it("deduplicates in-flight inspection and prevents an invalidated result from winning", async () => {
    let resolveBefore!: (value: ManifestNameInspection) => void;
    let resolveAfter!: (value: ManifestNameInspection) => void;
    const before = new Promise<ManifestNameInspection>((resolve) => {
      resolveBefore = resolve;
    });
    const after = new Promise<ManifestNameInspection>((resolve) => {
      resolveAfter = resolve;
    });
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockReturnValueOnce(before)
      .mockReturnValueOnce(after);
    const changed = vi.fn();
    const sourceRoot = `${WORKSPACE}/agent`;
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });

    const initial = await inventory.listAgents(SCOPE);
    initial.startEnrichment?.();
    initial.startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(1),
    );

    inventory.invalidateSource(sourceRoot);
    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    resolveBefore({ status: "found", name: "Before" });
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(2),
    );
    expect(changed).not.toHaveBeenCalled();
    resolveAfter({ status: "found", name: "After" });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0]?.agentKey,
    ).toBe("After");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("coalesces burst invalidations so one root cannot occupy every inspection slot", async () => {
    let releaseOld!: (value: ManifestNameInspection) => void;
    let releaseLatest!: (value: ManifestNameInspection) => void;
    const oldInspection = new Promise<ManifestNameInspection>((resolve) => {
      releaseOld = resolve;
    });
    const latestInspection = new Promise<ManifestNameInspection>((resolve) => {
      releaseLatest = resolve;
    });
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockReturnValueOnce(oldInspection)
      .mockReturnValueOnce(latestInspection);
    const changed = vi.fn();
    const sourceRoot = `${WORKSPACE}/agent`;
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(1),
    );
    for (let index = 0; index < 6; index += 1) {
      inventory.invalidateSource(sourceRoot);
      (await inventory.listAgents(SCOPE)).startEnrichment?.();
    }
    expect(inspectManifestName).toHaveBeenCalledTimes(1);

    releaseOld({ status: "found", name: "Old" });
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(2),
    );
    expect(changed).not.toHaveBeenCalled();
    releaseLatest({ status: "found", name: "Latest" });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0]?.agentKey,
    ).toBe("Latest");
  });

  it("does not let an active inspection repopulate identity after clear", async () => {
    let release!: (value: ManifestNameInspection) => void;
    const inspection = new Promise<ManifestNameInspection>((resolve) => {
      release = resolve;
    });
    const inspectManifestName = vi.fn(() => inspection);
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(1),
    );
    inventory.clear();
    release({ status: "found", name: "Retired" });
    await vi.waitFor(() => expect(changed).not.toHaveBeenCalled());

    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0],
    ).toMatchObject({
      agentKey: "marker",
      identityIssue: "identity-pending",
    });
  });

  it("prunes settled identity state for a removed registry root", async () => {
    const inspectManifestName = vi.fn(async () => ({
      status: "found" as const,
      name: "Settled",
    }));
    const changed = vi.fn();
    const sourceRoot = `${WORKSPACE}/agent`;
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });
    await enrich(inventory, await inventory.listAgents(SCOPE), changed);

    inventory.retainSources(new Set());
    const readded = await inventory.listAgents(SCOPE);

    expect(readded.inventory.agents[0]).toMatchObject({
      agentKey: "marker",
      identityIssue: "identity-pending",
    });
    expect(sourceRoot).toBe(readded.context[0]?.sourceRoot);
  });

  it("invalidates an in-flight inspection when its source root retires", async () => {
    let release!: (value: ManifestNameInspection) => void;
    const pending = new Promise<ManifestNameInspection>((resolve) => {
      release = resolve;
    });
    const inspectManifestName = vi.fn(() => pending);
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      onIdentityChange: changed,
    });

    (await inventory.listAgents(SCOPE)).startEnrichment?.();
    await vi.waitFor(() =>
      expect(inspectManifestName).toHaveBeenCalledTimes(1),
    );
    inventory.retainSources(new Set());
    release({ status: "found", name: "Retired" });
    await Promise.resolve();
    await Promise.resolve();

    expect(changed).not.toHaveBeenCalled();
    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0],
    ).toMatchObject({
      agentKey: "marker",
      identityIssue: "identity-pending",
    });
  });

  it("serves a cached identity immediately and refreshes it after a missed edit", async () => {
    let fingerprint = "v1";
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockResolvedValueOnce({ status: "found", name: "Before" })
      .mockResolvedValueOnce({ status: "found", name: "After" });
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      fingerprintSource: async () => fingerprint,
      onIdentityChange: changed,
    });
    const before = await enrich(
      inventory,
      await inventory.listAgents(SCOPE),
      changed,
    );
    expect(before.inventory.agents[0]?.agentKey).toBe("Before");

    changed.mockClear();
    fingerprint = "v2";
    const immediate = await inventory.listAgents(SCOPE);
    expect(immediate.inventory.agents[0]?.agentKey).toBe("Before");
    immediate.startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0]?.agentKey,
    ).toBe("After");
  });

  it("preserves a settled identity when background fingerprinting fails", async () => {
    let fingerprintFails = false;
    const fingerprintSource = vi.fn(async () => {
      if (fingerprintFails) throw new Error("stat failed");
      return "v1";
    });
    const inspectManifestName = vi.fn(async () => ({
      status: "found" as const,
      name: "Before",
    }));
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      fingerprintSource,
      onIdentityChange: changed,
    });
    await enrich(inventory, await inventory.listAgents(SCOPE), changed);

    changed.mockClear();
    fingerprintFails = true;
    const cached = await inventory.listAgents(SCOPE);
    expect(cached.inventory.agents[0]?.agentKey).toBe("Before");
    cached.startEnrichment?.();
    await vi.waitFor(() => expect(fingerprintSource).toHaveBeenCalledTimes(2));

    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0]?.agentKey,
    ).toBe("Before");
    expect(changed).not.toHaveBeenCalled();
  });

  it("degrades when a changed fingerprint is observed but inspection fails", async () => {
    let fingerprint = "v1";
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockResolvedValueOnce({ status: "found", name: "Before" })
      .mockRejectedValueOnce(new Error("bundle failed"));
    const changed = vi.fn();
    const inventory = provider([workflow("Agent", "agent", "marker")], {
      inspectManifestName,
      fingerprintSource: async () => fingerprint,
      onIdentityChange: changed,
    });
    await enrich(inventory, await inventory.listAgents(SCOPE), changed);

    fingerprint = "v2";
    changed.mockClear();
    const cached = await inventory.listAgents(SCOPE);
    cached.startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const degraded = await inventory.listAgents(SCOPE);

    expect(degraded.inventory.agents[0]).toMatchObject({
      agentKey: "marker",
      identityIssue: "identity-unavailable",
    });
    expect(degraded.warnings).toEqual([
      expect.objectContaining({ code: "inventory-extraction-failed" }),
    ]);
  });

  it("reinspects a retired root when it is later re-added", async () => {
    const registered = workflow("Agent", "agent", "marker");
    let workflows: WorkflowInfo[] = [registered];
    let fingerprint = "v1";
    const inspectManifestName = vi
      .fn<() => Promise<ManifestNameInspection>>()
      .mockResolvedValueOnce({ status: "found", name: "Before" })
      .mockResolvedValueOnce({ status: "found", name: "After" });
    const changed = vi.fn();
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => workflows,
      inspectManifestName,
      fingerprintSource: async () => fingerprint,
      onIdentityChange: changed,
    });
    await enrich(inventory, await inventory.listAgents(SCOPE), changed);

    workflows = [];
    expect((await inventory.listAgents(SCOPE)).inventory.agents).toEqual([]);
    fingerprint = "v2";
    workflows = [registered];
    changed.mockClear();
    const readded = await inventory.listAgents(SCOPE);
    expect(readded.inventory.agents[0]?.agentKey).toBe("marker");
    readded.startEnrichment?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(
      (await inventory.listAgents(SCOPE)).inventory.agents[0]?.agentKey,
    ).toBe("After");
  });

  it("computes an order- and checkout-invariant revision without private metadata", async () => {
    const left = provider([
      workflow("Zeta label", "zeta", "zeta", { definitionId: 1 }),
      workflow("Alpha label", "alpha", "alpha", { definitionId: 2 }),
    ]);
    const otherRoot = "/different/checkout";
    const right = provider([
      {
        ...workflow("Private label changed", "alpha", "alpha", {
          definitionId: 999,
        }),
        path: `${otherRoot}/alpha`,
      },
      {
        ...workflow("Other private label", "zeta", "zeta", {
          definitionId: null,
        }),
        path: `${otherRoot}/zeta`,
      },
    ]);

    const leftResult = await left.listAgents(SCOPE);
    const rightResult = await right.listAgents({
      workspaceKey: SCOPE.workspaceKey,
      root: otherRoot,
    });
    expect(leftResult.inventory.agents.map((agent) => agent.agentKey)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(leftResult.inventory.version).toEqual(rightResult.inventory.version);
  });

  it("uses a checkout-invariant local identity for a markerless root agent", async () => {
    const otherRoot = "/different/checkout";
    const left = await provider([
      workflow("Left checkout", "", null),
    ]).listAgents(SCOPE);
    const right = await provider([
      {
        ...workflow("Right checkout", "", null),
        path: otherRoot,
      },
    ]).listAgents({ workspaceKey: SCOPE.workspaceKey, root: otherRoot });

    expect(left.inventory.agents).toEqual([
      expect.objectContaining({ agentKey: "local:root", path: "." }),
    ]);
    expect(left.inventory.version).toEqual(right.inventory.version);
  });

  it("resolves colliding local fallbacks without canonical duplicate metadata", async () => {
    const workflows = [
      workflow("Package root", "", null),
      workflow("Root child", "root", null),
      workflow("Suffix child", "root~2", null),
    ];
    const forward = await provider(workflows).listAgents(SCOPE);
    const reversed = await provider([...workflows].reverse()).listAgents(SCOPE);

    expect(forward.inventory).toEqual(reversed.inventory);
    expect(forward.inventory.agents).toEqual([
      expect.objectContaining({
        agentKey: "local:root",
        identityIssue: "identity-unavailable",
        path: ".",
      }),
      expect.objectContaining({
        agentKey: "local:root~2",
        identityIssue: "identity-unavailable",
        path: "root",
      }),
      expect.objectContaining({
        agentKey: "local:root~2~2",
        identityIssue: "identity-unavailable",
        path: "root~2",
      }),
    ]);
    expect(forward.warnings).toEqual([]);
    expect(
      forward.inventory.agents.every(
        (agent) => agent.identityIssue !== "duplicate-agent-key",
      ),
    ).toBe(true);
  });

  it("deduplicates exact registry roots independently of registry order", async () => {
    const alpha = workflow("Alpha", "agent", "alpha", { definitionId: 1 });
    const zeta = workflow("Zeta", "agent", "zeta", { definitionId: 2 });
    const forward = await provider([zeta, alpha]).listAgents(SCOPE);
    const reversed = await provider([alpha, zeta]).listAgents(SCOPE);

    expect(forward.inventory).toEqual(reversed.inventory);
    expect(forward.inventory.agents).toEqual([
      expect.objectContaining({ agentKey: "alpha", path: "agent" }),
    ]);
    expect(forward.inventory.version).toEqual(reversed.inventory.version);
  });

  it("includes nested agents in every containing selected project", async () => {
    const workflows = [
      workflow("Root", "", "root"),
      workflow("Parent", "research", "research"),
      workflow("Nested", "experiments/evaluator", "evaluator"),
      {
        ...workflow("Outside", "outside", "outside"),
        path: `${WORKSPACE}-old/outside`,
      },
    ];
    const parent = await provider(workflows).listAgents(SCOPE);
    const nested = await provider(workflows).listAgents({
      workspaceKey: "workspace-experiments",
      root: `${WORKSPACE}/experiments`,
    });

    expect(parent.inventory.agents.map((agent) => agent.path)).toEqual([
      "experiments/evaluator",
      "research",
      ".",
    ]);
    expect(nested.inventory.agents.map((agent) => agent.path)).toEqual([
      "evaluator",
    ]);
  });

  it("matches canonical workflow roots beneath a symlinked workspace", async () => {
    if (process.platform === "win32") return;
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "inventory-symlink-"),
    );
    try {
      const workspaceRoot = path.join(tempRoot, "real-workspace");
      const agentRoot = path.join(workspaceRoot, "agent");
      const nestedRoot = path.join(agentRoot, "nested-agent");
      const outsideRoot = path.join(tempRoot, "outside", "agent");
      const linkedRoot = path.join(tempRoot, "linked-workspace");
      await Promise.all([
        fs.mkdir(nestedRoot, { recursive: true }),
        fs.mkdir(outsideRoot, { recursive: true }),
      ]);
      await fs.symlink(workspaceRoot, linkedRoot, "dir");

      expect(
        graphSourceRootsWithinScope(linkedRoot, [
          agentRoot,
          nestedRoot,
          outsideRoot,
        ]),
      ).toEqual([await fs.realpath(agentRoot), await fs.realpath(nestedRoot)]);
      expect(
        dirtyGraphSourceRoots(
          linkedRoot,
          [agentRoot, nestedRoot],
          [path.join(linkedRoot, "agent", "nested-agent", "index.ts")],
        ),
      ).toEqual([await fs.realpath(nestedRoot)]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails the provider call when the registry snapshot cannot be read", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: async () => {
        throw new Error("registry unavailable");
      },
    });
    await expect(inventory.listAgents(SCOPE)).rejects.toThrow(
      "registry unavailable",
    );
  });
});
