import { describe, expect, it } from "vitest";

import {
  fireOutcome,
  loadReplay,
  messageText,
  receiptsSince,
  tsGap,
  verdict,
  type ReceiptRow,
} from "./replay";

describe("replay.json", () => {
  const replay = loadReplay();

  it("covers the demo: a bug, its threaded follow-up, an outage, a kb question, a thank-you", () => {
    expect(replay.steps.map((s) => s.id)).toEqual([
      "bug",
      "follow-up",
      "outage",
      "question",
      "thanks",
    ]);
    expect(replay.steps.find((s) => s.id === "follow-up")?.threadOf).toBe(
      "bug",
    );
    expect(replay.steps.find((s) => s.id === "outage")?.text).toMatch(
      /production is down/i,
    );
  });

  it("prefixes every message so test traffic is recognizable", () => {
    for (const s of replay.steps)
      expect(messageText(replay, s.text).startsWith(replay.prefix)).toBe(true);
    expect(messageText({ ...replay, prefix: "" }, "hi")).toBe("hi");
  });

  it("measures latency between Slack timestamps in seconds", () => {
    expect(tsGap("1790889355.981329", "1790889362.481329")).toBe(6.5);
  });
});

describe("replay watcher", () => {
  const receipt = (id: number, at: string): ReceiptRow => ({
    id: String(id),
    receivedAt: at,
    eventType: "issue.created",
    outcome: "matched",
    triggerSlugs: ["sylon-copilot"],
  });

  it("pages receipts until one is older than the replay's start", async () => {
    // 5 receipts since the start, newest first, then an older one; pages of 2.
    const all = [
      ...[7, 6, 5, 4, 3].map((n) => receipt(n, `2026-10-02T08:0${n}:00Z`)),
      receipt(2, "2026-10-02T07:00:00Z"),
      receipt(1, "2026-10-02T06:00:00Z"),
    ];
    const asked: string[] = [];
    const get = async (p: string) => {
      asked.push(p);
      const q = new URLSearchParams(p.split("?")[1]);
      const offset = Number(q.get("offset"));
      return all.slice(offset, offset + Number(q.get("limit")));
    };
    const got = await receiptsSince(get, new Date("2026-10-02T08:00:00Z"), 2);
    expect(got.map((r) => r.id)).toEqual(["7", "6", "5", "4", "3"]);
    expect(asked).toEqual([
      "/receipts?limit=2&offset=0",
      "/receipts?limit=2&offset=2",
      "/receipts?limit=2&offset=4",
    ]);
  });

  it("succeeds only when every receipt finished and none failed", () => {
    expect(verdict([], [])).toEqual({ ok: true, lines: ["no failed runs"] });
    const late = verdict([], ["receipt 9 issue.created"]);
    expect(late.ok).toBe(false);
    expect(late.lines).toEqual([
      "incomplete: still running\n- receipt 9 issue.created",
    ]);
    expect(verdict(["copilot run 1: failed"], []).ok).toBe(false);
  });

  it("does not count a skipped fire as a failure, but does a stale one", () => {
    expect(fireOutcome({ state: "skipped", execution: null })).toEqual({
      status: "skipped",
      failed: false,
    });
    expect(fireOutcome({ state: "stale", execution: null }).failed).toBe(true);
    expect(
      fireOutcome({ state: "succeeded", execution: { status: "completed" } })
        .failed,
    ).toBe(false);
    expect(
      fireOutcome({ state: "succeeded", execution: { status: "failed" } })
        .failed,
    ).toBe(true);
  });
});
