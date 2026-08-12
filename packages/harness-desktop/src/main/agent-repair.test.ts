import { describe, expect, it } from "vitest";
import { agentRepairDecision } from "./agent-repair.js";

const broken = () => {
  throw new Error(
    'cannot spawn "C:\\...\\claude.CMD" on Windows: its target is missing, but a renamed ".old" copy is present',
  );
};

describe("agentRepairDecision", () => {
  it("repairs a managed install whose spawn check fails on win32 — the shipped self-update wreckage", () => {
    const decision = agentRepairDecision({
      platform: "win32",
      managedInstallExists: true,
      checkSpawn: broken,
    });
    expect(decision.repair).toBe(true);
    expect(decision.reason).toMatch(/\.old/);
  });

  it("never reinstalls over an install the app does not own", () => {
    expect(
      agentRepairDecision({ platform: "win32", managedInstallExists: false, checkSpawn: broken }),
    ).toEqual({ repair: false, reason: null });
  });

  it("does nothing when the agent actually spawns", () => {
    expect(
      agentRepairDecision({ platform: "win32", managedInstallExists: true, checkSpawn: () => {} }),
    ).toEqual({ repair: false, reason: null });
  });

  it("is a no-op on POSIX, where the spawn check is a passthrough and proves nothing", () => {
    expect(
      agentRepairDecision({ platform: "darwin", managedInstallExists: true, checkSpawn: broken }),
    ).toEqual({ repair: false, reason: null });
  });
});
