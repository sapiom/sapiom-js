import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  captureManagedAgentWorkspaceSnapshot,
  createManagedAgentFixture,
  diffManagedAgentWorkspaceSnapshots,
  fixtureGitStatus,
  observeManagedAgentL1FinalBytes,
  verifyManagedAgentFixtureBytes,
  type ManagedAgentFixture,
} from "./fixture.js";
import {
  MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV,
  MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV,
} from "./process-observer.js";

const fixtures: ManagedAgentFixture[] = [];

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (processExists(pid)) {
    throw new Error(
      `Fixture descendant ${pid} survived its retained lifetime-lease shutdown`,
    );
  }
}

async function waitForDirectChildPid(parentPid: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      windowsHide: true,
    });
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[2]) === parentPid) return Number(match[1]);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("fixture child did not start");
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("managed-agent disposable git fixture", () => {
  it("emits a syntactically valid long-running fixture program", async () => {
    const fixture = await createManagedAgentFixture(() => "syntax-check");
    fixtures.push(fixture);

    expect(() =>
      execFileSync(
        process.execPath,
        ["--check", join(fixture.workspaceRoot, FIXTURE_PATHS.processScript)],
        { stdio: "pipe", windowsHide: true },
      ),
    ).not.toThrow();
  });

  it("starts with a clean target plus dirty tracked and untracked sentinels", async () => {
    const fixture = await createManagedAgentFixture(
      () => "11111111-2222-3333-4444-555555555555",
    );
    fixtures.push(fixture);
    expect(await fixtureGitStatus(fixture)).toBe(
      ` M ${FIXTURE_PATHS.dirtySentinel}\n?? ${FIXTURE_PATHS.untrackedSentinel}\n`,
    );
    expect(fixture.prompt("L1")).toContain(FIXTURE_PATHS.untrackedSentinel);
    expect(fixture.prompt("L1")).not.toContain(fixture.nonce);
    expect(fixture.prompt("L2")).toContain(fixture.l2BashCommand);
    expect(fixture.l2BashCommand).toContain("--host-cleanup-marker");
    expect(fixture.l2BashCommand).toContain(fixture.cooperativeExitMarker);
    expect(
      fixture.cooperativeExitMarker.startsWith(fixture.workspaceRoot),
    ).toBe(false);
    expect(await verifyManagedAgentFixtureBytes(fixture)).toEqual([
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ]);
  });

  it("treats a deleted host lifetime lease as shutdown during startup", async () => {
    const fixture = await createManagedAgentFixture(() => "lease-shutdown");
    fixtures.push(fixture);
    await rm(fixture.cooperativeExitMarker, { force: true });
    const processScript = join(
      fixture.workspaceRoot,
      FIXTURE_PATHS.processScript,
    );
    const child = spawn(
      process.execPath,
      [
        processScript,
        join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
        "--host-cleanup-marker",
        fixture.cooperativeExitMarker,
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const [exitCode] = await once(child, "exit");
    expect(exitCode).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "does not orphan the child when the fixture root disappears before delayed readiness",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "deleted-root-readiness",
      );
      fixtures.push(fixture);
      const externalLeaseRoot = await mkdtemp(
        join(tmpdir(), "managed-agent-fixture-lease-"),
      );
      const externalLease = join(externalLeaseRoot, "lease");
      await writeFile(externalLease, "run\n", { mode: 0o600 });
      const child = spawn(
        process.execPath,
        [
          join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
          join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
          "--host-cleanup-marker",
          externalLease,
          "--host-readiness-delay-ms",
          "500",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      await once(child, "spawn");
      const descendantPid = await waitForDirectChildPid(child.pid!);

      try {
        const exitTask = once(child, "exit");
        await rm(fixture.root, { recursive: true, force: true });
        const [exitCode] = await exitTask;
        expect(exitCode).toBe(1);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        await rm(externalLeaseRoot, { recursive: true, force: true });
        await waitForProcessExit(descendantPid);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "self-terminates its detached group when a controller accepts but never authenticates",
    { timeout: 12_000 },
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "silent-control-registration",
      );
      fixtures.push(fixture);
      const controlRoot = await mkdtemp(
        join(tmpdir(), "managed-agent-silent-control-"),
      );
      const controlSocket = join(controlRoot, "control.sock");
      const acceptedSockets: NetSocket[] = [];
      const server = createServer((socket) => {
        acceptedSockets.push(socket);
        socket.on("error", () => undefined);
        socket.resume();
      });
      server.listen(controlSocket);
      await once(server, "listening");
      const parent = spawn(
        process.execPath,
        [
          join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
          join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
          "--register-control",
        ],
        {
          detached: true,
          env: {
            ...process.env,
            [MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV]: controlSocket,
            [MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV]:
              "silent-control-capability",
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      await once(parent, "spawn");
      const spawnedAt = performance.now();
      let childPid: number | undefined;

      try {
        childPid = await waitForDirectChildPid(parent.pid!);
        const connectionDeadline = Date.now() + 2_000;
        while (acceptedSockets.length < 2 && Date.now() < connectionDeadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        expect(acceptedSockets).toHaveLength(2);
        expect(processExists(parent.pid!)).toBe(true);
        expect(processExists(childPid)).toBe(true);

        const [exitCode, signal] = await once(parent, "exit");
        expect(exitCode).toBeNull();
        expect(signal).toBe("SIGKILL");
        expect(performance.now() - spawnedAt).toBeLessThan(6_000);
        await waitForProcessExit(childPid);
      } finally {
        for (const socket of acceptedSockets) socket.destroy();
        await new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) =>
            error ? rejectClose(error) : resolveClose(),
          ),
        );
        await waitForProcessExit(parent.pid!, 7_000);
        if (childPid !== undefined) await waitForProcessExit(childPid, 7_000);
        await rm(controlRoot, { recursive: true, force: true });
      }
    },
  );

  it("renders L1 as eleven exact ordered calls without resolving the escape link", async () => {
    const fixture = await createManagedAgentFixture(() => "prompt-contract");
    fixtures.push(fixture);
    const prompt = fixture.prompt("L1");
    expect(prompt.split("\n")[0]).toBe("SAPIOM_MANAGED_AGENT_L1_PROMPT_V2");
    expect(prompt).toContain(
      "at most one optional verification Read after call 5 and before call 6",
    );
    expect(prompt).toContain(
      "exactly repeat call 1, 2, or 3 with the same literal file_path",
    );
    expect(prompt).toContain("Do not Read any other fixture path");
    const numberedLines = prompt
      .split("\n")
      .filter((line) => /^\d+\./.test(line));

    expect(numberedLines).toHaveLength(11);
    expect(numberedLines.map((line) => Number.parseInt(line, 10))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(numberedLines[4]).toContain(
      JSON.stringify({ file_path: FIXTURE_PATHS.escapeLink }),
    );
    expect(numberedLines[4]).toContain("exact relative path");
    expect(numberedLines[4]).not.toContain(fixture.outsideSentinel);
    expect(numberedLines[5]).toContain(
      JSON.stringify({
        file_path: FIXTURE_PATHS.cleanTarget,
        old_string: "clean target base\n",
        new_string: fixture.cleanTargetReplacement,
        replace_all: false,
      }),
    );
    expect(numberedLines[8]).toContain("fail_once");
    expect(numberedLines[9]).toContain("fail_once");
    expect(numberedLines[10]).toContain(
      JSON.stringify({ command: fixture.l1BashCommand }),
    );
    expect(prompt.split(fixture.outsideSentinel)).toHaveLength(2);
    expect(prompt.replace(fixture.outsideSentinel, "")).not.toContain(
      fixture.root,
    );
    expect(prompt).toContain(
      "After call 11 completes, make no further tool calls",
    );
  });

  it("observes only relative structural changes and preserves sentinel bytes", async () => {
    const fixture = await createManagedAgentFixture(() => "fixture-nonce");
    fixtures.push(fixture);
    const before = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    await Promise.all([
      writeFile(
        join(fixture.workspaceRoot, FIXTURE_PATHS.cleanTarget),
        fixture.cleanTargetReplacement,
      ),
      writeFile(
        join(fixture.workspaceRoot, FIXTURE_PATHS.createdTarget),
        fixture.createdTargetContents,
      ),
    ]);
    const after = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    expect(diffManagedAgentWorkspaceSnapshots(before, after)).toEqual([
      { path: FIXTURE_PATHS.cleanTarget, change: "modified" },
      { path: FIXTURE_PATHS.createdTarget, change: "created" },
    ]);
    expect(
      observeManagedAgentL1FinalBytes(after, fixture.expectedL1FinalBytes),
    ).toEqual([
      { role: "clean_target", matched: true },
      { role: "managed_output", matched: true },
    ]);
    await writeFile(
      join(fixture.workspaceRoot, FIXTURE_PATHS.createdTarget),
      "wrong final bytes\n",
    );
    const incorrect = await captureManagedAgentWorkspaceSnapshot(
      fixture.workspaceRoot,
    );
    expect(
      observeManagedAgentL1FinalBytes(incorrect, fixture.expectedL1FinalBytes),
    ).toEqual([
      { role: "clean_target", matched: true },
      { role: "managed_output", matched: false },
    ]);
    expect(await verifyManagedAgentFixtureBytes(fixture)).toEqual([
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ]);
  });
});
