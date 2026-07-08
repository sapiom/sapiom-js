import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectInterconnections } from "./canvas-interconnections.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("detectInterconnections", () => {
  it("finds an orchestrations.launch({ definition }) call and resolves it against a known workflow's manifest name", async () => {
    const edges = await detectInterconnections([
      { path: path.join(FIXTURES_DIR, "hub"), manifestName: "hub-workflow" },
      { path: path.join(FIXTURES_DIR, "spoke"), manifestName: "spoke-workflow" },
    ]);
    expect(edges).toEqual([{ fromManifestName: "hub-workflow", toManifestName: "spoke-workflow", toSlug: "spoke-workflow" }]);
  });

  it("leaves toManifestName null when the referenced slug doesn't match any known workflow", async () => {
    const edges = await detectInterconnections([{ path: path.join(FIXTURES_DIR, "hub"), manifestName: "hub-workflow" }]);
    expect(edges).toEqual([{ fromManifestName: "hub-workflow", toManifestName: null, toSlug: "spoke-workflow" }]);
  });

  it("finds nothing in a project with no orchestrations.launch calls", async () => {
    const edges = await detectInterconnections([{ path: path.join(FIXTURES_DIR, "order-triage"), manifestName: "order-triage" }]);
    expect(edges).toEqual([]);
  });

  it("never throws for a directory that doesn't exist", async () => {
    await expect(detectInterconnections([{ path: path.join(FIXTURES_DIR, "does-not-exist"), manifestName: "x" }])).resolves.toEqual(
      [],
    );
  });
});
