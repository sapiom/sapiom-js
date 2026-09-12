import { describe, expect, it, vi } from "vitest";
import { evaluateTrackedClosure, readLinuxProcessTable } from "./server.js";

const stat = (pid: string) =>
  `${pid} (fixture (child)) ${["S", "4", "5", ...Array(16).fill("0"), "birth-" + pid].join(" ")}`;

describe("Linux process enumeration during shutdown", () => {
  it.each(["ENOENT", "ESRCH"])(
    "continues around a vanished entry (%s)",
    async (code) => {
      const readStat = vi.fn(async (pid: string) => {
        if (pid === "2")
          throw Object.assign(new Error("process vanished"), { code });
        return stat(pid);
      });
      const processes = await readLinuxProcessTable(
        async () => ["self", "1", "2", "3"],
        readStat,
      );
      expect([...processes.keys()]).toEqual([1, 3]);
      expect(processes.get(3)).toEqual({
        pid: 3,
        ppid: 4,
        pgid: 5,
        state: "S",
        birthId: "birth-3",
      });
      expect(readStat).toHaveBeenCalledTimes(3);
      // A missing tracked descendant still cannot prove positive fencing.
      expect(
        evaluateTrackedClosure(
          new Map([["2:birth-2", { pid: 2, birthId: "birth-2" }]]),
          processes,
        ),
      ).toBe("uncertain");
    },
  );

  it.each(["EACCES", "EPERM", "EIO", undefined])(
    "rejects an unreadable entry (%s)",
    async (code) => {
      const error = Object.assign(new Error("cannot inspect process"), {
        code,
      });
      await expect(
        readLinuxProcessTable(
          async () => ["1"],
          async () => {
            throw error;
          },
        ),
      ).rejects.toBe(error);
    },
  );

  it.each(["ENOENT", "ESRCH", "EACCES"])(
    "does not hide failure to enumerate /proc (%s)",
    async (code) => {
      const error = Object.assign(new Error("cannot enumerate processes"), {
        code,
      });
      const readStat = vi.fn(async () => stat("1"));
      await expect(
        readLinuxProcessTable(async () => {
          throw error;
        }, readStat),
      ).rejects.toBe(error);
      expect(readStat).not.toHaveBeenCalled();
    },
  );
});
