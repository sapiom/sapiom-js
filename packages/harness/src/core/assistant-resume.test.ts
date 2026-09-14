import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import { AssistantSessionStore, type AssistantAssociation } from "./assistant-session-store.js";
import type { HostedOpenCode } from "./opencode-host.js";

const id = "studio-a", operation = "f1872aaa-b7c0-44f1-a9bc-3f9613b4a52c";
const otherOperation = "ac243472-d1ef-4926-bf47-2a32bd28e912";
const binding: AssistantAssociation = {
  version: 1, harnessSessionId: id, cwd: "/workspace", conversationId: "ses_saved",
  contextAuthorityScope: "a".repeat(64), nativeScope: "b".repeat(64), createdAt: 1,
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
};
let root: string, store: AssistantSessionStore, coordinator: AssistantLifecycleCoordinator;
const hosts = new Map<string, HostedOpenCode>(), lifetimes = new WeakMap<HostedOpenCode, AbortController>();
const ensure = vi.fn(), observe = vi.fn(), associate = vi.fn(), retire = vi.fn(), retireExact = vi.fn();
const assertCurrent = vi.fn(), canAttach = vi.fn(), authorize = vi.fn(), read = vi.fn();
const preparation = { authorize, read };
const fixture = (resumeTimeoutMs = 15_000) => new AssistantLifecycleCoordinator({
  store, canAttach, resumeTimeoutMs, associations: { ensure: associate },
  host: {
    ensure, observe, assertCurrent, current: (key) => hosts.get(key) ?? null,
    retireWithResult: retire, retireExact, beginShutdown: () => {
      for (const key of hosts.keys()) void retire(key);
    },
  },
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-resume-"));
  store = new AssistantSessionStore(root);
  await store.transition(id, 0, { lifecycle: "ended", execution: "paused" });
  hosts.clear();
  ensure.mockReset().mockImplementation(async (key: string) => {
    if (hosts.has(key)) return hosts.get(key)!;
    const lifetime = new AbortController();
    const hosted: HostedOpenCode = {
      harnessSessionId: key, cwd: binding.cwd, stateRoot: join(root, binding.nativeScope),
      contextAuthorityScope: binding.contextAuthorityScope, model: { providerID: "sapiom", modelID: "test" },
      signal: lifetime.signal, isCurrent: () => hosts.get(key) === hosted && !lifetime.signal.aborted,
      server: { pid: 1, exited: new Promise(() => {}), close: vi.fn(), fetch: vi.fn(), fetchJson: vi.fn() },
    };
    hosts.set(key, hosted); lifetimes.set(hosted, lifetime); return hosted;
  });
  observe.mockReset();
  associate.mockReset().mockResolvedValue(binding.conversationId);
  retire.mockReset().mockImplementation(async (key: string) => {
    const hosted = hosts.get(key);
    if (hosted) { lifetimes.get(hosted)!.abort(); hosts.delete(key); }
    return { state: hosted ? "confirmed" : "absent" };
  });
  retireExact.mockReset().mockImplementation(async (hosted: HostedOpenCode) => {
    if (hosts.get(hosted.harnessSessionId) === hosted) await retire(hosted.harnessSessionId);
  });
  assertCurrent.mockReset().mockImplementation(async (hosted: HostedOpenCode) => {
    if (!hosted.isCurrent()) throw new Error("not current");
  });
  canAttach.mockReset().mockResolvedValue(true);
  authorize.mockReset().mockImplementation(async () => ({ ...binding }));
  read.mockReset().mockResolvedValue(undefined);
  coordinator = fixture();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const hosted of hosts.values()) lifetimes.get(hosted)?.abort();
  await rm(root, { recursive: true, force: true });
});
const resume = (expected = 1, op = operation) => coordinator.resume(id, expected, op, preparation);
async function live() {
  await store.transition(id, 1, { lifecycle: "open", execution: "paused" });
  const lease = await coordinator.attach(id, 2);
  await coordinator.enable(hosts.get(id)!);
  return { ...lease, lifecycle: (await coordinator.describe(id)) };
}

it("resumes the exact saved native session paused without association creation or affecting same-folder B", async () => {
  const b = await coordinator.attach("studio-b", 0), other = hosts.get("studio-b");
  associate.mockClear(); observe.mockClear();
  const attached = await resume();
  expect(attached).toMatchObject({ conversationId: binding.conversationId, lifecycle: { harnessSessionId: id, revision: 2, lifecycle: "open", execution: "paused" } });
  expect(associate).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledExactlyOnceWith(hosts.get(id), binding.conversationId);
  expect(read).toHaveBeenCalledExactlyOnceWith(hosts.get(id), binding, expect.any(AbortSignal));
  expect(await coordinator.attach(id, 2)).toEqual(attached);
  await expect(coordinator.use(id, attached.lease, true)).rejects.toMatchObject({ failure: { code: "execution_paused" } });
  expect(hosts.get("studio-b")).toBe(other);
  expect((await coordinator.use("studio-b", b.lease)).hosted).toBe(other);
});

