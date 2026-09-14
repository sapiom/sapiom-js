import { afterEach, expect, it, vi } from "vitest";
import { AssistantEndCoordinator } from "./assistant-end.js";
import { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import {
  AssistantSessionRevisionError,
  type AssistantSessionStore,
} from "./assistant-session-store.js";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import type { OpenCodeRetirement } from "./opencode-host.js";
import type { TerminalCleanupResult } from "./session-manager.js";

const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const state = (
  id: string,
  lifecycle: AssistantLifecycle["lifecycle"] = "open",
): AssistantLifecycle => ({
  version: 1,
  harnessSessionId: id,
  revision: 1,
  lifecycle,
  execution: "paused",
  updatedAt: 1,
});
function fixture(prior: AssistantLifecycle | null = state("a")) {
  const states = new Map<string, AssistantLifecycle>();
  if (prior) states.set("a", prior);
  states.set("b", state("b"));
  const rows = new Map(
    ["a", "b"].map((id) => [
      id,
      { id, cwd: "/same/folder", status: "running" },
    ]),
  );
  const signals = new Map(["a", "b"].map((id) => [id, new AbortController()]));
  const store = {
    lifecycle: vi.fn(async (id: string) => states.get(id) ?? null),
    transition: vi.fn<AssistantSessionStore["transition"]>(
      async (id, expected, next) => {
        if ((states.get(id)?.revision ?? 0) !== expected)
          throw new AssistantSessionRevisionError();
        const saved: AssistantLifecycle = {
          ...state(id),
          ...next,
          revision: expected + 1,
        };
        states.set(id, saved);
        return saved;
      },
    ),
  };
  const retire = vi.fn((id: string): Promise<OpenCodeRetirement> => {
    signals.get(id)?.abort();
    return Promise.resolve({ state: "confirmed" });
  });
  const close = vi.fn((id: string): Promise<TerminalCleanupResult> => {
    rows.get(id)!.status = "exited";
    return Promise.resolve({
      state: "confirmed",
      runtimeEpoch: `terminal-${id}`,
    });
  });
  const lifecycle = new AssistantLifecycleCoordinator({
    store,
    associations: { ensure: vi.fn() },
    host: {
      ensure: vi.fn(() => {
        throw new Error("Assistant grant expired");
      }),
      current: () => null,
      assertCurrent: vi.fn(),
      retireExact: vi.fn(),
      observe: vi.fn(),
      beginShutdown: vi.fn(),
      retireWithResult: retire,
    },
  });
  const coordinator = () =>
    new AssistantEndCoordinator({
      store,
      lifecycle,
      sessionManager: { closeWithResult: close },
      timeoutMs: 100,
    });
  return {
    end: coordinator(),
    coordinator,
    lifecycle,
    store,
    states,
    rows,
    signals,
    retire,
    close,
  };
}
afterEach(() => {
  vi.useRealTimers();
});

it("fences both engines synchronously before a held snapshot and affects only the selected ID", async () => {
  const f = fixture();
  const held = gate<AssistantLifecycle | null>();
  f.store.lifecycle.mockImplementationOnce(() => held.promise);
  const ending = f.end.end("a");
  expect(f.signals.get("a")!.signal.aborted).toBe(true);
  expect(f.close).toHaveBeenCalledExactlyOnceWith("a");
  expect(f.store.transition).not.toHaveBeenCalled();
  expect(f.signals.get("b")!.signal.aborted).toBe(false);
  expect(f.rows.get("b")!.status).toBe("running");
  await expect(f.lifecycle.attach("a", 1)).rejects.toThrow();
  held.resolve(state("a"));
  await expect(ending).resolves.toMatchObject({
    ok: true,
    lifecycle: { lifecycle: "ended" },
  });
  expect(f.rows.has("a")).toBe(true);
  expect(f.states.get("b")).toEqual(state("b"));
});

it("coalesces callers through final persistence and safely rechecks a completed retry", async () => {
  const f = fixture();
  const held = gate<void>();
  const transition = f.store.transition.getMockImplementation()!;
  f.store.transition.mockImplementation(async (...args) => {
    if (args[2].lifecycle === "ended") await held.promise;
    return transition(...args);
  });
  const first = f.end.end("a");
  await vi.waitFor(() =>
    expect(f.store.transition).toHaveBeenCalledWith("a", 2, {
      lifecycle: "ended",
      execution: "paused",
    }),
  );
  for (let i = 0; i < 20; i++) expect(f.end.end("a")).toBe(first);
  held.resolve();
  const result = await first;
  expect(result.ok).toBe(true);
  expect(f.retire).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.store.transition).toHaveBeenCalledTimes(2);
  expect((await f.end.end("a")).ok).toBe(true);
  expect(f.states.get("a")!.lifecycle).toBe("ended");
});

it("installs coalescing before synchronous lifecycle listeners can re-enter End", async () => {
  const f = fixture();
  let nested: Promise<unknown> | undefined;
  f.lifecycle.subscribe(() => {
    nested ??= f.end.end("a");
  });
  const first = f.end.end("a");
  expect(nested).toBe(first);
  expect((await first).ok).toBe(true);
  expect(f.close).toHaveBeenCalledOnce();
});

it("a new open revision invalidates the completed End for a later same-ID Resume", async () => {
  const f = fixture();
  await f.end.end("a");
  const ended = f.states.get("a")!;
  await f.store.transition("a", ended.revision, {
    lifecycle: "open",
    execution: "paused",
  });
  await f.lifecycle.describe("a");
  expect((await f.end.end("a")).ok).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.retire).toHaveBeenCalledTimes(2);
});

