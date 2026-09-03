import { describe, expect, it } from "vitest";

import type { BuilderPlanningSessionBinding } from "../shared/build-plan.js";
import { reconcileKickoffAttempt } from "./builder-planning-session.js";

const binding = (kickoffState: "delivering" | "delivered") =>
  ({
    state: kickoffState === "delivered" ? "planning" : "kickoff-pending",
    kickoff: {
      kickoffId: "kickoff_test",
      inputId: "input_test",
      state: kickoffState,
      attemptCount: 1,
      deliveryClaimId:
        kickoffState === "delivering" ? "delivery-claim_test" : null,
      deliveryClaimedAt:
        kickoffState === "delivering" ? "2026-09-03T11:00:00.000Z" : null,
      deliveredAt:
        kickoffState === "delivered" ? "2026-09-03T11:00:01.000Z" : null,
      acknowledgedBy:
        kickoffState === "delivered"
          ? { source: "hook", observedAt: "2026-09-03T11:00:01.000Z" }
          : null,
    },
    updatedAt: "2026-09-03T11:00:00.000Z",
  }) as BuilderPlanningSessionBinding;

describe("builder kickoff delivery reconciliation", () => {
  it("never downgrades an acknowledgement persisted before submit returns", () => {
    const delivered = binding("delivered");
    expect(
      reconcileKickoffAttempt(delivered, {
        accepted: true,
        ambiguous: false,
        updatedAt: "2026-09-03T11:00:02.000Z",
      }),
    ).toBe(delivered);
  });

  it("surfaces ambiguous delivery and does not make it retryable", () => {
    expect(
      reconcileKickoffAttempt(binding("delivering"), {
        accepted: false,
        ambiguous: true,
        updatedAt: "2026-09-03T11:00:02.000Z",
      }),
    ).toMatchObject({
      state: "delivery-uncertain",
      kickoff: { state: "delivery-uncertain" },
    });
  });
});
