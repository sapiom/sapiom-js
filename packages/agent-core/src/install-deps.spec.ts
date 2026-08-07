/**
 * Unit test for installProjectDependencies — it must be soft: any failure
 * (here, a non-existent working directory) returns false rather than throwing,
 * so a scaffold/seed that can't install still completes.
 */
import path from "node:path";

import { installProjectDependencies } from "./install-deps";

describe("installProjectDependencies", () => {
  it("resolves false (never rejects) when the install cannot run", async () => {
    // A directory that does not exist makes the npm spawn fail immediately —
    // no network, deterministic — exercising the best-effort catch.
    const missing = path.join(
      "/",
      "definitely",
      "not",
      "a",
      "real",
      "dir",
      `${process.pid}`,
    );

    await expect(installProjectDependencies(missing)).resolves.toBe(false);
  });
});
