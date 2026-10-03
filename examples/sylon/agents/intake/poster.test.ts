import { describe, expect, it } from "vitest";

import { classifyPoster } from "./poster";

const base = { user: "U1", envelopeTeamId: "T_US" };

describe("classifyPoster", () => {
  it("is team when the poster's workspace is ours", () => {
    expect(classifyPoster({ ...base, userTeam: "T_US" })).toBe("team");
  });

  it("is customer when user_team is another workspace, even if event.team is ours", () => {
    expect(classifyPoster({ ...base, userTeam: "T_THEM", team: "T_US" })).toBe(
      "customer",
    );
  });

  it("falls back to event.team, then to the envelope workspace", () => {
    expect(classifyPoster({ ...base, team: "T_THEM" })).toBe("customer");
    expect(classifyPoster({ ...base, team: "T_US" })).toBe("team");
    expect(classifyPoster(base)).toBe("team");
  });

  it("uses team.slack_team_ids when set, in place of the envelope workspace", () => {
    const teamSlackTeamIds = ["T_US", "T_PARTNER"];
    expect(
      classifyPoster({ ...base, userTeam: "T_PARTNER", teamSlackTeamIds }),
    ).toBe("team");
    expect(
      classifyPoster({ ...base, userTeam: "T_THEM", teamSlackTeamIds }),
    ).toBe("customer");
    expect(classifyPoster({ ...base, teamSlackTeamIds: ["T_OTHER"] })).toBe(
      "customer",
    );
  });

  it("treats a listed test user as the customer, even from our workspace", () => {
    const testUserIds = ["U1"];
    expect(classifyPoster({ ...base, userTeam: "T_US", testUserIds })).toBe(
      "customer",
    );
    expect(
      classifyPoster({ ...base, user: "U2", userTeam: "T_US", testUserIds }),
    ).toBe("team");
  });
});
