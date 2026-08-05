/**
 * `webappRunUrl` — the run-link contract. The canonical shape
 * (`/agents/<def>/runs/<run>`) mirrors the frontend `runHref`; the null-definition
 * fallback (`/agents/runs/<run>`) mirrors the webapp's id-only resolver route.
 */
import { describe, it, expect } from "vitest";
import { webappRunUrl } from "./webapp-url.js";

describe("webappRunUrl", () => {
  it("builds the canonical /agents/<def>/runs/<run> URL", () => {
    expect(webappRunUrl("https://app.sapiom.ai", "538", "159777")).toBe(
      "https://app.sapiom.ai/agents/538/runs/159777",
    );
  });

  it("falls back to the id-only resolver when definitionId is absent", () => {
    expect(webappRunUrl("https://app.sapiom.ai", null, "159777")).toBe(
      "https://app.sapiom.ai/agents/runs/159777",
    );
    expect(webappRunUrl("https://app.sapiom.ai", undefined, "159777")).toBe(
      "https://app.sapiom.ai/agents/runs/159777",
    );
  });

  it("honours staging and local origins", () => {
    expect(webappRunUrl("https://app.sapiom.dev", "538", "159777")).toBe(
      "https://app.sapiom.dev/agents/538/runs/159777",
    );
    expect(webappRunUrl("http://localhost:2999", "538", "159777")).toBe(
      "http://localhost:2999/agents/538/runs/159777",
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(webappRunUrl("https://app.sapiom.ai/", "538", "159777")).toBe(
      "https://app.sapiom.ai/agents/538/runs/159777",
    );
  });

  it("percent-encodes ids containing URL-significant characters", () => {
    expect(webappRunUrl("https://app.sapiom.ai", "def/1", "run 2")).toBe(
      "https://app.sapiom.ai/agents/def%2F1/runs/run%202",
    );
  });
});
