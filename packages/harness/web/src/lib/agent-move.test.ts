/**
 * The move's DECISION, pinned (SAP-2930).
 *
 * Cases ported from the reference prototype's `lib/agent-move.test.ts` and
 * `lib/api-move.test.ts` — including the two that only exist because the
 * prototype got them wrong: a directory refusing its OWN move once it has
 * children (every path under `from` travels, so none of them is the thing at
 * the destination), and a destination that merely shares a name PREFIX
 * (`agents/ads-v2` is not `agents/ads`, and a `startsWith` without the
 * separator called it occupied).
 */
import { describe, expect, it } from "vitest";

import { applyMove, planMove, refuseMove, remapUnder } from "./agent-move";

const ROOT = "/Users/demo/polsia";
const ADS = `${ROOT}/backend/src/agents/ads`;
const OUTREACH = `${ROOT}/backend/src/agents/outreach`;
const ROLLUP = `${ROOT}/scripts/tools/rollup`;
/** The fixture's second `ads` — the whole reason the collision branch is
 *  reachable at all (see mock-data.ts's deep fixture). */
const ADS_WORKER = `${ROOT}/services/workers/ads`;
const ALL = [ADS, OUTREACH, ROLLUP, ADS_WORKER];

describe("planMove", () => {
  it("plans a move into another directory", () => {
    expect(planMove(ROLLUP, `${ROOT}/services`, ALL)).toEqual({
      ok: true,
      from: ROLLUP,
      to: `${ROOT}/services/rollup`,
      name: "rollup",
    });
  });

  it("refuses a move that would land on an agent of the same name", () => {
    const plan = planMove(ADS_WORKER, `${ROOT}/backend/src/agents`, ALL);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("agents already has an agent called ads.");
  });

  it("refuses a destination that is a DIRECTORY holding an agent", () => {
    // Nothing is registered at `services/workers` itself, but an agent lives
    // inside it, so the directory exists and a move onto it would land on top
    // of a tree. A path list can see that much; the endpoint stats the rest.
    const plan = planMove(ROLLUP, `${ROOT}/services`, [...ALL, `${ROOT}/services/rollup/inner`]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("already has an agent called rollup");
  });

  it("treats a drop into its CURRENT folder as a silent no-op", () => {
    const plan = planMove(ADS, `${ROOT}/backend/src/agents`, ALL);
    expect(plan.ok).toBe(false);
    // An empty reason is the whole point: nothing to say, so nothing is said.
    if (!plan.ok) expect(plan.reason).toBe("");
  });

  it("is silent about the current folder even when it is spelled with a trailing slash", () => {
    const plan = planMove(ADS, `${ROOT}/backend/src/agents/`, ALL);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("");
  });

  it("refuses moving a directory inside its own subtree", () => {
    const plan = planMove(ADS, `${ADS}/steps`, ALL);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("Can't move ads inside itself.");
  });

  it("refuses moving an agent onto itself", () => {
    const plan = planMove(ADS, ADS, ALL);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("Can't move ads into itself.");
  });

  it("does not let the moving subtree refuse its own move", () => {
    // `ads` plus an agent nested inside it. Both travel, so neither is the
    // thing already at the destination — without that exclusion every move of
    // a directory with children would refuse itself.
    const nested = `${ADS}/reporter`;
    expect(planMove(ADS, `${ROOT}/packages`, [ADS, nested]).ok).toBe(true);
  });

  it("is not fooled by a destination that merely shares a name prefix", () => {
    // `agents/ads-v2` is not `agents/ads`; a startsWith check without the
    // separator would have called the destination occupied.
    expect(planMove(`${ROOT}/packages/ads-v2`, `${ROOT}/backend/src/agents`, ALL)).toEqual({
      ok: true,
      from: `${ROOT}/packages/ads-v2`,
      to: `${ROOT}/backend/src/agents/ads-v2`,
      name: "ads-v2",
    });
  });

  it("keeps the destination in the source's native separator on Windows", () => {
    const plan = planMove("C:\\Users\\demo\\polsia\\ads", "C:\\Users\\demo\\polsia\\services", []);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.to).toBe("C:\\Users\\demo\\polsia\\services\\ads");
  });
});

describe("refuseMove — the mover's own guard, planner bypassed", () => {
  it("allows a move to an unoccupied destination", () => {
    expect(refuseMove(ALL, ROLLUP, `${ROOT}/services/rollup`)).toBeNull();
  });

  it("refuses a destination another agent already occupies", () => {
    const refusal = refuseMove(ALL, ADS_WORKER, ADS);
    expect(refusal).toContain("already exists");
    expect(refusal).toContain("ads");
  });

  it("refuses a destination that is a directory HOLDING an agent", () => {
    // Nothing is registered at `services/workers` itself, but an agent lives
    // inside it, so a move onto it would land on top of a tree.
    expect(refuseMove(ALL, ROLLUP, `${ROOT}/services/workers`)).toContain("already exists");
  });

  it("refuses a move into the moving directory's own subtree", () => {
    expect(refuseMove(ALL, ADS, `${ADS}/nested`)).toBe("Can't move ads inside itself.");
  });

  it("treats a `to` that equals `from` as nothing to refuse", () => {
    expect(refuseMove(ALL, ADS, ADS)).toBeNull();
  });

  it("does not let the moving subtree refuse its own move", () => {
    expect(refuseMove([ADS, `${ADS}/reporter`], ADS, `${ROOT}/packages/ads`)).toBeNull();
  });

  it("is not fooled by a destination that merely shares a prefix", () => {
    expect(refuseMove(ALL, ADS_WORKER, `${ROOT}/backend/src/agents/ads-v2`)).toBeNull();
  });
});

describe("remapUnder", () => {
  it("rewrites the moved directory itself", () => {
    expect(remapUnder(ADS, ADS, `${ROOT}/services/ads`)).toBe(`${ROOT}/services/ads`);
  });

  it("carries a NESTED path along with its parent directory", () => {
    expect(remapUnder(`${ADS}/sub/creative`, ADS, `${ROOT}/services/ads`)).toBe(
      `${ROOT}/services/ads/sub/creative`,
    );
  });

  it("carries a SESSION cwd that sat inside the moved tree", () => {
    // The same rule, applied to the other thing keyed by location: a session
    // rooted inside the move would otherwise point at a directory that is gone.
    expect(remapUnder(`${ADS}/.worktrees/wip`, ADS, `${ROOT}/packages/ads`)).toBe(
      `${ROOT}/packages/ads/.worktrees/wip`,
    );
  });

  it("leaves a mere name-prefix sibling alone", () => {
    expect(remapUnder(`${ADS}-v2`, ADS, `${ROOT}/services/ads`)).toBe(`${ADS}-v2`);
  });

  it("tolerates a trailing separator on `from`", () => {
    expect(remapUnder(`${ADS}/sub`, `${ADS}/`, `${ROOT}/services/ads`)).toBe(
      `${ROOT}/services/ads/sub`,
    );
  });
});

describe("applyMove", () => {
  it("moves the parent and everything under it, and nothing else", () => {
    const nested = `${ADS}/sub/creative`;
    expect(applyMove([ADS, nested, OUTREACH], ADS, `${ROOT}/services/ads`)).toEqual([
      `${ROOT}/services/ads`,
      `${ROOT}/services/ads/sub/creative`,
      OUTREACH,
    ]);
  });

  it("leaves unrelated paths untouched", () => {
    expect(applyMove(ALL, `${ROOT}/nope`, `${ROOT}/elsewhere`)).toEqual(ALL);
  });
});
