/**
 * Unit coverage for the back/forward navigation reducers behind the header's
 * Go-back / Go-forward chrome (navigation-history.ts). These are pure functions
 * with real edge cases — cross-kind identity, tip-dedupe, refresh-in-place,
 * forward-branch truncation, and the MAX_ENTRIES cap — that regress silently, so
 * they are pinned here.
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";

import {
  EMPTY_NAVIGATION_HISTORY,
  canGoBack,
  canGoForward,
  moveNavigation,
  pushNavigationVisit,
  sameNavigationVisit,
  type NavigationHistoryState,
  type NavigationVisit,
} from "./navigation-history";

const session = (sessionId: string, agentPath: string | null = null): NavigationVisit => ({
  kind: "session",
  sessionId,
  agentPath,
});
const agent = (agentPath: string): NavigationVisit => ({ kind: "agent", agentPath });
const review = (agentSessionId: string): NavigationVisit => ({
  kind: "review",
  // The reducer only reads summary.agentSessionId; a minimal cast keeps the
  // fixture focused on the identity that matters.
  summary: { agentSessionId } as unknown as SessionSummary,
});
const composer: NavigationVisit = { kind: "composer" };
const templates: NavigationVisit = { kind: "templates" };

/** Build a state from a list of visits, index defaulting to the tip. */
const stateOf = (entries: NavigationVisit[], index = entries.length - 1): NavigationHistoryState => ({
  entries,
  index,
});

describe("sameNavigationVisit", () => {
  it("is false across different kinds", () => {
    expect(sameNavigationVisit(session("s1", "/a"), agent("/a"))).toBe(false);
    expect(sameNavigationVisit(composer, templates)).toBe(false);
  });
  it("compares sessions by sessionId, ignoring agentPath", () => {
    expect(sameNavigationVisit(session("s1", "/a"), session("s1", "/b"))).toBe(true);
    expect(sameNavigationVisit(session("s1", "/a"), session("s2", "/a"))).toBe(false);
  });
  it("compares agents by agentPath", () => {
    expect(sameNavigationVisit(agent("/a"), agent("/a"))).toBe(true);
    expect(sameNavigationVisit(agent("/a"), agent("/b"))).toBe(false);
  });
  it("compares reviews by summary.agentSessionId", () => {
    expect(sameNavigationVisit(review("as1"), review("as1"))).toBe(true);
    expect(sameNavigationVisit(review("as1"), review("as2"))).toBe(false);
  });
  it("treats composer/templates as identity-by-kind", () => {
    expect(sameNavigationVisit(composer, composer)).toBe(true);
    expect(sameNavigationVisit(templates, templates)).toBe(true);
  });
});

describe("canGoBack / canGoForward", () => {
  it("are both false for the empty history", () => {
    expect(canGoBack(EMPTY_NAVIGATION_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_NAVIGATION_HISTORY)).toBe(false);
  });
  it("canGoBack is false at index 0, true beyond", () => {
    expect(canGoBack(stateOf([agent("/a")], 0))).toBe(false);
    expect(canGoBack(stateOf([agent("/a"), agent("/b")], 1))).toBe(true);
  });
  it("canGoForward is false at the tip, true before it", () => {
    const s = stateOf([agent("/a"), agent("/b")], 1);
    expect(canGoForward(s)).toBe(false);
    expect(canGoForward({ ...s, index: 0 })).toBe(true);
  });
});

describe("pushNavigationVisit", () => {
  it("seeds an empty history", () => {
    const next = pushNavigationVisit(EMPTY_NAVIGATION_HISTORY, agent("/a"));
    expect(next).toEqual({ entries: [agent("/a")], index: 0 });
  });

  it("is a no-op (same reference) when the tip is byte-identical", () => {
    const s = stateOf([agent("/a")], 0);
    expect(pushNavigationVisit(s, agent("/a"))).toBe(s);
  });

  it("refreshes the tip in place when it is the same place told more precisely", () => {
    // A session that has since learned its agentPath: same sessionId (same
    // place) but richer — replace in place, don't branch.
    const s = stateOf([session("s1", null)], 0);
    const next = pushNavigationVisit(s, session("s1", "/a"));
    expect(next.entries).toEqual([session("s1", "/a")]);
    expect(next.index).toBe(0);
    expect(next).not.toBe(s);
  });

  it("appends a genuinely different place and advances the index", () => {
    const s = stateOf([agent("/a")], 0);
    const next = pushNavigationVisit(s, agent("/b"));
    expect(next.entries).toEqual([agent("/a"), agent("/b")]);
    expect(next.index).toBe(1);
  });

  it("truncates the forward branch when pushing from the middle", () => {
    // At index 0 of [a, b, c]; pushing d drops b and c (browser-style).
    const s = stateOf([agent("/a"), agent("/b"), agent("/c")], 0);
    const next = pushNavigationVisit(s, agent("/d"));
    expect(next.entries).toEqual([agent("/a"), agent("/d")]);
    expect(next.index).toBe(1);
  });

  it("caps the stack at MAX_ENTRIES (50), keeping the most recent", () => {
    let s: NavigationHistoryState = EMPTY_NAVIGATION_HISTORY;
    for (let i = 0; i < 60; i++) s = pushNavigationVisit(s, agent(`/a${i}`));
    expect(s.entries).toHaveLength(50);
    expect(s.index).toBe(49);
    expect(s.entries[0]).toEqual(agent("/a10")); // the oldest 10 fell off
    expect(s.entries[49]).toEqual(agent("/a59"));
  });
});

describe("moveNavigation", () => {
  it("returns the state unchanged and no visit at the back boundary", () => {
    const s = stateOf([agent("/a")], 0);
    const moved = moveNavigation(s, "back");
    expect(moved.visit).toBeNull();
    expect(moved.state).toBe(s);
  });
  it("returns the state unchanged and no visit at the forward boundary", () => {
    const s = stateOf([agent("/a"), agent("/b")], 1);
    const moved = moveNavigation(s, "forward");
    expect(moved.visit).toBeNull();
    expect(moved.state).toBe(s);
  });
  it("steps back to the previous visit", () => {
    const s = stateOf([agent("/a"), agent("/b")], 1);
    const moved = moveNavigation(s, "back");
    expect(moved.state.index).toBe(0);
    expect(moved.visit).toEqual(agent("/a"));
  });
  it("steps forward to the next visit", () => {
    const s = stateOf([agent("/a"), agent("/b")], 0);
    const moved = moveNavigation(s, "forward");
    expect(moved.state.index).toBe(1);
    expect(moved.visit).toEqual(agent("/b"));
  });
  it("round-trips back then forward to the same tip", () => {
    const s = stateOf([agent("/a"), agent("/b"), agent("/c")], 2);
    const back = moveNavigation(s, "back");
    const fwd = moveNavigation(back.state, "forward");
    expect(fwd.state.index).toBe(2);
    expect(fwd.visit).toEqual(agent("/c"));
  });
});
