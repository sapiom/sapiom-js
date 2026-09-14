import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import { AssistantSessionStore } from "./assistant-session-store.js";
import type { HostedOpenCode } from "./opencode-host.js";

let root: string;
let store: AssistantSessionStore;
let coordinator: AssistantLifecycleCoordinator;
let current: HostedOpenCode | null;
let abort: AbortController;
let eligible: boolean;
const ensure = vi.fn(),
  observe = vi.fn(),
  associate = vi.fn();
const retire = vi.fn(),
  assertCurrent = vi.fn();
const canAttach = vi.fn();
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
};
const fixture = (inspectionTimeoutMs?: number) =>
  new AssistantLifecycleCoordinator({
    inspectionTimeoutMs,
    canAttach,
    store,
    associations: { ensure: associate },
    host: {
      ensure,
      observe,
      assertCurrent,
      current: () => (current?.isCurrent() ? current : null),
      retireWithResult: retire,
      retireExact: async (hosted) => {
        if (current === hosted) await retire();
      },
      beginShutdown: () => {
        void retire();
      },
    },
  });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-lifecycle-"));
  store = new AssistantSessionStore(root);
  current = null;
  eligible = true;
  canAttach.mockReset().mockResolvedValue(true);
  observe.mockReset();
  ensure.mockReset().mockImplementation(async (id) => {
    if (!eligible) throw new Error("access denied");
    if (current?.isCurrent()) return current;
    abort = new AbortController();
    const signal = abort.signal;
    const hosted: HostedOpenCode = {
      harnessSessionId: id,
      cwd: root,
      stateRoot: join(root, "native"),
      contextAuthorityScope: "a".repeat(64),
      model: { providerID: "sapiom", modelID: "fixture" },
      signal,
      isCurrent: () => eligible && !signal.aborted && current === hosted,
      server: {
        pid: 123,
        exited: new Promise(() => {}),
        close: async () => {},
        fetch: vi.fn(),
        fetchJson: vi.fn(),
      },
    };
    current = hosted;
    return hosted;
  });
  assertCurrent.mockReset().mockImplementation(async (hosted) => {
    if (!hosted.isCurrent()) throw new Error("not current");
  });
  associate.mockReset().mockResolvedValue("ses_history");
  retire.mockReset().mockImplementation(async () => {
    const state = current ? "confirmed" : "absent";
    abort?.abort();
    current = null;
    return { state };
  });
  coordinator = fixture();
});
afterEach(async () => {
  vi.useRealTimers();
  abort?.abort();
  await rm(root, { recursive: true, force: true });
});

it("reads metadata without launch and starts each new process paused", async () => {
  expect(await coordinator.describe("studio-a")).toMatchObject({
    revision: 0,
    execution: "paused",
  });
  expect(ensure).not.toHaveBeenCalled();
  const attached = await coordinator.attach("studio-a", 0);
  expect(attached).toMatchObject({
    conversationId: "ses_history",
    lifecycle: { revision: 1, execution: "paused" },
  });
  await expect(
    coordinator.use("studio-a", attached.lease, true),
  ).rejects.toMatchObject({ failure: { code: "execution_paused" } });
  await coordinator.enable(current!);
  await expect(
    coordinator.use("studio-a", attached.lease, true),
  ).resolves.toMatchObject({ conversationId: "ses_history" });
  expect(await coordinator.attach("studio-a", 2)).toMatchObject({
    lease: attached.lease,
    lifecycle: { execution: "enabled" },
  });
  expect(ensure).toHaveBeenCalledOnce();
  expect(associate).toHaveBeenCalledOnce();
  await retire();
  coordinator = fixture();
  expect(await coordinator.describe("studio-a")).toMatchObject({
    revision: 2,
    execution: "paused",
  });
  const reopened = await coordinator.attach("studio-a", 2);
  expect(reopened.lease).not.toBe(attached.lease);
  expect(reopened.lifecycle.execution).toBe("paused");
  await expect(coordinator.use("studio-a", attached.lease)).rejects.toThrow();
  expect(current!.server.fetch).not.toHaveBeenCalled();
});

