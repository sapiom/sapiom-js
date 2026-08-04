import { describe, expect, it, vi } from "vitest";

import type { DesktopAuthenticate } from "./desktop-auth.js";
import { resolveDesktopIdentity } from "./desktop-auth.js";

const IDENTITY = {
  userId: "tenant-1",
  tenantId: "tenant-1",
  organizationName: "Example",
  apiKey: "sk-test",
  source: "cached" as const,
};

describe("resolveDesktopIdentity", () => {
  it("reuses a cached credential without opening browser auth", async () => {
    const authenticate = vi
      .fn<DesktopAuthenticate>()
      .mockResolvedValue(IDENTITY);
    const beforeInteractive = vi.fn();

    await expect(
      resolveDesktopIdentity({ authenticate, smoke: false, beforeInteractive }),
    ).resolves.toEqual({ identity: IDENTITY, error: null });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ interactive: false });
    expect(beforeInteractive).not.toHaveBeenCalled();
  });

  it("opens browser auth after an empty cache probe", async () => {
    const authenticate = vi
      .fn<DesktopAuthenticate>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...IDENTITY, source: "fresh" });
    const beforeInteractive = vi.fn();

    await expect(
      resolveDesktopIdentity({ authenticate, smoke: false, beforeInteractive }),
    ).resolves.toEqual({
      identity: { ...IDENTITY, source: "fresh" },
      error: null,
    });
    expect(authenticate).toHaveBeenNthCalledWith(1, { interactive: false });
    expect(authenticate).toHaveBeenNthCalledWith(2, { interactive: true });
    expect(beforeInteractive).toHaveBeenCalledOnce();
  });

  it("does not open a browser in smoke mode", async () => {
    const authenticate = vi.fn<DesktopAuthenticate>().mockResolvedValue(null);

    await expect(
      resolveDesktopIdentity({ authenticate, smoke: true }),
    ).resolves.toEqual({ identity: null, error: null });
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("continues signed out when interactive authentication is cancelled", async () => {
    const cancelled = new Error("Authentication cancelled");
    const authenticate = vi
      .fn<DesktopAuthenticate>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(cancelled);

    await expect(
      resolveDesktopIdentity({ authenticate, smoke: false }),
    ).resolves.toEqual({ identity: null, error: cancelled });
  });

  it("continues signed out when the cache probe fails", async () => {
    const failure = new Error("Credential store unavailable");
    const authenticate = vi
      .fn<DesktopAuthenticate>()
      .mockRejectedValue(failure);

    await expect(
      resolveDesktopIdentity({ authenticate, smoke: false }),
    ).resolves.toEqual({ identity: null, error: failure });
    expect(authenticate).toHaveBeenCalledTimes(1);
  });
});
