import { describe, expect, it } from "vitest";

import { loadReplay, messageText, tsGap } from "./replay";

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
