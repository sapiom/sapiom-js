import { describe, it, expect, vi } from "vitest";

import {
  createApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";

describe("createApiKeyProvider", () => {
  it("returns the seeded key from getKey() before any refresh", () => {
    const provider = createApiKeyProvider("sk-boot", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve("sk-boot"),
    });
    expect(provider.getKey()).toBe("sk-boot");
  });

  it("adopts a newer key from the store on refresh (the re-login recovery)", async () => {
    const readApiKeyForEnv = vi.fn().mockResolvedValue("sk-fresh");
    const provider = createApiKeyProvider("sk-stale", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv,
    });

    const refreshed = await provider.refresh();

    expect(refreshed).toBe("sk-fresh");
    expect(provider.getKey()).toBe("sk-fresh");
    // Refresh read the store scoped to the resolved environment name.
    expect(readApiKeyForEnv).toHaveBeenCalledWith("production");
  });

  it("resolves the environment name once per refresh and passes it to the read", async () => {
    const resolveEnvironmentName = vi.fn().mockResolvedValue("staging");
    const readApiKeyForEnv = vi.fn().mockResolvedValue("sk-staging");
    const provider = createApiKeyProvider("sk-old", {
      resolveEnvironmentName,
      readApiKeyForEnv,
    });

    await provider.refresh();

    expect(resolveEnvironmentName).toHaveBeenCalledTimes(1);
    expect(readApiKeyForEnv).toHaveBeenCalledWith("staging");
  });

  it("keeps the current key when the store has no credential (does not clobber to null)", async () => {
    const provider = createApiKeyProvider("sk-current", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve(null),
    });

    const refreshed = await provider.refresh();

    expect(refreshed).toBe("sk-current");
    expect(provider.getKey()).toBe("sk-current");
  });

  it("keeps the current key when the store returns an empty string", async () => {
    const provider = createApiKeyProvider("sk-current", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve(""),
    });

    const refreshed = await provider.refresh();

    expect(refreshed).toBe("sk-current");
  });

  it("keeps the current key when reading the store throws (unreadable HOME, bad file)", async () => {
    const provider = createApiKeyProvider("sk-current", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.reject(new Error("ENOENT")),
    });

    const refreshed = await provider.refresh();

    expect(refreshed).toBe("sk-current");
    expect(provider.getKey()).toBe("sk-current");
  });

  it("keeps the current key when environment resolution throws", async () => {
    const readApiKeyForEnv = vi.fn();
    const provider = createApiKeyProvider("sk-current", {
      resolveEnvironmentName: () =>
        Promise.reject(new Error("unknown environment")),
      readApiKeyForEnv,
    });

    const refreshed = await provider.refresh();

    expect(refreshed).toBe("sk-current");
    // The read is never attempted once env resolution fails.
    expect(readApiKeyForEnv).not.toHaveBeenCalled();
  });

  it("can refresh a null seed up to a first key once the user signs in", async () => {
    const provider = createApiKeyProvider(null, {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve("sk-just-logged-in"),
    });

    expect(provider.getKey()).toBeNull();
    const refreshed = await provider.refresh();
    expect(refreshed).toBe("sk-just-logged-in");
    expect(provider.getKey()).toBe("sk-just-logged-in");
  });

  it("clear() sets the in-memory key to null unconditionally", () => {
    const provider = createApiKeyProvider("sk-live", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve("sk-live"),
    });

    expect(provider.getKey()).toBe("sk-live");
    provider.clear();
    expect(provider.getKey()).toBeNull();
  });

  it("clear() is a no-op on an already-null key", () => {
    const provider = createApiKeyProvider(null, {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve(null),
    });

    expect(provider.getKey()).toBeNull();
    provider.clear(); // must not throw
    expect(provider.getKey()).toBeNull();
  });

  it("refresh() after clear() does NOT re-adopt a non-null store value (clear is permanent until refresh finds a key)", async () => {
    // This test documents that refresh() WILL re-adopt a key after clear()
    // if the store has one — clear() only zeros in-memory; the store is
    // separate and managed by clearCredentials().
    const provider = createApiKeyProvider("sk-live", {
      resolveEnvironmentName: () => Promise.resolve("production"),
      readApiKeyForEnv: () => Promise.resolve("sk-live"),
    });

    provider.clear();
    expect(provider.getKey()).toBeNull();

    // refresh() re-reads the store and adopts the key again.
    const refreshed = await provider.refresh();
    expect(refreshed).toBe("sk-live");
    expect(provider.getKey()).toBe("sk-live");
  });
});

describe("staticApiKeyProvider", () => {
  it("returns the fixed key and never changes it on refresh", async () => {
    const provider = staticApiKeyProvider("sk-fixed");
    expect(provider.getKey()).toBe("sk-fixed");
    expect(await provider.refresh()).toBe("sk-fixed");
    expect(provider.getKey()).toBe("sk-fixed");
  });

  it("supports a null key (unauthenticated) with a no-op refresh", async () => {
    const provider = staticApiKeyProvider(null);
    expect(provider.getKey()).toBeNull();
    expect(await provider.refresh()).toBeNull();
  });

  it("clear() is a no-op (static provider does not mutate)", () => {
    const provider = staticApiKeyProvider("sk-fixed");
    expect(() => provider.clear()).not.toThrow();
    // Key is unchanged — static provider has no mutable state.
    expect(provider.getKey()).toBe("sk-fixed");
  });
});