it("coalesces duplicate attach and rejects stale revisions without native work", async () => {
  const held = gate();
  associate.mockImplementationOnce(async () => {
    await held.promise;
    return "ses_history";
  });
  const first = coordinator.attach("studio-a", 0);
  expect(coordinator.attach("studio-a", 0)).toBe(first);
  await expect(coordinator.attach("studio-a", 1)).rejects.toThrow();
  held.release();
  await first;
  await expect(coordinator.attach("studio-a", 0)).rejects.toThrow();
  expect(ensure).toHaveBeenCalledOnce();
});

it("starts native retirement immediately while End waits for the original durable snapshot", async () => {
  const attached = await coordinator.attach("studio-a", 0);
  const held = gate();
  const read = vi.spyOn(store, "lifecycle");
  const ending = coordinator.beginEnd("studio-a", held.promise);
  expect(abort.signal.aborted).toBe(true);
  expect(read).not.toHaveBeenCalled();
  await expect(coordinator.use("studio-a", attached.lease)).rejects.toThrow();
  held.release();
  await ending.persistence;
  expect(await store.lifecycle("studio-a")).toMatchObject({ lifecycle: "ending" });
});

it("rejects a late attach after End and retains its durable fence without eligibility", async () => {
  const held = gate();
  associate.mockImplementationOnce(async () => {
    await held.promise;
    return "ses_history";
  });
  const first = coordinator.attach("studio-a", 0);
  const rejected = expect(first).rejects.toMatchObject({
    failure: { code: "lifecycle_changed" },
  });
  await vi.waitFor(() => expect(associate).toHaveBeenCalledOnce());
  const ending = coordinator.beginEnd("studio-a");
  expect(abort.signal.aborted).toBe(true);
  eligible = false;
  await ending.native;
  await ending.persistence;
  held.release();
  await rejected;
  await coordinator.finishEnd(ending.fence);
  expect(await store.lifecycle("studio-a")).toMatchObject({
    lifecycle: "ended",
    execution: "paused",
  });
  eligible = true;
  const state = await coordinator.describe("studio-a");
  await expect(
    coordinator.attach("studio-a", state.revision),
  ).rejects.toMatchObject({ failure: { code: "session_ended" } });
  expect(ensure).toHaveBeenCalledOnce();
});

it("closes admission immediately even if End persistence stalls or fails", async () => {
  const attached = await coordinator.attach("studio-a", 0);
  const held = gate();
  vi.spyOn(store, "transition").mockImplementationOnce(async () => {
    await held.promise;
    throw new Error("storage unavailable");
  });
  const ending = coordinator.beginEnd("studio-a");
  const failed = expect(ending.persistence).rejects.toThrow(
    "storage unavailable",
  );
  expect(abort.signal.aborted).toBe(true);
  await expect(coordinator.use("studio-a", attached.lease)).rejects.toThrow();
  expect((await coordinator.describe("studio-a")).lifecycle).toBe("ending");
  held.release();
  await failed;
  await ending.native;
  expect((await coordinator.describe("studio-a")).lifecycle).toBe("ending");
});

it("a hung old attach cannot block or retire a later authorized runtime", async () => {
  const held = gate();
  associate.mockImplementationOnce(async () => {
    await held.promise;
    return "ses_history";
  });
  const old = coordinator.attach("studio-a", 0);
  const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(associate).toHaveBeenCalledOnce());
  const ending = coordinator.beginEnd("studio-a");
  await ending.persistence;
  await ending.native;
  const ended = await coordinator.finishEnd(ending.fence);
  // Simulate the later explicit Resume revision claim; never an ordinary SDK read.
  const resumed = await store.transition("studio-a", ended.revision, {
    lifecycle: "open",
    execution: "paused",
  });
  const next = await coordinator.attach("studio-a", resumed.revision);
  const replacement = current;
  held.release();
  await rejected;
  expect(current).toBe(replacement);
  await expect(coordinator.use("studio-a", next.lease)).resolves.toMatchObject({
    hosted: replacement,
  });
  expect(retire).toHaveBeenCalledOnce();
});

it("revalidates the exact lease after asynchronous authorization", async () => {
  const attached = await coordinator.attach("studio-a", 0);
  const held = gate();
  assertCurrent.mockImplementationOnce(async () => {
    await held.promise;
  });
  const pending = coordinator.use("studio-a", attached.lease);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(assertCurrent).toHaveBeenCalledTimes(3));
  const ending = coordinator.beginEnd("studio-a");
  held.release();
  await rejected;
  await ending.persistence;
  await ending.native;
});

