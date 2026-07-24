import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLastDeploy, relativeTime, saveLastDeploy } from "./deploy-meta";

// ---------------------------------------------------------------------------
// localStorage stub — vitest runs in Node (no jsdom), so we stub the global.
// Mirrors the pattern in RunInputDialog.test.ts.
// ---------------------------------------------------------------------------

function makeLocalStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  } as Storage;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("saveLastDeploy / loadLastDeploy", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a deploy meta record by workflow path", () => {
    const path = "/Users/demo/acme-app/leasing";
    const meta = { buildRunId: "build-abc", deployedAt: 1_700_000_000_000 };
    saveLastDeploy(path, meta);
    expect(loadLastDeploy(path)).toEqual(meta);
  });

  it("returns null for an unknown path (key absent)", () => {
    expect(loadLastDeploy("/Users/demo/never-saved")).toBeNull();
  });

  it("returns null when stored JSON is malformed (broken storage)", () => {
    const mock = makeLocalStorageMock();
    mock.setItem("sapiom:deploy-meta:" + encodeURIComponent("/bad"), "not-json{{{");
    vi.stubGlobal("localStorage", mock);
    expect(loadLastDeploy("/bad")).toBeNull();
  });

  it("returns null when stored value lacks required fields", () => {
    const mock = makeLocalStorageMock();
    mock.setItem("sapiom:deploy-meta:" + encodeURIComponent("/partial"), JSON.stringify({ buildRunId: "x" }));
    vi.stubGlobal("localStorage", mock);
    expect(loadLastDeploy("/partial")).toBeNull();
  });

  it("returns null when stored value has wrong field types", () => {
    const mock = makeLocalStorageMock();
    mock.setItem("sapiom:deploy-meta:" + encodeURIComponent("/wrong-types"), JSON.stringify({ buildRunId: 42, deployedAt: "not-a-number" }));
    vi.stubGlobal("localStorage", mock);
    expect(loadLastDeploy("/wrong-types")).toBeNull();
  });

  it("different workflow paths store independently", () => {
    const pathA = "/Users/demo/alpha";
    const pathB = "/Users/demo/beta";
    saveLastDeploy(pathA, { buildRunId: "build-a", deployedAt: 1_000 });
    saveLastDeploy(pathB, { buildRunId: "build-b", deployedAt: 2_000 });
    expect(loadLastDeploy(pathA)).toEqual({ buildRunId: "build-a", deployedAt: 1_000 });
    expect(loadLastDeploy(pathB)).toEqual({ buildRunId: "build-b", deployedAt: 2_000 });
  });

  it("saveLastDeploy is non-fatal when localStorage throws", () => {
    const brokenMock = makeLocalStorageMock();
    brokenMock.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", brokenMock);
    expect(() => saveLastDeploy("/quota-exceeded", { buildRunId: "x", deployedAt: 0 })).not.toThrow();
  });

  it("loadLastDeploy is non-fatal when localStorage throws", () => {
    const brokenMock = makeLocalStorageMock();
    brokenMock.getItem = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", brokenMock);
    expect(loadLastDeploy("/security-error")).toBeNull();
  });
});

describe("relativeTime", () => {
  it("returns 'just now' when under 60 seconds", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now, now + 59_000)).toBe("just now");
  });

  it("returns minute bucket at the 60s boundary", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now, now + 60_000)).toBe("1m ago");
    expect(relativeTime(now, now + 5 * MINUTE)).toBe("5m ago");
    expect(relativeTime(now, now + 59 * MINUTE)).toBe("59m ago");
  });

  it("returns hour bucket at the 60-minute boundary", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now, now + HOUR)).toBe("1h ago");
    expect(relativeTime(now, now + 3 * HOUR)).toBe("3h ago");
    expect(relativeTime(now, now + 23 * HOUR)).toBe("23h ago");
  });

  it("returns day bucket at the 24-hour boundary", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now, now + DAY)).toBe("1d ago");
    expect(relativeTime(now, now + 2 * DAY)).toBe("2d ago");
    expect(relativeTime(now, now + 7 * DAY)).toBe("7d ago");
  });

  it("clock skew (future ts) clamps to just now", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });

  it("accepts an explicit 'now' for deterministic tests", () => {
    expect(relativeTime(0, 2 * HOUR)).toBe("2h ago");
    expect(relativeTime(0, 48 * HOUR)).toBe("2d ago");
  });
});
