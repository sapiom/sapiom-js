import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";

import { formatDuration, historyRowMeta, mergeHistory } from "./history-meta";

function row(overrides: Partial<SessionSummary> & { agentSessionId: string; cwd: string }): SessionSummary {
  return {
    harness: "claude-code",
    title: overrides.agentSessionId,
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    source: "registry",
    resumeMode: "agent-resume",
    ...overrides,
  };
}

describe("mergeHistory", () => {
  const acme = row({ agentSessionId: "acme-1", cwd: "/demo/acme" });
  const rfq = row({ agentSessionId: "rfq-1", cwd: "/demo/rfq", lastActiveAt: "2026-01-02T00:00:00.000Z" });

  it("keeps other directories' rows when only one directory is reloaded", () => {
    // The regression: the dead pane loads a SINGLE cwd to learn its verified
    // resumeMode. A whole-store replace evicted every other directory's rows,
    // so the rail's tags fell back to "checking…" with nothing to reload them.
    const merged = mergeHistory([acme, rfq], [acme], new Set(["/demo/acme"]));
    expect(merged.map((r) => r.agentSessionId).sort()).toEqual(["acme-1", "rfq-1"]);
  });

  it("replaces the reloaded directory's rows, so a vanished transcript drops out", () => {
    const gone = row({ agentSessionId: "acme-gone", cwd: "/demo/acme" });
    const merged = mergeHistory([acme, gone, rfq], [acme], new Set(["/demo/acme"]));
    expect(merged.map((r) => r.agentSessionId).sort()).toEqual(["acme-1", "rfq-1"]);
  });

  it("takes the fresh row's resumeMode over the retained copy", () => {
    const stale = row({ agentSessionId: "acme-1", cwd: "/demo/acme", resumeMode: "agent-resume" });
    const fresh = row({ agentSessionId: "acme-1", cwd: "/demo/acme", resumeMode: "rehydrate" });
    const merged = mergeHistory([stale], [fresh], new Set(["/demo/acme"]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.resumeMode).toBe("rehydrate");
  });

  it("retains a directory's rows when its fetch failed (absent from refreshedCwds)", () => {
    // Promise.allSettled rejection: the dir is requested but never answers, so
    // it must not be treated as "refreshed to empty".
    const merged = mergeHistory([acme, rfq], [], new Set());
    expect(merged.map((r) => r.agentSessionId).sort()).toEqual(["acme-1", "rfq-1"]);
  });

  it("sorts newest first across retained and refreshed rows alike", () => {
    const merged = mergeHistory([acme], [rfq], new Set(["/demo/rfq"]));
    expect(merged.map((r) => r.agentSessionId)).toEqual(["rfq-1", "acme-1"]);
  });
});

describe("formatDuration", () => {
  const start = "2026-01-01T00:00:00.000Z";

  it("formats real spans at minute, hour, and day scale", () => {
    expect(formatDuration(start, "2026-01-01T00:00:30.000Z")).toBe("under a minute");
    expect(formatDuration(start, "2026-01-01T00:42:00.000Z")).toBe("42m");
    expect(formatDuration(start, "2026-01-01T01:12:00.000Z")).toBe("1h 12m");
    expect(formatDuration(start, "2026-01-03T03:00:00.000Z")).toBe("2d 3h");
  });

  it("returns null for a zero span instead of inventing 'under a minute'", () => {
    // A session adopted out of transcript history has createdAt ===
    // lastActiveAt, because nothing has run under our management yet. Showing
    // "Ran for under a minute" there is a number we made up; the pane drops
    // the row on null.
    expect(formatDuration(start, start)).toBeNull();
  });

  it("returns null for an inverted span or an unparseable timestamp", () => {
    expect(formatDuration("2026-01-02T00:00:00.000Z", start)).toBeNull();
    expect(formatDuration(start, "not a date")).toBeNull();
    expect(formatDuration("not a date", start)).toBeNull();
  });
});

describe("historyRowMeta", () => {
  const now = Date.parse("2026-01-01T02:00:00.000Z");

  it("reads relative time off lastActiveAt, not createdAt — a failed resume can't inflate it", () => {
    expect(
      historyRowMeta({ harness: "claude-code", lastActiveAt: "2026-01-01T01:00:00.000Z" }, now),
    ).toBe("Claude Code · 1h ago");
  });

  it("adds branch and turn count when the server parsed them, and drops what's absent", () => {
    expect(
      historyRowMeta(
        {
          harness: "codex",
          gitBranch: "feat/webhook",
          messageCount: 12,
          lastActiveAt: "2026-01-01T01:00:00.000Z",
        },
        now,
      ),
    ).toBe("Codex · feat/webhook · 12 turns · 1h ago");
  });

  it("says 'turn' for one and drops a zero count rather than showing '0 turns'", () => {
    const at = "2026-01-01T01:00:00.000Z";
    expect(historyRowMeta({ harness: "codex", messageCount: 1, lastActiveAt: at }, now)).toContain("1 turn ·");
    expect(historyRowMeta({ harness: "codex", messageCount: 0, lastActiveAt: at }, now)).toBe("Codex · 1h ago");
  });
});