it("invalidates leases on authority loss and durable lifecycle changes", async () => {
  const attached = await coordinator.attach("studio-a", 0);
  eligible = false;
  await expect(coordinator.use("studio-a", attached.lease)).rejects.toThrow();
  eligible = true;
  await store.transition("studio-a", 1, {
    lifecycle: "ended",
    execution: "paused",
  });
  await expect(coordinator.use("studio-a", attached.lease)).rejects.toThrow();
  expect(await coordinator.describe("studio-a")).toMatchObject({
    lifecycle: "ended",
    execution: "paused",
  });
});

it("checks the durable fence after host authorization finishes", async () => {
  const attached = await coordinator.attach("studio-a", 0);
  assertCurrent.mockImplementationOnce(async () => {
    await store.transition("studio-a", 1, {
      lifecycle: "ended",
      execution: "paused",
    });
  });
  await expect(
    coordinator.use("studio-a", attached.lease),
  ).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
});

it("keeps unresolved End durable across coordinator restart and global shutdown paused", async () => {
  const ending = coordinator.beginEnd("studio-a");
  await ending.persistence;
  await ending.native;
  coordinator = fixture();
  expect(await coordinator.describe("studio-a")).toMatchObject({
    lifecycle: "ending",
    execution: "paused",
  });
  await expect(coordinator.attach("studio-a", 1)).rejects.toThrow();
  coordinator.beginShutdown();
  await expect(coordinator.attach("studio-b", 0)).rejects.toThrow();
  expect(ensure).not.toHaveBeenCalled();
});

it("rejects new attaches during shutdown while old association IO ignores cancellation", async () => {
  const held = gate();
  associate.mockImplementationOnce(async () => {
    await held.promise;
    return "ses_history";
  });
  const old = coordinator.attach("studio-a", 0);
  const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(associate).toHaveBeenCalledOnce());
  coordinator.beginShutdown();
  await expect(coordinator.attach("studio-a", 0)).rejects.toMatchObject({
    failure: { code: "lifecycle_changed" },
  });
  expect(ensure).toHaveBeenCalledOnce();
  held.release();
  await rejected;
});

