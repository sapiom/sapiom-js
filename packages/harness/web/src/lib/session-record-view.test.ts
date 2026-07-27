import { describe, expect, it } from "vitest";
import type { SessionRecordLimitation } from "@shared/types";

import { describeLimitations, formatClockTime, formatUsage, toolCallLabel } from "./session-record-view";

describe("describeLimitations", () => {
  it("names every gap the server reported, in a stable order", () => {
    const notes = describeLimitations([
      "incomplete-final-turn",
      "truncated-tool-output",
      "assistant-narration-gap",
    ]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/final assistant message/);
    expect(notes[1]).toMatch(/truncated/);
    expect(notes[2]).toMatch(/never completed/);
  });

  it("is empty when the record claims no gaps", () => {
    expect(describeLimitations([])).toEqual([]);
  });

  it("dedupes repeated codes", () => {
    expect(describeLimitations(["truncated-tool-output", "truncated-tool-output"])).toHaveLength(1);
  });

  it("still surfaces a code it doesn't recognize — an unexplained gap is worse than an unpolished one", () => {
    // A newer server reporting a limitation this build predates.
    const notes = describeLimitations(["tool-input-truncated" as SessionRecordLimitation]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("tool-input-truncated");
  });
});

describe("formatUsage", () => {
  it("formats both directions, abbreviating thousands", () => {
    expect(formatUsage({ inputTokens: 18420, outputTokens: 612 })).toBe("18.4k in · 612 out");
    expect(formatUsage({ inputTokens: 120_000, outputTokens: 9500 })).toBe("120k in · 9.5k out");
  });

  it("shows only the half it has, and nothing at all when it has neither", () => {
    expect(formatUsage({ inputTokens: 500, outputTokens: null })).toBe("500 in");
    expect(formatUsage({ inputTokens: null, outputTokens: 20 })).toBe("20 out");
    expect(formatUsage({ inputTokens: null, outputTokens: null })).toBeNull();
    expect(formatUsage(null)).toBeNull();
  });
});

describe("formatClockTime", () => {
  it("returns null rather than 'Invalid Date' for missing or broken timestamps", () => {
    expect(formatClockTime(null)).toBeNull();
    expect(formatClockTime("not a date")).toBeNull();
  });

  it("formats a real timestamp", () => {
    expect(formatClockTime("2026-07-01T10:00:00.000Z")).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("toolCallLabel", () => {
  it("pairs the tool name with a flattened, clipped input", () => {
    expect(toolCallLabel("Read", '{"file_path":"/repo/index.ts"}')).toBe('Read · {"file_path":"/repo/index.ts"}');
    expect(toolCallLabel("Bash", "line one\n  line two")).toBe("Bash · line one line two");
  });

  it("clips a long input", () => {
    const label = toolCallLabel("Edit", "x".repeat(500));
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThan(120);
  });

  it("degrades honestly when the event recorded no name or no input", () => {
    expect(toolCallLabel(null, null)).toBe("unknown tool");
    expect(toolCallLabel("Read", null)).toBe("Read");
    expect(toolCallLabel("Read", "   ")).toBe("Read");
  });
});
