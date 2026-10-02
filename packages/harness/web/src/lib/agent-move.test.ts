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

import { refuseMove, remapUnder } from "./agent-move";

const ROOT = "/Users/demo/polsia";
const ADS = `${ROOT}/backend/src/agents/ads`;
const OUTREACH = `${ROOT}/backend/src/agents/outreach`;
const ROLLUP = `${ROOT}/scripts/tools/rollup`;
/** The fixture's second `ads` — the whole reason the collision branch is
 *  reachable at all (see mock-data.ts's deep fixture). */
const ADS_WORKER = `${ROOT}/services/workers/ads`;
const ALL = [ADS, OUTREACH, ROLLUP, ADS_WORKER];

describe("refuseMove — the panel's and the mover's guard", () => {
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
