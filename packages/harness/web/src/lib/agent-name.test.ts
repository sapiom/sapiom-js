import { describe, expect, it } from "vitest";

import { displayAgentName } from "./agent-name";

describe("displayAgentName", () => {
  it("strips the npm scope and a leading example- from gallery clones", () => {
    expect(displayAgentName("@sapiom/example-newsletter-autopilot")).toBe(
      "newsletter-autopilot",
    );
    expect(displayAgentName("@sapiom/example-content-repurposing-pipeline")).toBe(
      "content-repurposing-pipeline",
    );
  });

  it("strips a bare npm scope with no example- prefix", () => {
    expect(displayAgentName("@acme/rfq-agent")).toBe("rfq-agent");
  });

  it("leaves an already-short, unscoped name untouched", () => {
    expect(displayAgentName("rfq")).toBe("rfq");
    expect(displayAgentName("leasing")).toBe("leasing");
  });

  it("falls back to the raw name when stripping would leave nothing", () => {
    expect(displayAgentName("@sapiom/")).toBe("@sapiom/");
    expect(displayAgentName("example-")).toBe("example-");
  });
});
