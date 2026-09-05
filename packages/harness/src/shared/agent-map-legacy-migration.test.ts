import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseLegacyE2ProposalActor } from "./agent-map-legacy-migration.js";

describe("deployed E2 actor migration isolation", () => {
  it("accepts both persisted E2 actor shapes and rejects unknown authority", () => {
    expect(
      parseLegacyE2ProposalActor({
        userId: "user-1",
        sessionId: "session-1",
        role: "map-planner",
        assignment: null,
      }),
    ).toMatchObject({ userId: "user-1", sessionId: "session-1" });
    expect(
      parseLegacyE2ProposalActor({
        userId: "user-1",
        sessionId: "session-1",
        role: "agent-builder",
        assignment: { kind: "unplanned" },
      }),
    ).toMatchObject({ userId: "user-1", sessionId: "session-1" });
    expect(() =>
      parseLegacyE2ProposalActor({
        userId: "user-1",
        sessionId: "session-1",
        role: "administrator",
        assignment: null,
      }),
    ).toThrow("invalid legacy Agent Map actor");
  });

  it("is referenced by the aggregate migration and no live service module", async () => {
    const shared = dirname(fileURLToPath(import.meta.url));
    const core = join(shared, "..", "core");
    const aggregateMigration = await readFile(
      join(core, "agent-map-aggregate-migration.ts"),
      "utf8",
    );
    expect(aggregateMigration).toContain("parseLegacyE2ProposalActor");

    for (const live of [
      "agent-map-proposal-service.ts",
      "agent-map-version.ts",
      "build-plan-service.ts",
    ]) {
      await expect(readFile(join(core, live), "utf8")).resolves.not.toContain(
        "parseLegacyE2ProposalActor",
      );
    }
  });
});
