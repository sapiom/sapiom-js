import { describe, expect, it } from "vitest";

import { IngestCredentialRegistry } from "./ingest-credentials.js";

describe("IngestCredentialRegistry", () => {
  it("binds an opaque credential to exactly one session", () => {
    const tokens = ["token-a", "token-b"];
    const epochs = ["epoch-a", "epoch-b"];
    const registry = new IngestCredentialRegistry(
      () => tokens.shift()!,
      () => epochs.shift()!,
    );
    const first = registry.issue("session-a");
    const second = registry.issue("session-b");

    expect(first).toEqual({ token: "token-a", runtimeEpoch: "epoch-a" });
    expect(second).toEqual({ token: "token-b", runtimeEpoch: "epoch-b" });
    expect(registry.authenticate("session-a", first.token)).toBe("epoch-a");
    expect(registry.authenticate("session-b", second.token)).toBe("epoch-b");
    expect(registry.authenticate("session-b", first.token)).toBeNull();
    expect(registry.authenticate("session-a", second.token)).toBeNull();
    expect(registry.authenticate("unknown", first.token)).toBeNull();
  });

  it("rotates on a new launch and revokes on terminal cleanup", () => {
    const tokens = ["old-token", "new-token"];
    const epochs = ["old-epoch", "new-epoch"];
    const registry = new IngestCredentialRegistry(
      () => tokens.shift()!,
      () => epochs.shift()!,
    );
    const oldToken = registry.issue("session-a");
    const newToken = registry.issue("session-a");

    expect(registry.authenticate("session-a", oldToken.token)).toBeNull();
    expect(registry.authenticate("session-a", newToken.token)).toBe(
      "new-epoch",
    );
    registry.revoke("session-a");
    expect(registry.authenticate("session-a", newToken.token)).toBeNull();
  });
});
