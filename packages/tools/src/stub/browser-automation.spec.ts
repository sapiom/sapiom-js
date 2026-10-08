import { createStubClient } from "./index.js";

describe("browser automation session timeout stubs", () => {
  it("uses the requested maximum duration in the returned session", async () => {
    const session = await createStubClient().browserAutomation.sessions.create({
      maxDurationMinutes: 60,
    });

    expect(session.maxDurationSec).toBe(3600);
    expect(session.idleTimeoutMinutes).toBe(5);
    expect(session.maxDurationMinutes).toBe(60);
  });
});
