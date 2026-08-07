/**
 * Unit test for installProjectDependencies — it must be soft: any failure
 * (here, a non-existent working directory) returns false rather than throwing,
 * so a scaffold/seed that can't install still completes.
 */
import path from "node:path";

import { installProjectDependencies } from "./install-deps";

describe("installProjectDependencies", () => {
  it("returns false (never throws) when the install cannot run", () => {
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

    expect(() => installProjectDependencies(missing)).not.toThrow();
    expect(installProjectDependencies(missing)).toBe(false);
  });
});
