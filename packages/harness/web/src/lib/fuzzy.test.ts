import { describe, expect, it } from "vitest";

import { fuzzyMatch, fuzzyScore } from "./fuzzy";

// The two production failures this matcher exists to prevent (from the
// 2026-08-11 Slack report): a short query "matching" characters scattered
// across an absolute path, and matching strewn across a raw-prompt title.
describe("fuzzyMatch rejects scattered-noise subsequences", () => {
  it("does not match a query strewn across an absolute path", () => {
    expect(fuzzyMatch("slack", "/Users/gwitwer/sapiom/hackathon-local/workflows/backlog-nudge")).toBeNull();
    expect(fuzzyMatch("daily", "/Users/gwitwer/sapiom/hackathon-local/workflows/backlog-nudge")).toBeNull();
  });

  it("does not match a query strewn across a raw-prompt title", () => {
    expect(fuzzyMatch("daily", "You are annotating an already-generated draft")).toBeNull();
  });

  it("rejects in-order but off-boundary scatter inside a single word", () => {
    // The old greedy matcher accepted this ("l…s…g" inside "leasing").
    expect(fuzzyScore("lsg", "leasing")).toBeNull();
    expect(fuzzyScore("xyz", "leasing")).toBeNull();
  });
});

describe("fuzzyMatch accepts the useful match shapes", () => {
  it("prefix", () => {
    expect(fuzzyMatch("slack", "slack-notifier")?.indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("mid-word substring (the only legal off-boundary start)", () => {
    expect(fuzzyMatch("otif", "slack-notifier")?.indices).toEqual([7, 8, 9, 10]);
  });

  it("word initials across separators", () => {
    expect(fuzzyMatch("daa", "daily-activity-analyst")).not.toBeNull();
  });

  it("camelCase humps", () => {
    expect(fuzzyMatch("fb", "FooBar")?.indices).toEqual([0, 3]);
  });

  it("separator skip (query omits the dash)", () => {
    expect(fuzzyMatch("slacknot", "slack-notifier")).not.toBeNull();
  });

  it("multi-term AND", () => {
    expect(fuzzyMatch("daily analyst", "daily-activity-analyst")).not.toBeNull();
    expect(fuzzyMatch("daily xyz", "daily-activity-analyst")).toBeNull();
  });

  it("a repeated term scores once, not once per repetition", () => {
    expect(fuzzyScore("slack slack", "slack-notifier")).toBe(fuzzyScore("slack", "slack-notifier"));
  });

  it("length-changing lowercase never desyncs highlight indices", () => {
    // U+0130 lowercases to two code units; alignment must survive.
    const match = fuzzyMatch("app", "İstanbul-app");
    expect(match?.indices).toEqual([9, 10, 11]);
  });

  it("ignores surrounding whitespace instead of matching it literally", () => {
    expect(fuzzyMatch("  slack ", "slack-notifier")).not.toBeNull();
  });

  it("empty query matches everything with a zero score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("fuzzyMatch scoring order", () => {
  const score = (q: string, t: string): number => {
    const s = fuzzyScore(q, t);
    if (s === null) throw new Error(`expected "${q}" to match "${t}"`);
    return s;
  };

  it("pins the canonical scores so constant drift is visible", () => {
    // start 20 + boundary char 13 + four consecutive chars at 11 each
    expect(score("daily", "daily-activity-analyst")).toBe(77);
    // start 20 + boundary char 13 + six consecutive at 11 + exact 25
    expect(score("leasing", "leasing")).toBe(124);
  });

  it("exact beats prefix", () => {
    expect(score("leasing", "leasing")).toBeGreaterThan(score("leas", "leasing"));
  });

  it("match at the start beats the same match mid-target", () => {
    expect(score("not", "notifier")).toBeGreaterThan(score("not", "slack-notifier"));
  });

  it("contiguous beats boundary-hopping", () => {
    expect(score("act", "activity")).toBeGreaterThan(score("act", "a-c-tools"));
  });

  it("boundary-anchored beats mid-word", () => {
    expect(score("daa", "daily-activity-analyst")).toBeGreaterThan(score("daa", "xdaa"));
  });
});
