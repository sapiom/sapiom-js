import { describe, expect, it } from "vitest";

import { type HarnessView, journeyForView } from "./journeys";

describe("journeyForView", () => {
  it("returns unknown for null/undefined/empty", () => {
    expect(journeyForView(null)).toBe("unknown");
    expect(journeyForView(undefined)).toBe("unknown");
    expect(journeyForView({})).toBe("unknown");
  });

  it("classifies the settings surface as account, above everything else", () => {
    const view: HarnessView = { settingsOpen: true, hasLiveSession: true, templatesOpen: true };
    expect(journeyForView(view)).toBe("account");
  });

  it("classifies the first-run welcome (no session) as onboarding", () => {
    expect(journeyForView({ firstRun: true, hasLiveSession: false })).toBe("onboarding");
  });

  it("does NOT treat first-run as onboarding once a session is live", () => {
    expect(journeyForView({ firstRun: true, hasLiveSession: true })).toBe("agent_build");
  });

  it("classifies browsing templates as agent_build (the authoring on-ramp)", () => {
    expect(journeyForView({ templatesOpen: true })).toBe("agent_build");
  });

  it("splits a live session by right tab: operate vs observe vs build", () => {
    expect(journeyForView({ hasLiveSession: true, rightTab: "canvas" })).toBe("agent_operate");
    expect(journeyForView({ hasLiveSession: true, rightTab: "preview" })).toBe("agent_operate");
    expect(journeyForView({ hasLiveSession: true, rightTab: "logs" })).toBe("agent_observe");
    expect(journeyForView({ hasLiveSession: true, rightTab: "diff" })).toBe("agent_observe");
    // Chatting/iterating with no operate tab focused is authoring.
    expect(journeyForView({ hasLiveSession: true, rightTab: "steps" })).toBe("agent_build");
    expect(journeyForView({ hasLiveSession: true, rightTab: null })).toBe("agent_build");
  });

  it("classifies inspecting a dead session as observe", () => {
    expect(journeyForView({ hasLiveSession: false, inspectingDeadSession: true })).toBe("agent_observe");
  });
});
