import { describe, expect, it, vi } from "vitest";

import { createAgentMapLoader } from "./agent-map-loader";
import { proposalSnapshot, renameDelta } from "./agent-map-test-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe("createAgentMapLoader", () => {
  it("coalesces reads and folds a contiguous event racing initial load", async () => {
    const pending = deferred<ReturnType<typeof proposalSnapshot>>();
    const source = { getAgentMapWorkspace: vi.fn(() => pending.promise) };
    const loader = createAgentMapLoader();
    const projectId = proposalSnapshot().project.projectId;
    const first = loader.load(source, projectId);
    expect(loader.load(source, projectId)).toBe(first);
    const delta = renameDelta();
    expect(loader.accept(delta).status).toBe("queued");
    pending.resolve(proposalSnapshot());
    const result = await first;
    expect(result).toMatchObject({ proposal: { version: 2 } });
    expect(loader.includesQueuedProjection(result, delta)).toBe(true);
    expect(source.getAgentMapWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not label a recovery GET as a queued live projection", async () => {
    const initial = proposalSnapshot();
    const delta = renameDelta(4);
    const recovered = structuredClone(initial);
    if (!recovered.proposal) throw new Error("fixture requires a proposal");
    recovered.proposal.version = delta.version;
    recovered.proposal.history.push({
      id: delta.operationIds[0]!,
      requestId: "durable-recovery",
      acceptedVersion: delta.version,
      operation: delta.operations[0]!,
      actor: delta.actor,
      acceptedAt: delta.acceptedAt,
    });
    const source = {
      getAgentMapWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(recovered),
    };
    const loader = createAgentMapLoader();
    const projectId = initial.project.projectId;
    const load = loader.load(source, projectId);
    expect(loader.accept(delta).status).toBe("queued");

    const result = await load;
    expect(result.proposal).toMatchObject({
      id: delta.proposalId,
      version: delta.version,
    });
    expect(result.proposal?.history.map(({ id }) => id)).toContain(
      delta.operationIds[0],
    );
    expect(loader.includesQueuedProjection(result, delta)).toBe(false);
    expect(source.getAgentMapWorkspace).toHaveBeenCalledTimes(2);
  });

  it("discards browser state and asks for durable recovery on a version gap", async () => {
    const source = {
      getAgentMapWorkspace: vi.fn(async () => proposalSnapshot()),
    };
    const loader = createAgentMapLoader();
    const projectId = proposalSnapshot().project.projectId;
    await loader.load(source, projectId);
    expect(loader.accept(renameDelta(4)).status).toBe("needs-refetch");
    expect(loader.peek(projectId)).toBeNull();
  });

  it("updates a foreign project cache without changing the active project and evicts removed projects", async () => {
    const activeProjectId = proposalSnapshot().project.projectId;
    const foreignProjectId = "project_00000000-0000-4000-8000-000000000002";
    const source = {
      getAgentMapWorkspace: vi.fn(async (projectId: string) =>
        proposalSnapshot(projectId),
      ),
    };
    const loader = createAgentMapLoader();
    expect(loader.accept(renameDelta(1, foreignProjectId)).status).toBe(
      "needs-refetch",
    );
    await loader.load(source, activeProjectId);
    await loader.load(source, foreignProjectId);

    expect(loader.accept(renameDelta(1, foreignProjectId)).status).toBe(
      "applied",
    );
    expect(loader.peek(activeProjectId)?.proposal?.version).toBe(1);
    expect(loader.peek(foreignProjectId)?.proposal?.version).toBe(2);

    loader.retain(new Set([activeProjectId]));
    expect(loader.peek(activeProjectId)).not.toBeNull();
    expect(loader.peek(foreignProjectId)).toBeNull();
  });

  it("does not resurrect a project evicted during an in-flight read", async () => {
    const pending = deferred<ReturnType<typeof proposalSnapshot>>();
    const source = { getAgentMapWorkspace: vi.fn(() => pending.promise) };
    const loader = createAgentMapLoader();
    const projectId = proposalSnapshot().project.projectId;
    loader.invalidate(projectId);
    const load = loader.load(source, projectId);

    loader.retain(new Set());
    pending.resolve(proposalSnapshot());

    await expect(load).resolves.toMatchObject({ project: { projectId } });
    expect(source.getAgentMapWorkspace).toHaveBeenCalledTimes(1);
    expect(loader.peek(projectId)).toBeNull();
  });
});
