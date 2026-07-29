/**
 * The contract that keeps the packaging gate honest: a smoke run that cannot
 * verify anything must FAIL, not exit 0. See single-instance.ts.
 */
import { describe, expect, it } from "vitest";

import { resolveInstanceLockAction } from "./single-instance.js";

describe("resolveInstanceLockAction", () => {
  it("boots when it owns the lock", () => {
    expect(resolveInstanceLockAction({ gotLock: true, smokeMode: false })).toEqual({ action: "boot" });
    expect(resolveInstanceLockAction({ gotLock: true, smokeMode: true })).toEqual({ action: "boot" });
  });

  it("quits quietly on a second real launch — the running window gets focus", () => {
    expect(resolveInstanceLockAction({ gotLock: false, smokeMode: false })).toEqual({ action: "quit" });
  });

  it("FAILS a smoke run that lost the lock, rather than exiting 0 having checked nothing", () => {
    const outcome = resolveInstanceLockAction({ gotLock: false, smokeMode: true });
    expect(outcome).toMatchObject({ action: "fail", exitCode: 1 });
    // The line has to be greppable alongside the other results, or CI shows a
    // non-zero exit with no explanation.
    expect(outcome.action === "fail" && outcome.message).toMatch(/^\[smoke\] FAILED/);
    expect(outcome.action === "fail" && outcome.message).toMatch(/single-instance lock/);
  });
});