it("coalesces pending operation retries and excludes Attach, inspection, Continue and competing Resume", async () => {
  const held = gate();
  read.mockImplementationOnce(() => held.promise);
  const first = resume();
  expect(resume()).toBe(first);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await expect(resume(1, otherOperation)).rejects.toThrow();
  await expect(coordinator.attach(id, 1)).rejects.toThrow();
  await expect(coordinator.inspect(id, 1, vi.fn())).rejects.toThrow();
  await expect(coordinator.prepareContinuation(id, 1, vi.fn())).rejects.toThrow();
  held.release();
  const attached = await first;
  expect(await resume()).toEqual(attached);
  expect(ensure).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledOnce();
  expect((await store.lifecycle(id))?.revision).toBe(2);
});

it("preserves an enabled exact live lease while execution waits across durable Resume publication", async () => {
  const attached = await live(), hosted = hosts.get(id)!;
  const published = gate(), release = gate(), commit = store.commitResume.bind(store);
  vi.spyOn(store, "commitResume").mockImplementationOnce(async (...args) => {
    const state = await commit(...args); published.release(); await release.promise; return state;
  });
  const resumed = resume(attached.lifecycle.revision);
  await published.promise;
  const executing = coordinator.use(id, attached.lease, true);
  let settled = false; void executing.then(() => { settled = true; });
  await new Promise((done) => setTimeout(done, 5));
  expect(settled).toBe(false);
  expect(hosted.signal.aborted).toBe(false);
  release.release();
  expect(await resumed).toMatchObject({ lease: attached.lease, lifecycle: { revision: 5, execution: "enabled" } });
  expect((await executing).hosted).toBe(hosted);
  expect(observe).toHaveBeenCalledOnce();
});

it("re-reads an old in-flight durable snapshot after the same live lease advances", async () => {
  const attached = await live(), held = gate(), readStarted = gate();
  const lifecycle = store.lifecycle.bind(store);
  vi.spyOn(store, "lifecycle").mockImplementationOnce(async (key) => {
    const snapshot = await lifecycle(key); readStarted.release(); await held.promise; return snapshot;
  });
  const executing = coordinator.use(id, attached.lease, true);
  await readStarted.promise;
  await resume(attached.lifecycle.revision);
  held.release();
  expect((await executing).lease).toBe(attached.lease);
});

it("preserves a live lease when Resume overlaps an enable whose durable write already published", async () => {
  await store.transition(id, 1, { lifecycle: "open", execution: "paused" });
  const attached = await coordinator.attach(id, 2), held = gate(), published = gate();
  const transition = store.transition.bind(store);
  vi.spyOn(store, "transition").mockImplementationOnce(async (...args) => {
    const state = await transition(...args); published.release(); await held.promise; return state;
  });
  const enabling = coordinator.enable(hosts.get(id)!);
  await published.promise;
  const resumed = resume(4);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  held.release(); await enabling;
  expect(await resumed).toMatchObject({ lease: attached.lease, lifecycle: { revision: 5, execution: "enabled" } });
  await expect(coordinator.use(id, attached.lease, true)).resolves.toBeDefined();
});

it("reconciles the same operation after host restart with a new paused lease and proved revision", async () => {
  const first = await resume();
  await retire(id); coordinator = fixture();
  const next = await resume();
  expect(next.lease).not.toBe(first.lease);
  expect(next).toMatchObject({ conversationId: binding.conversationId, lifecycle: { revision: 3, execution: "paused" } });
  await expect(coordinator.use(id, first.lease)).rejects.toThrow();
  expect(associate).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
});

it("recovers a durable commit whose caller failed before its lease was granted", async () => {
  const commit = store.commitResume.bind(store);
  vi.spyOn(store, "commitResume").mockImplementationOnce(async (...args) => {
    await commit(...args); throw new Error("lost acknowledgement");
  });
  await expect(resume()).rejects.toThrow("lost acknowledgement");
  expect(hosts.get(id)).toBeUndefined();
  coordinator = fixture();
  expect(await resume()).toMatchObject({ lifecycle: { revision: 3, execution: "paused" } });
  expect(associate).not.toHaveBeenCalled();
});

it.each(["enable", "End", "binding"])("rejects an old operation after later %s without reopening", async (changed) => {
  await resume();
  if (changed === "enable") await coordinator.enable(hosts.get(id)!);
  if (changed === "End") {
    const ending = coordinator.beginEnd(id); await ending.persistence; await coordinator.finishEnd(ending.fence);
  }
  if (changed === "binding") authorize.mockResolvedValue({ ...binding, createdAt: 2 });
  const before = await store.resumeState(id);
  await expect(resume()).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  expect(await store.resumeState(id)).toEqual(before);
  expect(ensure).toHaveBeenCalledOnce();
});

it("denies pending Continue children before runtime startup", async () => {
  canAttach.mockResolvedValue(false);
  await expect(resume()).rejects.toThrow();
  expect(ensure).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(await store.lifecycle(id)).toMatchObject({ lifecycle: "ended", revision: 1 });
});

