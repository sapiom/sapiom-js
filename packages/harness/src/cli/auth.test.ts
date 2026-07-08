import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveEnvironment = vi.fn();
const readCredentials = vi.fn();
const writeCredentials = vi.fn();
const performBrowserAuth = vi.fn();

vi.mock("@sapiom/mcp/auth", () => ({
  resolveEnvironment: (...args: unknown[]) => resolveEnvironment(...args),
  readCredentials: (...args: unknown[]) => readCredentials(...args),
  writeCredentials: (...args: unknown[]) => writeCredentials(...args),
  performBrowserAuth: (...args: unknown[]) => performBrowserAuth(...args),
}));

import { ensureAuthenticated } from "./auth.js";

const env = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

describe("ensureAuthenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEnvironment.mockResolvedValue(env);
  });

  it("returns null and touches nothing when noAuth is set", async () => {
    const result = await ensureAuthenticated({ interactive: true, noAuth: true });
    expect(result).toBeNull();
    expect(resolveEnvironment).not.toHaveBeenCalled();
  });

  it("returns the cached identity without opening a browser", async () => {
    readCredentials.mockResolvedValue({
      apiKey: "key-1",
      tenantId: "tenant-1",
      organizationName: "Acme",
      apiKeyId: "apikey-1",
    });

    const result = await ensureAuthenticated({ interactive: true });

    expect(result).toEqual({
      userId: "tenant-1",
      tenantId: "tenant-1",
      organizationName: "Acme",
      apiKey: "key-1",
      source: "cached",
    });
    expect(performBrowserAuth).not.toHaveBeenCalled();
  });

  it("returns null when not interactive and nothing is cached", async () => {
    readCredentials.mockResolvedValue(null);
    const result = await ensureAuthenticated({ interactive: false });
    expect(result).toBeNull();
    expect(performBrowserAuth).not.toHaveBeenCalled();
  });

  it("runs browser auth and persists credentials when interactive with nothing cached", async () => {
    readCredentials.mockResolvedValue(null);
    performBrowserAuth.mockResolvedValue({
      apiKey: "key-2",
      tenantId: "tenant-2",
      organizationName: "Beta",
      apiKeyId: "apikey-2",
    });

    const result = await ensureAuthenticated({ interactive: true });

    expect(performBrowserAuth).toHaveBeenCalledWith(env.appURL, env.apiURL);
    expect(writeCredentials).toHaveBeenCalledWith(env.name, env.appURL, env.apiURL, {
      apiKey: "key-2",
      tenantId: "tenant-2",
      organizationName: "Beta",
      apiKeyId: "apikey-2",
    });
    expect(result).toEqual({
      userId: "tenant-2",
      tenantId: "tenant-2",
      organizationName: "Beta",
      apiKey: "key-2",
      source: "fresh",
    });
  });

  it("passes an explicit environment override through to resolveEnvironment", async () => {
    readCredentials.mockResolvedValue(null);
    await ensureAuthenticated({ interactive: false, environment: "staging" });
    expect(resolveEnvironment).toHaveBeenCalledWith("staging");
  });
});
