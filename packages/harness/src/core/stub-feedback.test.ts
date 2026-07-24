import { describe, it, expect } from "vitest";

import type { RunView } from "../shared/types.js";
import { stepIsStubbed, stubNotice } from "./stub-feedback.js";

/** A minimal RunView with two named steps; tests override only the field under
 *  test so each assertion pins exactly one behavior (mutation-first). */
function run(overrides: Partial<RunView> = {}): RunView {
  return {
    executionId: "local-1",
    status: "completed",
    steps: [
      { id: "a-1", name: "a", status: "passed" },
      { id: "b-1", name: "b", status: "passed" },
    ],
    ...overrides,
  };
}

describe("stepIsStubbed", () => {
  it("is true for a step that ran in a stub-served run", () => {
    expect(stepIsStubbed(run({ stubbed: true }), "a")).toBe(true);
  });

  it("is false when the run is not stub-served (prod run has no `stubbed`)", () => {
    // renderRunState never sets `stubbed`; a real run's step gets no chip.
    expect(stepIsStubbed(run({ stubbed: undefined }), "a")).toBe(false);
  });

  it("is false when `stubbed` is explicitly false (never coerce truthiness)", () => {
    expect(stepIsStubbed(run({ stubbed: false }), "a")).toBe(false);
  });

  it("requires `stubbed` to be exactly true, not any truthy value", () => {
    // Guards a mutant that swaps `=== true` for a loose truthiness check.
    expect(stepIsStubbed(run({ stubbed: 1 as unknown as boolean }), "a")).toBe(false);
  });

  it("is false for a step that did NOT run this stub run (not in steps)", () => {
    // A stubbed run + a step name the run never reached → no chip (honesty:
    // the chip means "this step's calls were stub-served", which needs it to
    // have run).
    expect(stepIsStubbed(run({ stubbed: true }), "never-ran")).toBe(false);
  });

  it("is true for each step that DID run in a stub run", () => {
    const r = run({ stubbed: true });
    expect(stepIsStubbed(r, "a")).toBe(true);
    expect(stepIsStubbed(r, "b")).toBe(true);
  });

  it("is false for a null run (nothing observed yet)", () => {
    expect(stepIsStubbed(null, "a")).toBe(false);
  });

  it("matches by exact step name", () => {
    // A prefix/substring must not match — the id key is `name-attempt`, but the
    // chip keys off the step NAME, matched exactly.
    expect(stepIsStubbed(run({ stubbed: true }), "a-1")).toBe(false);
  });
});

describe("stubNotice", () => {
  it("returns null for a null run", () => {
    expect(stubNotice(null)).toBeNull();
  });

  it("returns null for a clean run (no unused stubs, no warnings)", () => {
    expect(stubNotice(run({ stubbed: true }))).toBeNull();
  });

  it("surfaces unusedStubs when present", () => {
    const notice = stubNotice(run({ unusedStubs: [{ step: "a", key: "models.coding.launch" }] }));
    expect(notice?.unusedStubs).toEqual([{ step: "a", key: "models.coding.launch" }]);
  });

  it("surfaces stubWarnings when present", () => {
    const notice = stubNotice(run({ stubWarnings: ["'repositories.list' stub must be an array"] }));
    expect(notice?.stubWarnings).toEqual(["'repositories.list' stub must be an array"]);
  });

  it("omits unusedStubs from the notice when the run's list is empty", () => {
    // Defensive: renderLocalRun drops empties, but the derivation must not
    // report an empty array as a signal either.
    const notice = stubNotice(run({ unusedStubs: [], stubWarnings: ["w"] }));
    expect(notice).not.toBeNull();
    expect(notice).not.toHaveProperty("unusedStubs");
  });

  it("omits stubWarnings from the notice when the run's list is empty", () => {
    const notice = stubNotice(run({ unusedStubs: [{ step: "a", key: "k" }], stubWarnings: [] }));
    expect(notice).not.toBeNull();
    expect(notice).not.toHaveProperty("stubWarnings");
  });

  it("returns null when BOTH signals are empty arrays (no real content)", () => {
    // The empty-object → null fold: two empty arrays carry no signal.
    expect(stubNotice(run({ unusedStubs: [], stubWarnings: [] }))).toBeNull();
  });

  it("carries both signals together when both are present", () => {
    const notice = stubNotice(
      run({
        unusedStubs: [{ step: "a", key: "k1" }],
        stubWarnings: ["w1", "w2"],
      }),
    );
    expect(notice?.unusedStubs).toEqual([{ step: "a", key: "k1" }]);
    expect(notice?.stubWarnings).toEqual(["w1", "w2"]);
  });
});
