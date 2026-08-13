import { describe, expect, it } from "vitest";
import type { StepView } from "@shared/types";

import { artifactTextPreview } from "./ArtifactRenderer";
import { chronologicalAttempts } from "./RunWorkspace";

function step(id: string, startedAt?: string): StepView {
  return { id, name: id, attempt: 1, status: "passed", startedAt };
}

describe("chronologicalAttempts", () => {
  it("orders recorded timestamps and preserves source order for ties/absence", () => {
    expect(
      chronologicalAttempts([
        step("late", "2026-01-01T00:00:02Z"),
        step("early", "2026-01-01T00:00:01Z"),
        step("unknown-a"),
        step("unknown-b"),
      ]).map((item) => item.id),
    ).toEqual(["early", "late", "unknown-a", "unknown-b"]);
  });
});

describe("artifactTextPreview", () => {
  it("recognises HTML and applies a deterministic content budget", () => {
    const tail = "TAIL_MUST_STAY_COLLAPSED";
    const preview = artifactTextPreview(
      `<!doctype html><html><body>${"weather ".repeat(300)}${tail}</body></html>`,
    );

    expect(preview.kind).toBe("html");
    expect(preview.truncated).toBe(true);
    expect(preview.preview).toContain("<!doctype html>");
    expect(preview.preview).not.toContain(tail);
    expect(preview.omittedCharacters).toBeGreaterThan(0);
  });

  it("does not truncate short plain text", () => {
    expect(artifactTextPreview("A concise result")).toEqual({
      kind: "text",
      truncated: false,
      preview: "A concise result",
      omittedCharacters: 0,
    });
  });
});
