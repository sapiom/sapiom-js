import { describe, expect, it } from "vitest";

import { IngestCredentialRegistry } from "./ingest-credentials.js";

describe("IngestCredentialRegistry", () => {
  it("binds an opaque credential to exactly one session", () => {
    const tokens = ["token-a", "token-b"];
    const registry = new IngestCredentialRegistry(() => tokens.shift()!);
    const first = registry.issue("session-a");
    const second = registry.issue("session-b");

    expect(registry.authenticate("session-a", first)).toBe(true);
    expect(registry.authenticate("session-b", second)).toBe(true);
    expect(registry.authenticate("session-b", first)).toBe(false);
    expect(registry.authenticate("session-a", second)).toBe(false);
    expect(registry.authenticate("unknown", first)).toBe(false);
  });

  it("rotates on a new launch and revokes on terminal cleanup", () => {
    const tokens = ["old-token", "new-token"];
    const registry = new IngestCredentialRegistry(() => tokens.shift()!);
    const oldToken = registry.issue("session-a");
    const newToken = registry.issue("session-a");

    expect(registry.authenticate("session-a", oldToken)).toBe(false);
    expect(registry.authenticate("session-a", newToken)).toBe(true);
    registry.revoke("session-a");
    expect(registry.authenticate("session-a", newToken)).toBe(false);
  });
});
