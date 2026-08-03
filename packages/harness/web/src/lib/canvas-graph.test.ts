import { describe, expect, it } from "vitest";

import { nodeKindLabel } from "./canvas-graph";

describe("nodeKindLabel", () => {
  it("renders the private launched-workflow kind as a launched agent", () => {
    expect(nodeKindLabel("launched-workflow")).toBe("Launched agent");
  });
});
