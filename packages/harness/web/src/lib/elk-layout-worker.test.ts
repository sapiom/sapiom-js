import { expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { ElkLayoutWorker } from "./elk-layout-worker";

class WorkerDouble {
  onmessage?: (event: { data: unknown }) => void;
  listeners = new Map<string, () => void>();
  jobs: { id: number; graph: ElkNode }[] = [];
  terminate = vi.fn();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  respond(id: number, data: unknown) {
    this.onmessage?.({ data: { id, data } });
  }
  postMessage(message: { id: number; cmd: string; graph: ElkNode }) {
    if (message.cmd === "register")
      queueMicrotask(() => this.respond(message.id, {}));
    else this.jobs.push(message);
  }
  complete(index = 0) {
    const { id, graph } = this.jobs[index]!;
    this.respond(id, {
      ...graph,
      width: 200,
      height: 100,
      children: graph.children!.map((node) => ({ ...node, x: 1, y: 2 })),
    });
  }
}
const input = {
  id: "project/proposal",
  nodes: [{ id: "node", width: 184, height: 72 }],
  edges: [],
};
const run = (client: ElkLayoutWorker, id = input.id) =>
  client.layout({ ...input, id }, new AbortController().signal);
const setup = (timeout?: number) => {
  const workers: WorkerDouble[] = [];
  const client = new ElkLayoutWorker(() => {
    const worker = new WorkerDouble();
    workers.push(worker);
    return worker as unknown as Worker;
  }, timeout);
  return { workers, client };
};

it("lazily reuses its worker and rejects obsolete responses after cancellation", async () => {
  const { client, workers } = setup();
  const first = client.layout(input, new AbortController().signal);
  await vi.waitFor(() => expect(workers[0]?.jobs).toHaveLength(1));
  workers[0]!.complete();
  await first;
  const controller = new AbortController(),
    obsolete = client.layout(input, controller.signal);
  const rejected = expect(obsolete).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(workers[0]?.jobs).toHaveLength(2));
  controller.abort();
  await rejected;
  const next = run(client, "next-project/proposal");
  await vi.waitFor(() => expect(workers[1]?.jobs).toHaveLength(1));
  workers[0]!.complete(1);
  workers[0]!.listeners.get("error")?.();
  workers[1]!.complete();
  expect((await next).nodes).toHaveLength(1);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  client.dispose();
  expect(workers[1]!.terminate).toHaveBeenCalledOnce();
});

it("terminates on worker failure, invalid results, timeout and disposal, then recovers", async () => {
  const { client, workers } = setup(150);
  const error = client.layout(input, new AbortController().signal),
    rejected = expect(error).rejects.toThrow("worker failed");
  await vi.waitFor(() => expect(workers[0]?.jobs).toHaveLength(1));
  workers[0]!.listeners.get("error")!();
  await rejected;
  const invalid = client.layout(input, new AbortController().signal),
    bad = expect(invalid).rejects.toThrow("Invalid ELK");
  await vi.waitFor(() => expect(workers[1]?.jobs).toHaveLength(1));
  workers[1]!.jobs[0]!.graph.children = [];
  workers[1]!.complete();
  await bad;
  await expect(run(client)).rejects.toThrow("timed out");
  const last = client.layout(input, new AbortController().signal),
    disposed = expect(last).rejects.toThrow("disposed");
  client.dispose();
  await disposed;
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
});

it("terminates workers after constructor and idle failures without affecting their replacements", async () => {
  const broken = new WorkerDouble(),
    healthy = new WorkerDouble();
  Object.defineProperty(broken, "postMessage", { value: undefined });
  const factory = vi.fn().mockReturnValueOnce(broken).mockReturnValue(healthy);
  const client = new ElkLayoutWorker(factory);
  await expect(run(client)).rejects.toThrow("required 'postMessage'");
  expect(client.stage).toBe("Worker construction");
  expect(broken.terminate).toHaveBeenCalledOnce();
  const next = client.layout(input, new AbortController().signal);
  await vi.waitFor(() => expect(healthy.jobs).toHaveLength(1));
  broken.listeners.get("error")?.();
  healthy.complete();
  await next;
  healthy.listeners.get("messageerror")?.();
  expect(healthy.terminate).toHaveBeenCalledOnce();
  client.dispose();
  expect(healthy.terminate).toHaveBeenCalledOnce();
});
