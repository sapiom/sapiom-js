import { describe, expect, it } from "vitest";

import { deadSessionAction } from "./dead-session-action";

describe("deadSessionAction", () => {
  it("offers nothing while server-backed resumability is unresolved", () => {
    expect(
      deadSessionAction({
        hasAgentSessionId: true,
        resumeMode: undefined,
        recordReady: true,
      }),
    ).toBe("checking");
  });

  it("offers native Resume only for a verified agent conversation", () => {
    expect(
      deadSessionAction({
        hasAgentSessionId: true,
        resumeMode: "agent-resume",
        recordReady: true,
      }),
    ).toBe("resume");
  });

  it("offers portable Continue only when a record is ready", () => {
    expect(
      deadSessionAction({
        hasAgentSessionId: true,
        resumeMode: "rehydrate",
        recordReady: true,
      }),
    ).toBe("continue");
    expect(
      deadSessionAction({
        hasAgentSessionId: false,
        resumeMode: "rehydrate",
        recordReady: false,
      }),
    ).toBe("blocked");
  });
});
