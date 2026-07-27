import { describe, expect, it } from "vitest";

import { formatDuration, historyRowMeta } from "./history-meta";

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