it("closes a new Terminal incarnation even when its Assistant header is still ended", async () => {
  const f = fixture();
  await f.end.end("a");
  const before = f.states.get("a")!;
  f.rows.get("a")!.status = "running";
  f.close.mockImplementationOnce(async (id) => {
    f.rows.get(id)!.status = "exited";
    return { state: "confirmed", runtimeEpoch: "replacement-terminal" };
  });
  expect((await f.end.end("a")).ok).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.rows.get("a")!.status).toBe("exited");
  expect(f.states.get("a")!.revision).toBeGreaterThan(before.revision);
});

it.each([null, state("a"), state("a", "ended")])(
  "accepts current-host absence without an unresolved prior End: %j",
  async (prior) => {
    const f = fixture(prior);
    f.retire.mockResolvedValue({ state: "absent" });
    f.close.mockResolvedValue({ state: "absent", runtimeEpoch: null });
    expect((await f.end.end("a")).ok).toBe(true);
  },
);

it("never treats absence after a prior-host ending header as proof of old process cleanup", async () => {
  const f = fixture(state("a", "ending"));
  f.retire.mockResolvedValue({ state: "confirmed" });
  f.close.mockResolvedValue({ state: "absent", runtimeEpoch: null });
  expect(await f.end.end("a")).toMatchObject({
    ok: false,
    code: "cleanup_unconfirmed",
  });
  expect(f.states.get("a")!.lifecycle).toBe("ending");
  // A retry and another coordinator cannot erase the uncertainty by observing
  // only empty current-process maps. Neither attempt may call finishEnd.
  f.retire.mockResolvedValue({ state: "absent" });
  expect((await f.end.end("a")).ok).toBe(false);
  expect((await f.coordinator().end("a")).ok).toBe(false);
  expect(
    f.store.transition.mock.calls.every(
      (args) => args[2].lifecycle === "ending",
    ),
  ).toBe(true);
});

it("retains positive exact-engine evidence across an incomplete same-host retry", async () => {
  const f = fixture(state("a", "ending"));
  f.close.mockResolvedValueOnce({
    state: "unconfirmed",
    runtimeEpoch: "terminal-a",
  });
  expect((await f.end.end("a")).ok).toBe(false);
  f.retire.mockResolvedValue({ state: "absent" });
  expect((await f.end.end("a")).ok).toBe(true);
  expect(f.rows.has("a")).toBe(true);
});

it.each(["snapshot", "ending", "ended", "terminal", "native"] as const)(
  "keeps a failed %s operation visible and fenced",
  async (stage) => {
    const f = fixture();
    if (stage === "snapshot")
      f.store.lifecycle.mockRejectedValueOnce(
        new Error("private storage path"),
      );
    if (stage === "terminal")
      f.close.mockRejectedValueOnce(new Error("private binding path"));
    if (stage === "native")
      f.retire.mockResolvedValueOnce({ state: "unconfirmed" });
    if (stage === "ending" || stage === "ended") {
      const transition = f.store.transition.getMockImplementation()!;
      f.store.transition.mockImplementation(async (...args) => {
        if (args[2].lifecycle === stage)
          throw new Error("private storage path");
        return transition(...args);
      });
    }
    const result = await f.end.end("a");
    expect(result).toMatchObject({ ok: false, code: "cleanup_unconfirmed" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.retire).toHaveBeenCalledOnce();
    expect(f.rows.has("a")).toBe(true);
    expect(f.states.get("a")!.lifecycle).not.toBe("ended");
    await expect(
      f.lifecycle.attach("a", f.states.get("a")!.revision),
    ).rejects.toThrow();
  },
);

it.each(["snapshot", "ending", "ended", "terminal", "native"] as const)(
  "bounds a never-resolving %s operation without finishing an unconfirmed End",
  async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    if (stage === "snapshot")
      f.store.lifecycle.mockImplementationOnce(() => new Promise(() => {}));
    if (stage === "terminal")
      f.close.mockImplementationOnce(() => new Promise(() => {}));
    if (stage === "native")
      f.retire.mockImplementationOnce(() => new Promise(() => {}));
    if (stage === "ending" || stage === "ended") {
      const transition = f.store.transition.getMockImplementation()!;
      f.store.transition.mockImplementation((...args) =>
        args[2].lifecycle === stage
          ? new Promise(() => {})
          : transition(...args),
      );
    }
    const first = f.end.end("a");
    expect(f.end.end("a")).toBe(first);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.retire).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({
      ok: false,
      code: "cleanup_unconfirmed",
    });
    expect(f.states.get("a")!.lifecycle).not.toBe("ended");
    expect(f.rows.has("a")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not let one failed cleanup skip waiting for the other engine or affect another session", async () => {
  const f = fixture();
  const held = gate<OpenCodeRetirement>();
  f.retire.mockImplementationOnce(() => held.promise);
  f.close.mockRejectedValueOnce(new Error("binding write failed"));
  const first = f.end.end("a");
  expect((await f.end.end("b")).ok).toBe(true);
  expect(f.end.end("a")).toBe(first);
  held.resolve({ state: "confirmed" });
  expect((await first).ok).toBe(false);
});

it("expires a hung original-state read without a late write and permits a fresh retry", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const held = gate<AssistantLifecycle | null>();
  f.store.lifecycle.mockImplementationOnce(() => held.promise);
  const first = f.end.end("a");
  await vi.advanceTimersByTimeAsync(100);
  expect((await first).ok).toBe(false);
  held.resolve(state("a"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.transition).not.toHaveBeenCalled();
  expect((await f.end.end("a")).ok).toBe(true);
});
