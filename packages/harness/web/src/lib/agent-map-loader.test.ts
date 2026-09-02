import { describe, expect, it, vi } from "vitest";

import { createAgentMapLoader } from "./agent-map-loader";
import { proposalSnapshot, renameDelta } from "./agent-map-projector.test";

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
    expect(loader.accept(renameDelta()).status).toBe("queued");
    pending.resolve(proposalSnapshot());
    await expect(first).resolves.toMatchObject({ proposal: { version: 2 } });
    expect(source.getAgentMapWorkspace).toHaveBeenCalledTimes(1);
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
});