it("keeps lifecycle and prior history unchanged when native preflight fails", async () => {
  read.mockRejectedValueOnce(new Error("retained context unavailable"));
  const before = await store.resumeState(id);
  await expect(resume()).rejects.toThrow("retained context unavailable");
  expect(await store.resumeState(id)).toEqual(before);
  expect(hosts.get(id)).toBeUndefined();
  expect(retireExact).toHaveBeenCalledOnce();
  expect(associate).not.toHaveBeenCalled();
});

it.each(["authorization", "startup", "preflight", "before-commit", "after-commit"])("End preempts %s and late completion cannot reopen or retire a replacement", async (stage) => {
  const held = gate(), reached = gate();
  const hold = async () => { reached.release(); await held.promise; };
  if (stage === "authorization") authorize.mockImplementationOnce(async () => { await hold(); return { ...binding }; });
  if (stage === "startup") {
    const start = ensure.getMockImplementation()!;
    ensure.mockImplementationOnce(async (...args) => { const hosted = await start(...args); await hold(); return hosted; });
  }
  if (stage === "preflight") read.mockImplementationOnce(hold);
  if (stage.endsWith("commit")) {
    const commit = store.commitResume.bind(store);
    vi.spyOn(store, "commitResume").mockImplementationOnce(async (...args) => {
      if (stage === "before-commit") await hold();
      const state = await commit(...args);
      if (stage === "after-commit") await hold();
      return state;
    });
  }
  const old = resume(), rejected = expect(old).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  await reached.promise;
  const ending = coordinator.beginEnd(id);
  expect(hosts.get(id)).toBeUndefined();
  if (!stage.endsWith("commit")) await rejected;
  await ending.persistence;
  const ended = await coordinator.finishEnd(ending.fence);
  const next = await resume(ended.revision, otherOperation), replacement = hosts.get(id)!;
  held.release(); await rejected;
  await new Promise((done) => setTimeout(done, 5));
  expect(hosts.get(id)).toBe(replacement);
  expect(replacement.signal.aborted).toBe(false);
  expect((await coordinator.use(id, next.lease)).hosted).toBe(replacement);
});

it("bounds startup before any host exists and truthfully reports failed cleanup", async () => {
  vi.useFakeTimers(); coordinator = fixture(50);
  vi.spyOn(store, "resumeState").mockResolvedValue({ lifecycle: { version: 1, harnessSessionId: id, revision: 1, lifecycle: "ended", execution: "paused", updatedAt: 1 }, resumeOperation: null });
  ensure.mockImplementationOnce(() => new Promise(() => {}));
  const pending = resume(), rejected = expect(pending).rejects.toMatchObject({ failure: { code: "transport_unavailable" } });
  await vi.advanceTimersByTimeAsync(50); await rejected;
  expect(retire).toHaveBeenCalledExactlyOnceWith(id, 750);
  retireExact.mockRejectedValueOnce(new Error("unconfirmed"));
  read.mockRejectedValueOnce(new Error("failed preflight"));
  await expect(resume()).rejects.toMatchObject({ failure: { code: "cleanup_unconfirmed" } });
});

it("a timed-out live preflight preserves the enabled lease and runtime", async () => {
  coordinator = fixture(50);
  const attached = await live(), hosted = hosts.get(id)!;
  read.mockImplementationOnce(() => new Promise(() => {}));
  await expect(resume(attached.lifecycle.revision)).rejects.toMatchObject({ failure: { code: "transport_unavailable" } });
  expect(hosts.get(id)).toBe(hosted);
  expect((await coordinator.use(id, attached.lease, true)).hosted).toBe(hosted);
  expect(retire).not.toHaveBeenCalled();
});

it("cancellation keeps the live publication barrier and operation slot until exact durable IO settles", async () => {
  const cancellation = new AbortController();
  const attached = await live(), held = gate(), published = gate(), commit = store.commitResume.bind(store);
  vi.spyOn(store, "commitResume").mockImplementationOnce(async (...args) => {
    const state = await commit(...args); published.release(); await held.promise; return state;
  });
  const resumed = coordinator.resume(id, attached.lifecycle.revision, operation, preparation, cancellation.signal);
  const rejected = expect(resumed).rejects.toThrow("cancelled request");
  let settled = false; void resumed.then(() => { settled = true; }, () => { settled = true; });
  await published.promise;
  cancellation.abort(new Error("cancelled request"));
  await new Promise((done) => setTimeout(done, 5));
  expect(settled).toBe(false);
  await expect(coordinator.inspect(id, 5, vi.fn())).rejects.toThrow();
  await expect(resume(5, otherOperation)).rejects.toThrow();
  const executing = coordinator.use(id, attached.lease, true);
  let executionSettled = false; void executing.then(() => { executionSettled = true; }, () => { executionSettled = true; });
  const fenced = expect(executing).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  await new Promise((done) => setTimeout(done, 5));
  expect(executionSettled).toBe(false);
  expect(hosts.get(id)?.signal.aborted).toBe(false);
  held.release(); await rejected; await fenced;
  const recovered = await resume(attached.lifecycle.revision);
  expect(recovered).toMatchObject({ lifecycle: { revision: 6, execution: "paused" } });
  expect(recovered.lease).not.toBe(attached.lease);
});
