import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn,
}));
import { runUpdateCommand } from "./agent-update-process.js";

describe.skipIf(process.platform === "win32")("POSIX update group ownership", () => {
  it("never signals the old group after its supervisor has exited", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kill: vi.fn(),
    });
    spawn.mockReturnValueOnce(child);
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = runUpdateCommand("installer", [], { env: {}, timeoutMs: 10 });
      child.emit("exit", 0);
      expect((await result).detail).toContain("Timed out");
      expect(signal).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally { signal.mockRestore(); }
  });
});
