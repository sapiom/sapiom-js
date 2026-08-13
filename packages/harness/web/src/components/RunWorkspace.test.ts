import { describe, expect, it } from "vitest";
import type { StepView } from "@shared/types";

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