it("inspection owns its provisional runtime until cleanup and Attach cannot steal it", async () => {
  const held = gate(), read = vi.fn(async () => { await held.promise; return "history"; });
  const inspected = coordinator.inspect("studio-a", 0, read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await expect(coordinator.attach("studio-a", 0)).rejects.toThrow();
  await expect(coordinator.inspect("studio-a", 0, read)).rejects.toThrow();
  expect(ensure).toHaveBeenCalledOnce();
  expect(associate).not.toHaveBeenCalled();
  held.release();
  expect(await inspected).toBe("history");
  expect(current).toBeNull();
  expect(await store.lifecycle("studio-a")).toBeNull();
  await coordinator.attach("studio-a", 0);
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(associate).toHaveBeenCalledOnce();
});

it("refuses inspection while Attach owns asynchronous association preparation", async () => {
  const held = gate(), read = vi.fn();
  associate.mockImplementationOnce(async () => { await held.promise; return "ses_history"; });
  const attaching = coordinator.attach("studio-a", 0);
  await vi.waitFor(() => expect(associate).toHaveBeenCalledOnce());
  await expect(coordinator.inspect("studio-a", 0, read)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(ensure).toHaveBeenCalledOnce();
  held.release();
  await attaching;
});

it("reuses an enabled exact runtime and leaves it live when the selected query times out", async () => {
  const attachment = await coordinator.attach("studio-a", 0);
  await coordinator.enable(current!);
  const existing = current!;
  expect(await coordinator.inspect("studio-a", 2, async (hosted) => hosted === existing)).toBe(true);
  const cancel = new AbortController(), read = vi.fn(() => new Promise<void>(() => {}));
  const inspected = coordinator.inspect("studio-a", 2, read, cancel.signal);
  const rejected = expect(inspected).rejects.toThrow("timeout");
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  cancel.abort(new Error("timeout"));
  await rejected;
  expect(retire).not.toHaveBeenCalled();
  expect(current).toBe(existing);
  await expect(coordinator.use("studio-a", attachment.lease, true)).resolves.toBeDefined();
  expect(ensure).toHaveBeenCalledOnce();
});

it("inspects an ended session without changing its revision or creating an association", async () => {
  await store.transition("studio-a", 0, { lifecycle: "ended", execution: "paused" });
  expect(await coordinator.inspect("studio-a", 1, async () => "saved")).toBe("saved");
  expect(await store.lifecycle("studio-a")).toMatchObject({ lifecycle: "ended", revision: 1 });
  expect(associate).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(current).toBeNull();
});

it.each(["End", "shutdown"])("%s preempts inspection before pending ensure has returned a host", async (mode) => {
  const held = gate(), read = vi.fn();
  ensure.mockImplementationOnce(async () => { await held.promise; throw new Error("old startup cancelled"); });
  const inspected = coordinator.inspect("studio-a", 0, read);
  const rejected = expect(inspected).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
  if (mode === "End") {
    const ending = coordinator.beginEnd("studio-a");
    await ending.persistence;
    await coordinator.finishEnd(ending.fence);
  } else coordinator.beginShutdown();
  await rejected;
  expect(retire).toHaveBeenCalledOnce();
  held.release();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
});

it("End cancels a hung query and its late completion cannot retire a same-ID replacement", async () => {
  const held = gate(), read = vi.fn(async () => { await held.promise; return "old"; });
  const inspected = coordinator.inspect("studio-a", 0, read);
  const rejected = expect(inspected).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  const ending = coordinator.beginEnd("studio-a");
  expect(abort.signal.aborted).toBe(true);
  await rejected;
  await ending.persistence;
  const ended = await coordinator.finishEnd(ending.fence);
  const opened = await store.transition("studio-a", ended.revision, { lifecycle: "open", execution: "paused" });
  await coordinator.attach("studio-a", opened.revision);
  const replacement = current!;
  held.release();
  await Promise.resolve();
  expect(current).toBe(replacement);
  expect(replacement.signal.aborted).toBe(false);
});

it("the overall inspection deadline fences startup even before a host entry exists", async () => {
  vi.useFakeTimers();
  vi.spyOn(store, "lifecycle").mockResolvedValue(null);
  coordinator = fixture(50);
  const held = gate();
  ensure.mockImplementationOnce(async () => { await held.promise; throw new Error("cancelled"); });
  const inspected = coordinator.inspect("studio-a", 0, vi.fn());
  const rejected = expect(inspected).rejects.toMatchObject({ failure: { code: "transport_unavailable" } });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(retire).toHaveBeenCalledExactlyOnceWith("studio-a", 750);
  held.release();
});

it("bounds a hung provisional cleanup instead of reporting a successful inspection", async () => {
  vi.useFakeTimers();
  vi.spyOn(store, "lifecycle").mockResolvedValue(null);
  retire.mockImplementationOnce(() => new Promise(() => {}));
  const inspected = coordinator.inspect("studio-a", 0, async () => "saved");
  const rejected = expect(inspected).rejects.toMatchObject({ failure: { code: "cleanup_unconfirmed" } });
  await vi.advanceTimersByTimeAsync(750);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("reports failed provisional cleanup and rejects stale revisions before querying", async () => {
  retire.mockRejectedValueOnce(new Error("shutdown not confirmed"));
  await expect(coordinator.inspect("studio-a", 0, async () => "saved")).rejects.toMatchObject({ failure: { code: "cleanup_unconfirmed" } });
  const read = vi.fn();
  await expect(coordinator.inspect("studio-a", 9, read)).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  expect(read).not.toHaveBeenCalled();
});

it("rechecks durable revision after asynchronous query authorization", async () => {
  await coordinator.attach("studio-a", 0);
  const read = vi.fn(async () => {
    await store.transition("studio-a", 1, { lifecycle: "ended", execution: "paused" });
    return "stale";
  });
  await expect(coordinator.inspect("studio-a", 1, read)).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  expect(retire).not.toHaveBeenCalled();
});

it("pending Continue children cannot attach and End fences a late admission result", async () => {
  canAttach.mockResolvedValueOnce(false);
  await expect(coordinator.attach("studio-a", 0)).rejects.toThrow();
  expect(ensure).not.toHaveBeenCalled();
  const held = gate();
  canAttach.mockImplementationOnce(async () => { await held.promise; return true; });
  const attaching = coordinator.attach("studio-a", 0);
  const rejected = expect(attaching).rejects.toThrow();
  await vi.waitFor(() => expect(canAttach).toHaveBeenCalledTimes(2));
  const ending = coordinator.beginEnd("studio-a");
  held.release();
  await rejected;
  await ending.persistence;
  expect(ensure).not.toHaveBeenCalled();
  expect(associate).not.toHaveBeenCalled();
});

it("Continue exclusively prepares a gated child and keeps its exact runtime without a lease", async () => {
  canAttach.mockResolvedValue(false);
  const held = gate(), prepare = vi.fn(async () => { await held.promise; return "seeded"; });
  const preparing = coordinator.prepareContinuation("studio-a", 0, prepare);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  const provisional = current;
  await expect(coordinator.inspect("studio-a", 0, vi.fn())).rejects.toThrow();
  await expect(coordinator.attach("studio-a", 0)).rejects.toThrow();
  await expect(coordinator.prepareContinuation("studio-a", 0, vi.fn())).rejects.toThrow();
  held.release();
  expect(await preparing).toBe("seeded");
  expect(canAttach).not.toHaveBeenCalled();
  expect(current).toBe(provisional);
  expect(await store.lifecycle("studio-a")).toBeNull();
  expect(associate).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(retire).not.toHaveBeenCalled();
  await expect(coordinator.use("studio-a", "not-a-lease")).rejects.toThrow();
  canAttach.mockResolvedValue(true);
  const attached = await coordinator.attach("studio-a", 0);
  expect(current).toBe(provisional);
  expect(attached.lifecycle).toMatchObject({ revision: 1, execution: "paused" });
  expect(observe).toHaveBeenCalledOnce();
});

it("failed Continue preparation retires only its provisional host and releases the slot", async () => {
  await expect(coordinator.prepareContinuation("studio-a", 0, async () => {
    throw new Error("seed unavailable");
  })).rejects.toThrow("seed unavailable");
  expect(current).toBeNull();
  expect(retire).toHaveBeenCalledOnce();
  expect(await coordinator.prepareContinuation("studio-a", 0, async () => "retried")).toBe("retried");
  expect(current).not.toBeNull();
  expect(await store.lifecycle("studio-a")).toBeNull();
});

it("Continue requires an open exact revision and discards a late result after durable change", async () => {
  await store.transition("studio-a", 0, { lifecycle: "ended", execution: "paused" });
  await expect(coordinator.prepareContinuation("studio-a", 1, vi.fn())).rejects.toThrow();
  await expect(coordinator.prepareContinuation("studio-a", 0, vi.fn())).rejects.toThrow();
  expect(ensure).not.toHaveBeenCalled();
  await store.transition("studio-a", 1, { lifecycle: "open", execution: "paused" });
  await expect(coordinator.prepareContinuation("studio-a", 2, async () => {
    await store.transition("studio-a", 2, { lifecycle: "ending", execution: "paused" });
    return "late";
  })).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  expect(current).toBeNull();
  expect(observe).not.toHaveBeenCalled();
});

it("End preempts hung Continue preparation and its late result cannot retire a replacement", async () => {
  const held = gate(), prepare = vi.fn(async () => { await held.promise; return "old"; });
  const preparing = coordinator.prepareContinuation("studio-a", 0, prepare);
  const rejected = expect(preparing).rejects.toMatchObject({ failure: { code: "lifecycle_changed" } });
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  const old = current!;
  const ending = coordinator.beginEnd("studio-a");
  expect(old.signal.aborted).toBe(true);
  await rejected;
  await ending.persistence;
  const ended = await coordinator.finishEnd(ending.fence);
  const opened = await store.transition("studio-a", ended.revision, { lifecycle: "open", execution: "paused" });
  await coordinator.prepareContinuation("studio-a", opened.revision, async () => "new");
  const replacement = current!;
  held.release();
  await Promise.resolve();
  expect(current).toBe(replacement);
  expect(replacement.signal.aborted).toBe(false);
  expect(observe).not.toHaveBeenCalled();
});
