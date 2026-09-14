import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import type { AssistantSessionStore } from "./assistant-session-store.js";
import type { HostedOpenCode } from "./opencode-host.js";

// Lifecycle imports node:timers directly; route it through the fake clock too.
vi.mock("node:timers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers")>()),
  setTimeout: (callback: () => void, ms?: number) =>
    globalThis.setTimeout(callback, ms),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
    globalThis.clearTimeout(timer),
}));

const id = "studio-child";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const fixture = (
  timeouts: {
    inspectionTimeoutMs?: number;
    continuationTimeoutMs?: number;
  } = {},
) => {
  let current: HostedOpenCode | null = null;
  let saved: AssistantLifecycle | null = null;
  const controllers = new WeakMap<HostedOpenCode, AbortController>();
  const createHost = (): HostedOpenCode => {
    const controller = new AbortController();
    const hosted: HostedOpenCode = {
      harnessSessionId: id,
      cwd: "/workspace",
      stateRoot: "/private/native",
      contextAuthorityScope: "a".repeat(64),
      model: { providerID: "sapiom", modelID: "fixture" },
      signal: controller.signal,
      isCurrent: () => current === hosted && !controller.signal.aborted,
      server: {
        pid: 123,
        exited: new Promise(() => {}),
        close: async () => {},
        fetch: vi.fn(),
        fetchJson: vi.fn(),
      },
    };
    controllers.set(hosted, controller);
    return hosted;
  };
  const publish = () => (current = createHost());
  const retireExact = vi.fn(async (hosted: HostedOpenCode) => {
    controllers.get(hosted)!.abort();
    if (current === hosted) current = null;
  });
  const retireWithResult = vi.fn(async () => {
    if (!current) return { state: "absent" as const };
    await retireExact(current);
    return { state: "confirmed" as const };
  });
  const ensure = vi.fn(async () => current ?? publish());
  const associate = vi.fn(),
    observe = vi.fn();
  const store: Pick<AssistantSessionStore, "lifecycle" | "transition"> = {
    lifecycle: vi.fn(async () => saved),
    transition: vi.fn<AssistantSessionStore["transition"]>(
      async (sessionId, revision, next) => {
        saved = {
          version: 1,
          harnessSessionId: sessionId,
          revision: revision + 1,
          ...next,
          updatedAt: Date.now(),
        };
        return saved;
      },
    ),
  };
  const coordinator = new AssistantLifecycleCoordinator({
    ...timeouts,
    store,
    associations: { ensure: associate },
    host: {
      current: () => current,
      ensure,
      assertCurrent: async (hosted) => {
        if (!hosted.isCurrent()) throw new Error("stale runtime");
      },
      retireExact,
      retireWithResult,
      observe,
      beginShutdown: () => {
        void retireWithResult();
      },
    },
  });
  return {
    coordinator,
    ensure,
    retireExact,
    retireWithResult,
    store,
    associate,
    observe,
    createHost,
    publish,
    current: () => current,
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("allows cold startup and frozen input preparation to share the 45 second Continue budget", async () => {
  const f = fixture();
  f.ensure.mockImplementationOnce(async () => {
    await delay(20_000);
    return f.publish();
  });
  const prepare = vi.fn(async () => {
    await delay(20_000);
    return "prepared";
  });
  const failed = vi.fn();
  const pending = f.coordinator.prepareContinuation(id, 0, prepare);
  void pending.catch(failed);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(failed).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(f.retireWithResult).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  const hosted = f.current()!;
  expect(prepare).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toBe("prepared");
  expect(f.current()).toBe(hosted);
  expect(hosted.signal.aborted).toBe(false);
  expect(f.retireExact).not.toHaveBeenCalled();
  expect(f.associate).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.store.transition).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("expires Continue at 45 seconds total across startup and a hung native preparation", async () => {
  const f = fixture();
  f.ensure.mockImplementationOnce(async () => {
    await delay(20_000);
    return f.publish();
  });
  const prepare = vi.fn(() => new Promise<void>(() => {}));
  const pending = f.coordinator.prepareContinuation(id, 0, prepare);
  const rejected = expect(pending).rejects.toMatchObject({
    failure: { code: "transport_unavailable" },
  });
  await vi.advanceTimersByTimeAsync(20_000);
  const hosted = f.current()!;
  expect(prepare).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(24_999);
  expect(hosted.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(f.retireExact).toHaveBeenCalledExactlyOnceWith(hosted);
  expect(f.current()).toBeNull();
  expect(f.associate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("fences pending Continue startup at 45 seconds and retires a late exact host without touching its replacement", async () => {
  const f = fixture(),
    late = f.createHost();
  let release!: (hosted: HostedOpenCode) => void;
  f.ensure.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const prepare = vi.fn();
  const pending = f.coordinator.prepareContinuation(id, 0, prepare);
  const rejected = expect(pending).rejects.toMatchObject({
    failure: { code: "transport_unavailable" },
  });
  await vi.advanceTimersByTimeAsync(44_999);
  expect(f.retireWithResult).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(f.retireWithResult).toHaveBeenCalledExactlyOnceWith(id, 750);
  expect(prepare).not.toHaveBeenCalled();
  await f.coordinator.prepareContinuation(id, 0, async () => "retried");
  const replacement = f.current()!;
  release(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.retireExact).toHaveBeenCalledExactlyOnceWith(late);
  expect(late.signal.aborted).toBe(true);
  expect(replacement.signal.aborted).toBe(false);
  expect(f.current()).toBe(replacement);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { mode: "inspect" as const, deadline: 15_000, options: {} },
  {
    mode: "inspect" as const,
    deadline: 25,
    options: { inspectionTimeoutMs: 25, continuationTimeoutMs: 125 },
  },
  {
    mode: "prepareContinuation" as const,
    deadline: 125,
    options: { inspectionTimeoutMs: 25, continuationTimeoutMs: 125 },
  },
])(
  "uses the independent $mode deadline of $deadline ms",
  async ({ mode, deadline, options }) => {
    const f = fixture(options);
    const pending = f.coordinator[mode](
      id,
      0,
      () => new Promise<void>(() => {}),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      failure: { code: "transport_unavailable" },
    });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    const hosted = f.current()!;
    expect(hosted.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.retireExact).toHaveBeenCalledExactlyOnceWith(hosted);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("End aborts prolonged Continue preparation immediately without advancing its deadline", async () => {
  const f = fixture();
  const pending = f.coordinator.prepareContinuation(
    id,
    0,
    () => new Promise<void>(() => {}),
  );
  const rejected = expect(pending).rejects.toMatchObject({
    failure: { code: "lifecycle_changed" },
  });
  await vi.advanceTimersByTimeAsync(20_000);
  const hosted = f.current()!,
    now = Date.now();
  const ending = f.coordinator.beginEnd(id);
  expect(hosted.signal.aborted).toBe(true);
  expect(f.retireWithResult).toHaveBeenCalledExactlyOnceWith(id);
  await rejected;
  await ending.native;
  await ending.persistence;
  expect(Date.now()).toBe(now);
  expect((await f.coordinator.finishEnd(ending.fence)).lifecycle).toBe("ended");
  expect(f.associate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a shorter caller deadline and cleans up its exact provisional runtime", async () => {
  const f = fixture(),
    caller = new AbortController();
  const pending = f.coordinator.prepareContinuation(
    id,
    0,
    () => new Promise<void>(() => {}),
    caller.signal,
  );
  const reason = new Error("outer Continue deadline");
  const rejected = expect(pending).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(10_000);
  const hosted = f.current()!;
  caller.abort(reason);
  await rejected;
  expect(f.retireExact).toHaveBeenCalledExactlyOnceWith(hosted);
  expect(vi.getTimerCount()).toBe(0);
});
