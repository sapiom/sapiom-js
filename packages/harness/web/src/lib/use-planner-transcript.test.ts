import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@shared/types";

import { CoalescedSessionRecordReader } from "./use-planner-transcript";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function record(turnCount: number): SessionRecord {
  return {
    harnessSessionId: "planner-1",
    mergedSessionIds: ["planner-1"],
    agentSessionId: null,
    harness: "claude-code",
    cwd: "/project",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: null,
    turns: [],
    turnCount,
    eventCount: turnCount * 2,
    reconstructed: true,
    archivedAt: null,
    limitations: [],
  };
}

describe("CoalescedSessionRecordReader", () => {
  it("coalesces invalidations during a read into one trailing snapshot", async () => {
    const first = deferred<SessionRecord | null>();
    const second = deferred<SessionRecord | null>();
    const load = vi
      .fn<(id: string) => Promise<SessionRecord | null>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const applied: number[] = [];
    const reader = new CoalescedSessionRecordReader(
      "planner-1",
      load,
      (result) => {
        if (result.status === "ready") applied.push(result.record.turnCount);
      },
    );

    reader.refresh();
    reader.refresh();
    reader.refresh();
    expect(load).toHaveBeenCalledTimes(1);

    first.resolve(record(1));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    second.resolve(record(2));
    await vi.waitFor(() => expect(applied).toEqual([1, 2]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores a late result after the selected session changes", async () => {
    const pending = deferred<SessionRecord | null>();
    const applied = vi.fn();
    const reader = new CoalescedSessionRecordReader(
      "planner-1",
      () => pending.promise,
      applied,
    );

    reader.refresh();
    reader.dispose();
    pending.resolve(record(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).not.toHaveBeenCalled();
  });
});
