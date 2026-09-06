import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runUpdateCommand, windowsUpdateTree } from "./agent-update-process.js";

describe("Windows update process identity", () => {
  const identity = { pid: 10, startedAt: 100, spawnedAt: 110 };
  const root = { pid: 10, parentPid: 1, createdAt: 105 };
  const child = { pid: 20, parentPid: 10, createdAt: 120 };
  const grandchild = { pid: 30, parentPid: 20, createdAt: 130 };

  it("stops descendants before the original parent", () => {
    expect(windowsUpdateTree([root, child, grandchild], identity, 200)).toEqual(
      [grandchild, child, root],
    );
  });

  it("includes children spawned by a live parent while the snapshot was being collected", () => {
    const lateChild = { pid: 40, parentPid: 10, createdAt: 220 };
    expect(windowsUpdateTree([root, lateChild], identity, 200)).toEqual([
      lateChild,
      root,
    ]);
  });

  it("finds orphaned descendants but excludes children born after npm exited", () => {
    const unrelated = { pid: 40, parentPid: 10, createdAt: 180 };
    expect(
      windowsUpdateTree(
        [child, grandchild, unrelated],
        { ...identity, exitedAt: 150 },
        200,
      ),
    ).toEqual([grandchild, child]);
  });

  it("never kills or traverses an unrelated process that reused the root PID", () => {
    const replacement = { ...root, createdAt: 160 };
    const unrelated = { pid: 40, parentPid: 10, createdAt: 180 };
    expect(windowsUpdateTree([replacement, unrelated], identity, 200)).toEqual(
      [],
    );
    expect(
      windowsUpdateTree([root, child], { ...identity, exitedAt: 150 }, 200),
    ).toEqual([]);
  });
});

describe("bounded update processes", () => {
  it("reports missing executables and failed commands without hanging startup", async () => {
    const opts = { env: process.env, timeoutMs: 1_000 };
    expect(
      (
        await runUpdateCommand(
          "studio-deliberately-missing-executable",
          [],
          opts,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await runUpdateCommand(
          process.execPath,
          ["-e", "process.exit(1)"],
          opts,
        )
      ).ok,
    ).toBe(false);
  });

  it.each([false, true])(
    "kills a timed-out process tree, including an already-exited parent (%s)",
    async (parentExits) => {
      const root = await mkdtemp(join(tmpdir(), "studio-update-timeout-"));
      const marker = join(root, "child-pid");
      try {
        const childCode = "setInterval(() => {}, 1000)";
        const code = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore',1,2]}); require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid)); ${parentExits ? "process.exit(0)" : "setInterval(()=>{},1000)"};`;
        const result = await runUpdateCommand(process.execPath, ["-e", code], {
          env: process.env,
          timeoutMs: 700,
        });
        expect(result.ok).toBe(false);
        expect(result.detail).toContain("Timed out");
        const pid = Number(await readFile(marker, "utf8"));
        // Signal delivery and OS teardown are asynchronous. Linux may retain a
        // dead grandchild as a zombie; missing or zombie both prove it stopped.
        await vi.waitFor(
          async () => {
            if (process.platform === "linux") {
              const status = await readFile(
                `/proc/${pid}/status`,
                "utf8",
              ).catch(() => "State:\tZ");
              expect(status).toMatch(/State:\s+Z/);
            } else {
              expect(() => process.kill(pid, 0)).toThrow();
            }
          },
          { timeout: 1_000, interval: 20 },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("cancels running updates and prevents new installers when Studio quits during setup", async () => {
    vi.resetModules();
    const commands = await import("./agent-update-process.js");
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const command = commands.runUpdateCommand(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      {
        env: process.env,
        timeoutMs: 5_000,
        onLine: () => ready(),
      },
    );
    await started;
    await commands.stopAgentUpdateCommands();
    expect((await command).detail).toBe("Studio is quitting");
    expect(
      (
        await commands.runUpdateCommand(
          process.execPath,
          ["-e", "process.exit(0)"],
          {
            env: process.env,
            timeoutMs: 1_000,
          },
        )
      ).ok,
    ).toBe(false);
  });
});
