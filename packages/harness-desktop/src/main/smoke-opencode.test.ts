import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { startOpenCodeServer } from "@sapiom/opencode";
import { checkOpenCodeRuntime } from "./smoke-opencode.js";

vi.mock("@sapiom/opencode", async (original) => ({
  ...(await original<typeof import("@sapiom/opencode")>()),
  startOpenCodeServer: vi.fn(),
}));

it("retains both the session failure and a failed runtime cleanup", async () => {
  const sessionFailure = new Error("session failed");
  const cleanupFailure = new Error("cleanup failed");
  const close = vi.fn().mockRejectedValue(cleanupFailure);
  vi.mocked(startOpenCodeServer).mockResolvedValue({
    pid: 123,
    exited: Promise.resolve(),
    fetch: vi.fn(),
    fetchJson: vi.fn().mockRejectedValue(sessionFailure),
    close,
  });
  try {
    await expect(checkOpenCodeRuntime()).rejects.toMatchObject({
      errors: [sessionFailure, cleanupFailure],
      message: expect.stringContaining("session failed"),
    });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    const options = vi.mocked(startOpenCodeServer).mock.calls[0]?.[0];
    if (options)
      rmSync(dirname(options.stateRoot), { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
