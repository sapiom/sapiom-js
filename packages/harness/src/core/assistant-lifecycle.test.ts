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
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
};
const fixture = () =>
  new AssistantLifecycleCoordinator({
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
