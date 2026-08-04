import { describe, expect, it } from "vitest";
import type { RunView } from "@shared/types";

import { runStepFor } from "./run-step";

describe("runStepFor", () => {
  it("returns the latest attempt when a step was retried", () => {
    const first = { name: "collect", status: "failed" };
    const retry = { name: "collect", status: "passed" };
    const run = { steps: [first, retry] } as RunView;

    expect(runStepFor(run, "collect")).toBe(retry);
  });

  it("returns null without a run or matching step", () => {
    expect(runStepFor(null, "collect")).toBeNull();
    expect(
      runStepFor({ steps: [] } as unknown as RunView, "collect"),
    ).toBeNull();
  });
});
