import { once } from "node:events";
import {
  ChildProcess,
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection, type Socket as NetSocket } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  waitForManagedAgentFixturePids,
  type ManagedAgentFixture,
} from "./fixture.js";
import {
  LocalManagedAgentProcessObserver,
  MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV,
  MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV,
  managedAgentPosixSessionColumn,
  parseManagedAgentPosixProcessTable,
  type ManagedAgentKernelProcessRecord,
  type ManagedAgentProcessTableObservation,
} from "./process-observer.js";

const fixtures: ManagedAgentFixture[] = [];
const execFileAsync = promisify(execFile);

function deadlineAfter(timeoutMs: number, startedAtMs = performance.now()) {
  return Object.freeze({
    startedAtMs,
    deadlineAtMs: startedAtMs + timeoutMs,
  });
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function available(
  entries: readonly (readonly [number, ManagedAgentKernelProcessRecord])[],
): ManagedAgentProcessTableObservation {
  return { available: true, processes: new Map(entries) };
}

async function readRealPosixProcessTable(): Promise<ManagedAgentProcessTableObservation> {
  try {
    const sessionColumn = managedAgentPosixSessionColumn(process.platform);
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-axo", `pid=,ppid=,pgid=,${sessionColumn}=,stat=,lstart=`],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 1_000 },
    );
    return {
      available: true,
      processes: parseManagedAgentPosixProcessTable(stdout),
    };
  } catch {
    return { available: false };
  }
}

async function prepareCancellationAfterTransientReadFailure(
  observer: LocalManagedAgentProcessObserver,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const readiness = await observer.prepareCancellation();
    if (
      readiness.reason !== "process_table_unavailable" ||
      Date.now() >= deadline
    ) {
      return readiness;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function waitForContainmentEscape(
  observer: LocalManagedAgentProcessObserver,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  let readiness = await observer.prepareCancellation();
  while (readiness.reason !== "containment_escaped" && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    readiness = await observer.prepareCancellation();
  }
  return readiness;
}

function activeNodeCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  };
}

function spawnCooperativeTestProcess(): ChildProcess {
  return spawnChild(
    process.execPath,
    [
      "-e",
      'process.on("disconnect", () => process.exit(0)); setInterval(() => {}, 1000)',
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
}

const FAST_EXIT_ROOT_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pidFile = resolve(process.argv[1]);
const exitTiming = process.argv[2];
const exitMarker = resolve(process.argv[3]);
const cleanupMarker = resolve(process.argv[4]);
const childProgram = [
  'const { existsSync } = require("node:fs");',
  'const cleanupMarker = process.argv[1];',
  'process.on("SIGTERM", () => {});',
  'if (process.send) process.send("ready");',
  'const cleanupPoll = setInterval(() => {',
  '  if (!existsSync(cleanupMarker)) return;',
  '  clearInterval(cleanupPoll);',
  '  process.exit(0);',
  '}, 10);',
  'setInterval(() => {}, 1000);',
].join("");
const child = spawn(process.execPath, ["-e", childProgram, cleanupMarker], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  windowsHide: true,
});
child.once("message", () => {
  writeFileSync(pidFile, JSON.stringify({
    parentPid: process.pid,
    childPid: child.pid,
  }));
  if (exitTiming === "before-readiness") process.exit(0);
  const exitPoll = setInterval(() => {
    if (!existsSync(exitMarker)) return;
    clearInterval(exitPoll);
    process.exit(0);
  }, 10);
});
`;

const DESCENDANT_TOOL_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [toolScript, pidFile, credentialFile, cleanupMarker] = process.argv.slice(1);
writeFileSync(credentialFile, JSON.stringify({
  socketPath: process.env.SAPIOM_MANAGED_AGENT_TOOL_CONTROL_SOCKET,
  capability: process.env.SAPIOM_MANAGED_AGENT_TOOL_CONTROL_CAPABILITY,
}));
const tool = spawn(
  "/bin/bash",
  [
    "--noprofile",
    "--norc",
    "-c",
    'exec "$1" "$2" "$3" "$4" "$5"',
    "managed-agent-tool",
    process.execPath,
    toolScript,
    pidFile,
    "--host-cleanup-marker",
    cleanupMarker,
  ],
  {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  },
);
tool.unref();
setInterval(() => {}, 1000);
`;

const REGISTERED_DESCENDANT_TOOL_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [toolScript, pidFile, launchFile] = process.argv.slice(1);
const tool = spawn(
  "/bin/bash",
  [
    "--noprofile",
    "--norc",
    "-c",
    'exec "$1" "$2" "$3" --register-control',
    "managed-agent-tool",
    process.execPath,
    toolScript,
    pidFile,
  ],
  {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  },
);
if (typeof tool.pid !== "number") throw new Error("fixture tool failed to spawn");
// Direct launcher tests predate setup-failure cleanup evidence and deliberately
// omit this path; the shared launcher must remain valid for those callers.
if (launchFile) {
  writeFileSync(launchFile, JSON.stringify({ processGroupId: tool.pid }));
}
tool.unref();
setInterval(() => {}, 1000);
`;

const EXPORT_TOOL_CONTROL_SCRIPT = String.raw`
import { writeFileSync } from "node:fs";

const outputPath = process.argv[1];
const socketPath = process.env[${JSON.stringify(MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV)}];
const capability = process.env[${JSON.stringify(MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV)}];
if (!socketPath || !capability) process.exit(41);
writeFileSync(outputPath, JSON.stringify({ socketPath, capability }));
setInterval(() => {}, 1000);
`;

interface ToolControlCredentials {
  readonly socketPath: string;
  readonly capability: string;
}

async function waitForToolControlCredentials(
  path: string,
  timeoutMs = 3_000,
): Promise<ToolControlCredentials> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const payload = JSON.parse(await readFile(path, "utf8")) as {
        socketPath?: unknown;
        capability?: unknown;
      };
      if (
        typeof payload.socketPath === "string" &&
        typeof payload.capability === "string"
      ) {
        return {
          socketPath: payload.socketPath,
          capability: payload.capability,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for tool-control credentials");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function openToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<NetSocket> {
  const socket = await startToolRegistration(credentials, role, pid);
  let timeout: NodeJS.Timeout | undefined;
  const [response] = (await Promise.race([
    once(socket, "data"),
    once(socket, "close").then(() => {
      throw new Error(`tool registration ${role} closed before acceptance`);
    }),
    new Promise<never>((_, rejectTimeout) => {
      timeout = setTimeout(
        () => rejectTimeout(new Error(`tool registration ${role} timed out`)),
        1_000,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  })) as [Buffer | string];
  expect(String(response)).toContain('"registered":true');
  return socket;
}

async function startToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<NetSocket> {
  const socket = createConnection(credentials.socketPath);
  socket.setEncoding("utf8");
  await once(socket, "connect");
  socket.write(
    `${JSON.stringify({ capability: credentials.capability, role, pid })}\n`,
  );
  return socket;
}

async function sendClosedToolRegistration(
  credentials: ToolControlCredentials,
  role: "parent" | "child",
  pid: number,
): Promise<void> {
  const socket = createConnection(credentials.socketPath);
  await once(socket, "connect");
  socket.end(
    `${JSON.stringify({ capability: credentials.capability, role, pid })}\n`,
  );
  await once(socket, "close");
}

function asChildProcess(
  spawned: SpawnedProcess,
): ChildProcessWithoutNullStreams {
  return spawned as ChildProcessWithoutNullStreams;
}

function sameFullTestIdentity(
  expected: ManagedAgentKernelProcessRecord,
  current: ManagedAgentKernelProcessRecord | undefined,
): boolean {
  return (
    expected.startedAt === current?.startedAt &&
    expected.parentPid === current.parentPid &&
    expected.processGroupId === current.processGroupId &&
    expected.sessionId === current.sessionId
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function realProcessGroupLiveness(
  processGroupId: number,
): "alive" | "gone" | "unknown" {
  try {
    process.kill(-processGroupId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function waitForTestProcessDeath(
  isAlive: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (isAlive()) throw new Error(`${description} survived test cleanup`);
}

async function waitForLaunchedGroupId(
  path: string,
  timeoutMs = 3_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const payload = JSON.parse(await readFile(path, "utf8")) as {
        processGroupId?: unknown;
      };
      if (
        typeof payload.processGroupId === "number" &&
        Number.isSafeInteger(payload.processGroupId) &&
        payload.processGroupId > 1
      ) {
        return payload.processGroupId;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for detached tool launch evidence");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function waitForChildExitBounded(
  child: ChildProcess,
  timeoutMs = 1_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_, rejectTimeout) =>
      setTimeout(
        () => rejectTimeout(new Error("Owned root did not exit in time")),
        timeoutMs,
      ),
    ),
  ]);
}

async function stopExactTestProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== "number") return;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.connected) {
      throw new Error(
        `Refusing cleanup for test process ${pid} without its retained IPC channel`,
      );
    }
    child.disconnect();
  }
  await waitForTestProcessDeath(
    () => processExists(pid),
    `Unrelated process ${pid}`,
  );
}

async function captureExactTestProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, ManagedAgentKernelProcessRecord>> {
  const observation = await readRealPosixProcessTable();
  if (!observation.available) {
    throw new Error("Process table unavailable for exact test cleanup");
  }
  const identities = new Map<number, ManagedAgentKernelProcessRecord>();
  for (const pid of pids) {
    const identity = observation.processes.get(pid);
    if (!identity) throw new Error(`Test process ${pid} disappeared too early`);
    identities.set(pid, identity);
  }
  return identities;
}

async function liveExactTestProcessIdentities(
  identities: ReadonlyMap<number, ManagedAgentKernelProcessRecord>,
): Promise<readonly number[]> {
  const current = await readRealPosixProcessTable();
  if (!current.available) {
    throw new Error("Process table unavailable during exact test cleanup");
  }
  return [...identities].flatMap(([pid, identity]) => {
    const record = current.processes.get(pid);
    return record &&
      sameFullTestIdentity(identity, record) &&
      !record.state?.startsWith("Z")
      ? [pid]
      : [];
  });
}

async function waitForExactTestProcessIdentitiesToExit(
  identities: ReadonlyMap<number, ManagedAgentKernelProcessRecord>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let survivors = await liveExactTestProcessIdentities(identities);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    survivors = await liveExactTestProcessIdentities(identities);
  }
  if (survivors.length > 0) {
    throw new Error(
      `Authenticated cooperative cleanup left ${survivors.length} tool process(es)`,
    );
  }
}

async function stopRetainedTestGroup(root: ChildProcess): Promise<void> {
  if (root.exitCode !== null || root.signalCode !== null) return;
  if (!root.connected) {
    throw new Error(
      "Refusing supervisor cleanup without its retained process-bound IPC channel",
    );
  }
  // The supervisor's disconnect handler kills its own current group. No
  // cached numeric PID or PGID crosses this test-cleanup boundary.
  root.disconnect();
  await waitForChildExitBounded(root);
}

async function proveRetainedGroupAuthority(
  exitTiming: "before-readiness" | "after-readiness",
): Promise<void> {
  const fixture = await createManagedAgentFixture(
    () => `fast-root-exit-${exitTiming}`,
  );
  fixtures.push(fixture);
  const productionGroupSignals: Array<readonly [number, "SIGKILL"]> = [];
  const observer = new LocalManagedAgentProcessObserver({
    testOnlyRequestTermination: (processGroupId, signal) => {
      productionGroupSignals.push([processGroupId, signal]);
      return "failure";
    },
  });
  const forwardedController = new AbortController();
  const unrelated = spawnCooperativeTestProcess();
  await once(unrelated, "spawn");
  let anchor: ChildProcessWithoutNullStreams | undefined;
  let nonCooperativeChildPid: number | undefined;
  let exitMarker: string | undefined;
  let cleanupMarker: string | undefined;
  try {
    exitMarker = join(
      fixture.workspaceRoot,
      FIXTURE_PATHS.processDirectory,
      "exit-inner-root",
    );
    cleanupMarker = join(
      fixture.workspaceRoot,
      FIXTURE_PATHS.processDirectory,
      "exit-non-cooperative-child",
    );
    anchor = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          FAST_EXIT_ROOT_SCRIPT,
          FIXTURE_PATHS.processPidFile,
          exitTiming,
          exitMarker,
          cleanupMarker,
        ],
        cwd: fixture.workspaceRoot,
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    expect(anchor.pid).toBeTypeOf("number");
    const [workerRootPid, fixtureChildPid] =
      await waitForManagedAgentFixturePids(fixture);
    nonCooperativeChildPid = fixtureChildPid;

    let initialReadiness;
    if (exitTiming === "after-readiness") {
      initialReadiness =
        await prepareCancellationAfterTransientReadFailure(observer);
      expect(initialReadiness).toMatchObject({
        supported: true,
        reason: "ready",
        ownershipProven: true,
      });
      await writeFile(exitMarker, "exit\n");
    }
    await waitForTestProcessDeath(
      () => processExists(workerRootPid!),
      `Fast SDK root ${workerRootPid}`,
    );
    expect(processExists(nonCooperativeChildPid!)).toBe(true);
    const escapedReadiness = await waitForContainmentEscape(observer);
    expect(escapedReadiness).toMatchObject({
      supported: false,
      reason: "containment_escaped",
      ownershipProven: false,
    });
    expect(escapedReadiness.observedPids).toContain(nonCooperativeChildPid);
    expect(escapedReadiness.observedPids).not.toContain(unrelated.pid);
    expect(processExists(nonCooperativeChildPid)).toBe(true);
    expect(processExists(unrelated.pid!)).toBe(true);
    await expect(
      observer.waitForQuiescence(deadlineAfter(1)),
    ).resolves.toMatchObject({
      quiescent: false,
      deadlineMet: false,
      containmentSupported: false,
      forceKillIssued: false,
    });
    expect(productionGroupSignals).toEqual([]);
  } finally {
    if (exitMarker)
      await writeFile(exitMarker, "exit\n").catch(() => undefined);
    if (cleanupMarker) {
      await writeFile(cleanupMarker, "exit\n").catch(() => undefined);
    }
    if (typeof nonCooperativeChildPid === "number") {
      await waitForTestProcessDeath(
        () => processExists(nonCooperativeChildPid!),
        `Escaped fixture child ${nonCooperativeChildPid}`,
        500,
      ).catch(() => undefined);
    }
    if (anchor && anchor.exitCode === null && anchor.signalCode === null) {
      if (anchor.connected) anchor.disconnect();
      else await stopRetainedTestGroup(anchor);
      await waitForChildExitBounded(anchor);
    }
    if (typeof nonCooperativeChildPid === "number") {
      await waitForTestProcessDeath(
        () => processExists(nonCooperativeChildPid!),
        `Escaped fixture child ${nonCooperativeChildPid}`,
      );
    }
    forwardedController.abort();
    observer.dispose();
    await stopExactTestProcess(unrelated);
  }
}

interface RegisteredDescendantToolRun {
  readonly fixture: ManagedAgentFixture;
  readonly observer: LocalManagedAgentProcessObserver;
  readonly forwardedController: AbortController;
  readonly anchor: ChildProcessWithoutNullStreams;
  readonly toolPids: readonly [number, number];
  readonly toolProcessGroupId: number;
  readonly toolIdentities: ReadonlyMap<number, ManagedAgentKernelProcessRecord>;
}

interface RegisteredDescendantToolSetupEvidence {
  readonly anchor: ChildProcessWithoutNullStreams;
  readonly toolPids: readonly [number, number];
  readonly toolProcessGroupId: number;
  readonly toolIdentities: ReadonlyMap<number, ManagedAgentKernelProcessRecord>;
}

interface RegisteredDescendantSetupCleanupError extends Error {
  readonly setupError: unknown;
  readonly cleanupErrors: readonly unknown[];
}

interface RegisteredDescendantCleanupError extends Error {
  readonly cleanupErrors: readonly unknown[];
}

function setupAndCleanupFailure(
  setupError: unknown,
  cleanupErrors: readonly unknown[],
): RegisteredDescendantSetupCleanupError {
  const failure = new Error(
    "Registered descendant setup and cleanup both failed",
  ) as RegisteredDescendantSetupCleanupError;
  Object.defineProperties(failure, {
    cleanupErrors: { value: [...cleanupErrors] },
    setupError: { value: setupError },
  });
  return failure;
}

function registeredDescendantCleanupFailure(
  cleanupErrors: readonly unknown[],
): RegisteredDescendantCleanupError {
  const failure = new Error(
    "Registered descendant cleanup failed",
  ) as RegisteredDescendantCleanupError;
  Object.defineProperty(failure, "cleanupErrors", {
    value: [...cleanupErrors],
  });
  return failure;
}

async function startRegisteredDescendantToolRun(
  observer: LocalManagedAgentProcessObserver,
  name: string,
  afterPidPublication?: (
    evidence: RegisteredDescendantToolSetupEvidence,
  ) => void | Promise<void>,
): Promise<RegisteredDescendantToolRun> {
  const fixture = await createManagedAgentFixture(() => name);
  fixtures.push(fixture);
  const forwardedController = new AbortController();
  const launchFile = join(fixture.root, "registered-tool-launch.json");
  observer.armToolProcessContainment();
  const anchor = asChildProcess(
    observer.spawn({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        REGISTERED_DESCENDANT_TOOL_SCRIPT,
        join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
        join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
        launchFile,
      ],
      cwd: fixture.workspaceRoot,
      env: { ...process.env },
      signal: forwardedController.signal,
    }),
  );
  let toolPids: readonly [number, number] | undefined;
  let toolProcessGroupId: number | undefined;
  let toolIdentities:
    | ReadonlyMap<number, ManagedAgentKernelProcessRecord>
    | undefined;
  try {
    if (typeof anchor.pid !== "number") {
      throw new Error("Owned fixture anchor failed to spawn");
    }
    toolProcessGroupId = await waitForLaunchedGroupId(launchFile);
    const [parentPid, childPid] = await waitForManagedAgentFixturePids(
      fixture,
      5_000,
    );
    toolPids = [parentPid!, childPid!] as const;
    if (parentPid !== toolProcessGroupId) {
      throw new Error("Detached fixture group does not match its parent PID");
    }
    // Capture stable positive-PID identities before user callbacks or
    // assertions can fail. A detached numeric group id is never cleanup
    // authority on its own.
    toolIdentities = await captureExactTestProcessIdentities(toolPids);
    await afterPidPublication?.({
      anchor,
      toolPids,
      toolProcessGroupId,
      toolIdentities,
    });
    await expect(
      prepareCancellationAfterTransientReadFailure(observer),
    ).resolves.toMatchObject({
      supported: true,
      reason: "ready",
      ownershipProven: true,
    });
    return {
      fixture,
      observer,
      forwardedController,
      anchor,
      toolPids,
      toolProcessGroupId,
      toolIdentities,
    };
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    try {
      await observer.dispose();
      if (toolIdentities) {
        const survivors = await liveExactTestProcessIdentities(toolIdentities);
        if (survivors.length > 0) {
          cleanupErrors.push(
            new Error(
              `Authenticated cooperative cleanup left ${survivors.length} tool process(es)`,
            ),
          );
        }
      } else if (toolPids || typeof toolProcessGroupId === "number") {
        cleanupErrors.push(
          new Error(
            "Refusing detached tool cleanup without pre-captured identities",
          ),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await stopRetainedTestGroup(anchor);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      forwardedController.abort();
      await observer.dispose();
    }
    if (cleanupErrors.length > 0) {
      throw setupAndCleanupFailure(setupError, cleanupErrors);
    }
    throw setupError;
  }
}

async function cleanupRegisteredDescendantToolRun(
  run: RegisteredDescendantToolRun | undefined,
): Promise<void> {
  if (!run) return;
  const cleanupErrors: unknown[] = [];
  try {
    await run.observer.dispose();
    await waitForExactTestProcessIdentitiesToExit(run.toolIdentities);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (run.anchor.exitCode === null && run.anchor.signalCode === null) {
      await waitForChildExitBounded(run.anchor, 100).catch(() => undefined);
    }
    await stopRetainedTestGroup(run.anchor);
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    run.forwardedController.abort();
    await run.observer.dispose();
  }
  if (cleanupErrors.length > 0) {
    throw registeredDescendantCleanupFailure(cleanupErrors);
  }
}

describe("LocalManagedAgentProcessObserver", () => {
  it.each([
    ["darwin", "sess"],
    ["linux", "sid"],
  ] as const)(
    "uses the %s process-table session column",
    (platform, expectedColumn) => {
      expect(managedAgentPosixSessionColumn(platform)).toBe(expectedColumn);
    },
  );

  it.each([
    ["Darwin sess= layout", 0],
    ["Linux sid= layout", 100],
  ] as const)("parses the %s", (_layout, sessionId) => {
    const table = parseManagedAgentPosixProcessTable(
      `  100    1  100  ${sessionId} Ss   Mon Aug 17 01:02:03 2026\n`,
    );

    expect(table.get(100)).toEqual({
      parentPid: 1,
      processGroupId: 100,
      sessionId,
      state: "Ss",
      startedAt: "Mon Aug 17 01:02:03 2026",
    });
  });

  it("retains setup and cleanup failures without requiring AggregateError", () => {
    const setupError = new Error("synthetic setup failure");
    const cleanupError = new Error("synthetic cleanup failure");

    const failure = setupAndCleanupFailure(setupError, [cleanupError]);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(
      "Registered descendant setup and cleanup both failed",
    );
    expect(failure.setupError).toBe(setupError);
    expect(failure.cleanupErrors).toEqual([cleanupError]);
  });

  it.skipIf(process.platform === "win32")(
    "test cleanup never signals a cached group after its retained child exits",
    async () => {
      const child = spawnChild(process.execPath, ["-e", "process.exit(0)"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      await once(child, "exit");
      const killSpy = vi.spyOn(process, "kill");
      try {
        await stopRetainedTestGroup(child);
        expect(
          killSpy.mock.calls.some(
            ([pid]) => typeof pid === "number" && pid < 0,
          ),
        ).toBe(false);
      } finally {
        killSpy.mockRestore();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps inner arguments out of supervisor argv and scrubs its private payload",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const privateArgument = "inner-only-supervisor-argument";
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "-e",
            [
              'const payload = "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";',
              "const valid = process.argv[1] === " +
                JSON.stringify(privateArgument) +
                " && !Object.hasOwn(process.env, payload);",
              "process.exit(valid ? 0 : 31);",
            ].join(""),
            privateArgument,
          ],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      try {
        expect(anchor.spawnargs.join("\u0000")).not.toContain(privateArgument);
        const [exitCode, signalCode] = await once(anchor, "exit");
        expect(exitCode).toBe(0);
        expect(signalCode).toBeNull();
      } finally {
        if (typeof anchor.pid === "number") {
          await stopRetainedTestGroup(anchor);
        }
        controller.abort();
        observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "preserves a normal inner exit code without reporting a signal kill",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "-e",
            'process.stderr.write("x".repeat(1024 * 1024), () => process.exit(23));',
          ],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      let forwardedStderrBytes = 0;
      anchor.stderr.on("data", (chunk: Buffer) => {
        forwardedStderrBytes += chunk.byteLength;
      });
      try {
        const [exitCode, signalCode] = await once(anchor, "exit");
        expect(exitCode).toBe(23);
        expect(signalCode).toBeNull();
        expect(forwardedStderrBytes).toBe(1024 * 1024);
      } finally {
        if (typeof anchor.pid === "number") {
          await stopRetainedTestGroup(anchor);
        }
        controller.abort();
        observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "self-terminates when IPC disconnects before the supervisor installs its listener",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "supervisor-bootstrap-disconnect",
      );
      fixtures.push(fixture);
      const disconnectPreload = join(
        fixture.workspaceRoot,
        "disconnect-supervisor-ipc.cjs",
      );
      await writeFile(
        disconnectPreload,
        "if (process.connected) process.disconnect();\n",
      );
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          command: "/usr/bin/true",
          args: [],
          cwd: fixture.workspaceRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${disconnectPreload}`,
          },
          signal: controller.signal,
        }),
      );
      try {
        const [exitCode, signalCode] = await once(anchor, "exit");
        expect(exitCode).toBeNull();
        expect(signalCode).toBe("SIGKILL");
      } finally {
        controller.abort();
        await observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals a cached supervisor group through SDK kill after observed exit",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      const processGroupId = anchor.pid!;
      await once(anchor, "exit");
      const killSpy = vi.spyOn(process, "kill");
      try {
        expect(anchor.kill("SIGTERM")).toBe(false);
        expect(killSpy).not.toHaveBeenCalledWith(-processGroupId, "SIGTERM");
      } finally {
        killSpy.mockRestore();
        controller.abort();
        observer.dispose();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "honors SDK SIGTERM calls while the supervisor keeps its owned group anchored",
    async () => {
      const nativeKillSpy = vi.spyOn(ChildProcess.prototype, "kill");
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          ...activeNodeCommand(),
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      const processGroupId = anchor.pid!;
      try {
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });
        nativeKillSpy.mockClear();

        expect(anchor.killed).toBe(false);
        expect(anchor.kill("SIGTERM")).toBe(true);
        expect(anchor.killed).toBe(true);
        expect(anchor.kill("SIGTERM")).toBe(true);
        expect(nativeKillSpy).toHaveBeenCalledTimes(2);
        expect(nativeKillSpy).toHaveBeenNthCalledWith(1, "SIGTERM");
        expect(nativeKillSpy).toHaveBeenNthCalledWith(2, "SIGTERM");
        expect(processExists(processGroupId)).toBe(true);
        await expect(
          observer.waitForQuiescence(deadlineAfter(1)),
        ).resolves.toMatchObject({
          quiescent: false,
          containmentSupported: true,
          forceKillIssued: false,
        });
      } finally {
        nativeKillSpy.mockRestore();
        await observer.dispose();
        if (
          anchor.connected &&
          anchor.exitCode === null &&
          anchor.signalCode === null
        ) {
          anchor.disconnect();
          await waitForChildExitBounded(anchor);
        }
        controller.abort();
      }
    },
    5_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills the exact non-cooperative fixture group and confirms death inside one deadline",
    async () => {
      const fixture = await createManagedAgentFixture(() => "process-observer");
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const unrelated = spawnCooperativeTestProcess();
      await once(unrelated, "spawn");
      let root: ChildProcessWithoutNullStreams | undefined;
      let ownedProcessGroupId: number | undefined;
      try {
        root = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        ownedProcessGroupId = root.pid;
        expect(ownedProcessGroupId).toBeTypeOf("number");
        const fixturePids = await waitForManagedAgentFixturePids(fixture);
        const readiness =
          await prepareCancellationAfterTransientReadFailure(observer);
        expect(readiness).toMatchObject({
          supported: true,
          reason: "ready",
        });
        expect(
          fixturePids.every((pid) => readiness.observedPids.includes(pid)),
        ).toBe(true);
        expect(readiness.observedPids).not.toContain(unrelated.pid);

        const startedAt = Date.now();
        forwardedController.abort();
        const teardown = await observer.emergencyCleanup(deadlineAfter(1_000));

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          processTableAvailable: true,
          containmentSupported: true,
          ownershipProven: true,
          forceKillIssued: true,
          emergencyCleanupAttempted: true,
          alivePidsAtDeadline: [],
        });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        forwardedController.abort();
        if (root && typeof ownedProcessGroupId === "number") {
          // Test-harness safety must not depend on the observer behavior under
          // test. Exact test-owned PGID authority is retained until death is
          // independently confirmed, including when an assertion fails.
          await stopRetainedTestGroup(root);
        }
        observer.dispose();
        await stopExactTestProcess(unrelated);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills the complete owned group on parent IPC disconnect without touching an unrelated process",
    async () => {
      const fixture = await createManagedAgentFixture(() => "ipc-disconnect");
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      const unrelated = spawnCooperativeTestProcess();
      await once(unrelated, "spawn");
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [FIXTURE_PATHS.processScript, FIXTURE_PATHS.processPidFile],
          cwd: fixture.workspaceRoot,
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      const ownedProcessGroupId = anchor.pid;
      expect(ownedProcessGroupId).toBeTypeOf("number");
      let observerDisposed = false;
      try {
        const fixturePids = await waitForManagedAgentFixturePids(fixture);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });

        // This test isolates the supervisor's parent-disconnect contract. Stop
        // observer sampling before the kernel delivers the group SIGKILL so a
        // transient, already-signalled reparent cannot make the assertion
        // scheduler-dependent.
        await observer.dispose();
        observerDisposed = true;
        await waitForChildExitBounded(anchor);
        await Promise.all(
          fixturePids.map((pid) =>
            waitForTestProcessDeath(
              () => processExists(pid),
              `IPC-disconnect fixture process ${pid}`,
            ),
          ),
        );
        expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        if (anchor.exitCode === null && anchor.signalCode === null) {
          if (anchor.connected) anchor.disconnect();
          await waitForChildExitBounded(anchor, 250).catch(() => undefined);
        }
        if (anchor.exitCode === null && anchor.signalCode === null) {
          await stopRetainedTestGroup(anchor);
        }
        controller.abort();
        if (!observerDisposed) await observer.dispose();
        await stopExactTestProcess(unrelated);
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "cooperatively shuts down both authenticated fixture processes without a numeric fixture signal",
    async () => {
      const signals: Array<readonly [number, string]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "failure";
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "cooperative-cleanup",
        );

        await observer.dispose();

        await Promise.all(
          run.toolPids.map((pid) =>
            waitForTestProcessDeath(
              () => processExists(pid),
              `Cooperative fixture process ${pid}`,
            ),
          ),
        );
        expect(signals).toEqual([]);
      } finally {
        await observer.dispose();
        run?.forwardedController.abort();
        if (
          run &&
          run.anchor.exitCode === null &&
          run.anchor.signalCode === null
        ) {
          await stopRetainedTestGroup(run.anchor);
        }
      }
    },
    10_000,
  );

  it("fails preparation closed after a fast root exits and never signals its former numeric group", async () => {
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    await once(child, "exit");
    try {
      await expect(
        prepareCancellationAfterTransientReadFailure(observer),
      ).resolves.toMatchObject({
        supported: false,
        reason: "root_not_active",
      });
      forwardedController.abort();
      await observer.emergencyCleanup(deadlineAfter(1));
      expect(signals).toEqual([]);
    } finally {
      observer.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the SDK inner root exits before its child and ancestry is lost",
    () => proveRetainedGroupAuthority("before-readiness"),
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "revokes readiness when the SDK inner root exits and reparents its child",
    () => proveRetainedGroupAuthority("after-readiness"),
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills a freshly revalidated detached tool group wholly descended from the owned root",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "anchored-descendant-tool",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const unrelated = spawnCooperativeTestProcess();
      await once(unrelated, "spawn");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let fixturePids: readonly number[] = [];
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              REGISTERED_DESCENDANT_TOOL_SCRIPT,
              join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
              join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
              // Omit launch evidence to exercise the direct-launcher contract.
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        fixturePids = await waitForManagedAgentFixturePids(fixture);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });

        const teardown = await observer.emergencyCleanup(deadlineAfter(2_000));

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          containmentSupported: true,
          ownershipProven: true,
          forceKillIssued: true,
          toolProcessObservationComplete: true,
          toolProcessChannelsClosed: true,
          alivePidsAtDeadline: [],
        });
        expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
        expect(processExists(unrelated.pid!)).toBe(true);
      } finally {
        forwardedController.abort();
        await observer.dispose();
        if (anchor) {
          await stopRetainedTestGroup(anchor);
        }
        await stopExactTestProcess(unrelated);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "uses process-bound channels in tool-then-supervisor order without host SIGKILL",
    async () => {
      let rootProcessGroupId: number | undefined;
      let toolProcessGroupId: number | undefined;
      const terminationRequests: Array<readonly [number, "SIGKILL"]> = [];
      const hostKillSpy = vi.spyOn(process, "kill");
      const observer = new LocalManagedAgentProcessObserver({
        onTerminationRequest: ({ processGroupId }, outcome) => {
          if (outcome === "sent") {
            terminationRequests.push([processGroupId, "SIGKILL"]);
          }
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "sample-driven-forwarded-fallback",
        );
        rootProcessGroupId = run.anchor.pid!;
        toolProcessGroupId = run.toolProcessGroupId;

        const teardownDeadline = deadlineAfter(3_000);
        observer.beginTeardown(teardownDeadline);
        run.forwardedController.abort();
        const deadline = Date.now() + 2_000;
        while (
          !terminationRequests.some(
            ([groupId, signal]) =>
              groupId === rootProcessGroupId && signal === "SIGKILL",
          ) &&
          Date.now() < deadline
        ) {
          await observer.observeProcessTree();
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }

        expect(terminationRequests).toEqual([
          [toolProcessGroupId, "SIGKILL"],
          [rootProcessGroupId, "SIGKILL"],
        ]);
        expect(
          hostKillSpy.mock.calls.some(([, signal]) => signal === "SIGKILL"),
        ).toBe(false);
        await expect(
          observer.waitForQuiescence(teardownDeadline),
        ).resolves.toMatchObject({
          quiescent: true,
          deadlineMet: true,
          containmentSupported: true,
          forceKillIssued: true,
          toolProcessChannelsClosed: true,
          alivePidsAtDeadline: [],
        });
      } finally {
        hostKillSpy.mockRestore();
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "broadcasts tool termination when the parent channel write is unusable",
    async () => {
      const attemptedRoles: Array<"parent" | "child"> = [];
      const observer = new LocalManagedAgentProcessObserver({
        testOnlyWriteToolTermination: (role) => {
          attemptedRoles.push(role);
          return role === "parent" ? "failure" : undefined;
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "child-channel-termination-fallback",
        );

        const teardown = await observer.emergencyCleanup(deadlineAfter(3_000));

        expect(attemptedRoles).toEqual(["parent", "child"]);
        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          containmentSupported: true,
          forceKillIssued: true,
          toolProcessChannelsClosed: true,
          alivePidsAtDeadline: [],
        });
        expect(run.toolPids.every((pid) => !processExists(pid))).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        await observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "self-terminates the detached tool group when authenticated lifetime channels disappear",
    async () => {
      const hostKillSpy = vi.spyOn(process, "kill");
      const observer = new LocalManagedAgentProcessObserver();
      const unrelated = spawnCooperativeTestProcess();
      await once(unrelated, "spawn");
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "lost-tool-lifetime-channels",
        );

        observer.testOnlyDropToolLifetimeChannels();

        await waitForExactTestProcessIdentitiesToExit(run.toolIdentities);
        expect(run.toolPids.every((pid) => !processExists(pid))).toBe(true);
        expect(processExists(unrelated.pid!)).toBe(true);
        expect(
          hostKillSpy.mock.calls.some(([, signal]) => signal === "SIGKILL"),
        ).toBe(false);
      } finally {
        hostKillSpy.mockRestore();
        await cleanupRegisteredDescendantToolRun(run);
        await observer.dispose();
        await stopExactTestProcess(unrelated);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans exact fixture and anchor groups when setup fails after PID publication",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      let setupEvidence: RegisteredDescendantToolSetupEvidence | undefined;
      try {
        await expect(
          startRegisteredDescendantToolRun(
            observer,
            "failed-registered-tool-setup",
            (evidence) => {
              setupEvidence = evidence;
              throw new Error("synthetic failure after PID publication");
            },
          ),
        ).rejects.toThrow("synthetic failure after PID publication");

        expect(setupEvidence).toBeDefined();
        expect(
          await liveExactTestProcessIdentities(setupEvidence!.toolIdentities),
        ).toEqual([]);
        expect(setupEvidence!.anchor.exitCode).toBeNull();
        expect(setupEvidence!.anchor.signalCode).toBe("SIGKILL");
      } finally {
        if (setupEvidence) {
          await observer.dispose();
          await stopRetainedTestGroup(setupEvidence.anchor);
        }
        await observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "refuses detached tool authority when a foreign member joins the candidate group",
    async () => {
      let injectForeignMember = false;
      let toolProcessGroupId: number | undefined;
      const signals: Array<readonly [number, "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          const observation = await readRealPosixProcessTable();
          if (
            !observation.available ||
            !injectForeignMember ||
            typeof toolProcessGroupId !== "number"
          ) {
            return observation;
          }
          const processes = new Map(observation.processes);
          let foreignPid = 2_000_000_000;
          while (processes.has(foreignPid)) foreignPid -= 1;
          processes.set(foreignPid, {
            parentPid: process.pid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "synthetic-foreign-member",
          });
          return { available: true, processes };
        },
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "failure";
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "foreign-tool-group-member",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        injectForeignMember = true;

        const teardown = await observer.emergencyCleanup(deadlineAfter(250));

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: false,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals a cached detached group after its registered identities disappear and are reused",
    async () => {
      let simulatePidReuse = false;
      let toolProcessGroupId: number | undefined;
      let registeredPids: readonly [number, number] | undefined;
      const signals: Array<readonly [number, "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          const observation = await readRealPosixProcessTable();
          if (
            !observation.available ||
            !simulatePidReuse ||
            typeof toolProcessGroupId !== "number" ||
            !registeredPids
          ) {
            return observation;
          }
          const processes = new Map(observation.processes);
          const [parentPid, childPid] = registeredPids;
          processes.set(parentPid, {
            parentPid: process.pid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "reused-parent-identity",
          });
          processes.set(childPid, {
            parentPid,
            processGroupId: toolProcessGroupId,
            state: "S",
            startedAt: "reused-child-identity",
          });
          return { available: true, processes };
        },
        processGroupLiveness: (groupId) =>
          simulatePidReuse && groupId === toolProcessGroupId
            ? "alive"
            : realProcessGroupLiveness(groupId),
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "failure";
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "reused-tool-identities",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        registeredPids = run.toolPids;
        simulatePidReuse = true;

        const teardown = await observer.emergencyCleanup(deadlineAfter(250));

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: false,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
      } finally {
        simulatePidReuse = false;
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "retries detached tool kill failures only after fresh authority checks",
    async () => {
      let processTableReads = 0;
      let toolProcessGroupId: number | undefined;
      let killAttempts = 0;
      const toolSignals: Array<{
        readonly signal: "SIGKILL";
        readonly processTableReads: number;
      }> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          processTableReads += 1;
          return readRealPosixProcessTable();
        },
        testOnlyBeforeTerminationRequest: ({ target }) => {
          if (target === "tool" && killAttempts++ === 0) return "failure";
          return undefined;
        },
        onTerminationRequest: ({ processGroupId, target }) => {
          if (target === "tool" && processGroupId === toolProcessGroupId) {
            toolSignals.push({ signal: "SIGKILL", processTableReads });
          }
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "retry-tool-signals",
        );
        toolProcessGroupId = run.toolProcessGroupId;

        const teardown = await observer.emergencyCleanup(deadlineAfter(3_000));

        expect(teardown).toMatchObject({
          quiescent: true,
          deadlineMet: true,
          forceKillIssued: true,
          alivePidsAtDeadline: [],
        });
        expect(toolSignals.map(({ signal }) => signal)).toEqual([
          "SIGKILL",
          "SIGKILL",
        ]);
        expect(
          toolSignals.every(
            (attempt, index) =>
              index === 0 ||
              attempt.processTableReads >
                toolSignals[index - 1]!.processTableReads,
          ),
        ).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals the detached tool group after the owned root exits and ancestry is lost",
    async () => {
      let toolProcessGroupId: number | undefined;
      const signals: Array<readonly [number, "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "failure";
        },
      });
      let run: RegisteredDescendantToolRun | undefined;
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "root-exit-loses-tool-ancestry",
        );
        toolProcessGroupId = run.toolProcessGroupId;
        await stopRetainedTestGroup(run.anchor);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);

        const teardown = await observer.emergencyCleanup(deadlineAfter(250));

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: false,
        });
        expect(
          signals.filter(([groupId]) => groupId === toolProcessGroupId),
        ).toEqual([]);
        expect(processGroupExists(toolProcessGroupId)).toBe(true);
      } finally {
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never signals a detached PGID merely because a capability holder claimed it",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "unanchored-tool-registration",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const credentialFile = join(fixture.root, "tool-control.json");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let detachedTool: ChildProcess | undefined;
      let registrations: readonly NetSocket[] = [];
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              EXPORT_TOOL_CONTROL_SCRIPT,
              credentialFile,
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        const credentials = await waitForToolControlCredentials(credentialFile);
        detachedTool = spawnChild(
          process.execPath,
          [
            FIXTURE_PATHS.processScript,
            FIXTURE_PATHS.processPidFile,
            "--host-cleanup-marker",
            fixture.cooperativeExitMarker,
          ],
          {
            cwd: fixture.workspaceRoot,
            detached: true,
            env: { ...process.env },
            stdio: "ignore",
            windowsHide: true,
          },
        );
        const [toolParentPid, toolChildPid] =
          await waitForManagedAgentFixturePids(fixture);
        expect(toolParentPid).toBe(detachedTool.pid);
        expect(toolChildPid).toBeTypeOf("number");
        registrations = await Promise.all([
          startToolRegistration(credentials, "parent", toolParentPid),
          startToolRegistration(credentials, "child", toolChildPid),
        ]);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: false,
          reason: "tool_process_not_registered",
        });

        const teardown = await observer.emergencyCleanup(deadlineAfter(100));

        expect(teardown.quiescent).toBe(false);
        expect(processGroupExists(detachedTool.pid!)).toBe(true);
      } finally {
        for (const registration of registrations) registration.destroy();
        forwardedController.abort();
        await fixture.requestCooperativeExit();
        if (detachedTool) await waitForChildExitBounded(detachedTool);
        await observer.dispose();
        if (anchor) {
          await stopRetainedTestGroup(anchor);
        }
        await observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "clears a closed pending registration, accepts retries, and requires both lifetime channels to close",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "tool-registration-retry",
      );
      fixtures.push(fixture);
      const observer = new LocalManagedAgentProcessObserver();
      const forwardedController = new AbortController();
      const credentialFile = join(fixture.root, "tool-control.json");
      let anchor: ChildProcessWithoutNullStreams | undefined;
      let toolPids: readonly number[] = [];
      let parentRegistration: NetSocket | undefined;
      let childRegistration: NetSocket | undefined;
      try {
        observer.armToolProcessContainment();
        anchor = asChildProcess(
          observer.spawn({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              DESCENDANT_TOOL_SCRIPT,
              join(fixture.workspaceRoot, FIXTURE_PATHS.processScript),
              join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
              credentialFile,
              fixture.cooperativeExitMarker,
            ],
            cwd: fixture.workspaceRoot,
            env: { ...process.env },
            signal: forwardedController.signal,
          }),
        );
        const credentials = await waitForToolControlCredentials(credentialFile);
        const [toolParentPid, toolChildPid] =
          await waitForManagedAgentFixturePids(fixture);
        toolPids = [toolParentPid, toolChildPid];

        await sendClosedToolRegistration(credentials, "parent", toolParentPid);
        [parentRegistration, childRegistration] = await Promise.all([
          openToolRegistration(credentials, "parent", toolParentPid),
          openToolRegistration(credentials, "child", toolChildPid),
        ]);
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          containmentSupported: true,
        });

        await fixture.requestCooperativeExit();
        await Promise.all(
          toolPids.map((pid) =>
            waitForTestProcessDeath(
              () => processExists(pid),
              `Marker-authenticated fixture process ${pid}`,
            ),
          ),
        );
        const teardownDeadline = deadlineAfter(1_000);
        observer.beginTeardown(teardownDeadline);
        forwardedController.abort();
        const openChannelObservation =
          await observer.emergencyCleanup(teardownDeadline);
        await waitForChildExitBounded(anchor);
        expect(openChannelObservation).toMatchObject({
          quiescent: false,
          deadlineMet: false,
        });

        parentRegistration.destroy();
        childRegistration.destroy();
        const finalObservation =
          await observer.waitForQuiescence(teardownDeadline);
        expect(finalObservation).toMatchObject({
          quiescent: false,
          deadlineMet: false,
        });
      } finally {
        parentRegistration?.destroy();
        childRegistration?.destroy();
        forwardedController.abort();
        await fixture.requestCooperativeExit();
        await observer.dispose();
        if (anchor) await stopRetainedTestGroup(anchor);
        await observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never reports an armed but unregistered tool scope as quiescent",
    async () => {
      const observer = new LocalManagedAgentProcessObserver();
      const controller = new AbortController();
      observer.armToolProcessContainment();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      try {
        if (anchor.exitCode === null && anchor.signalCode === null) {
          await once(anchor, "exit");
        }
        const teardownDeadline = deadlineAfter(50);
        await expect(
          observer.waitForQuiescence(teardownDeadline),
        ).resolves.toMatchObject({
          quiescent: false,
          deadlineMet: false,
          containmentSupported: false,
        });
        await expect(
          observer.emergencyCleanup(teardownDeadline),
        ).resolves.toMatchObject({
          quiescent: false,
          deadlineMet: false,
          containmentSupported: false,
        });
      } finally {
        controller.abort();
        await stopRetainedTestGroup(anchor);
        observer.dispose();
      }
    },
    5_000,
  );

  it("bounds a hanging process-table read and never turns unknown observation into quiescence", async () => {
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: () => new Promise(() => undefined),
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "failure";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    const startedAt = Date.now();
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "process_table_unavailable",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const shortConfirmationStartedAt = Date.now();
      await expect(
        observer.waitForQuiescence(deadlineAfter(50)),
      ).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        processTableAvailable: false,
      });
      expect(Date.now() - shortConfirmationStartedAt).toBeLessThan(150);

      controller.abort();
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(child);
      controller.abort();
      observer.dispose();
    }
  });

  it("remembers an SDK abort but grants no fallback signal before deadline adoption", async () => {
    let rootPid = 0;
    const signals: Array<readonly [number, "SIGKILL"]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: rootPid,
              state: "S",
              startedAt: "abort-before-deadline",
            },
          ],
        ]),
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });

      controller.abort();
      expect(signals).toEqual([]);

      observer.beginTeardown(deadlineAfter(100));
      await vi.waitFor(() => expect(signals).toEqual([[rootPid, "SIGKILL"]]));
    } finally {
      await stopRetainedTestGroup(child);
      await observer.dispose();
    }
  });

  it("closes the spawn gate as soon as teardown adopts its immutable deadline", async () => {
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => available([]),
    });
    try {
      observer.beginTeardown(deadlineAfter(1_000));
      expect(() =>
        observer.spawn({
          ...activeNodeCommand(),
          cwd: process.cwd(),
          env: { ...process.env },
          signal: new AbortController().signal,
        }),
      ).toThrow("managed-agent process observer is closed");
    } finally {
      await observer.dispose();
    }
  });

  it("seals a successful quiescence observation against delayed SDK spawns", async () => {
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => available([]),
    });
    try {
      await expect(
        observer.waitForQuiescence(deadlineAfter(1_000)),
      ).resolves.toMatchObject({ quiescent: true, deadlineMet: true });
      expect(() =>
        observer.spawn({
          ...activeNodeCommand(),
          cwd: process.cwd(),
          env: { ...process.env },
          signal: new AbortController().signal,
        }),
      ).toThrow("managed-agent process observer is closed");
    } finally {
      await observer.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "never uses a host numeric signal when channel confirmation misses the deadline",
    async () => {
      let hangAfterRequest = false;
      const terminationRequests: Array<readonly [number, "SIGKILL"]> = [];
      const hostKillSpy = vi.spyOn(process, "kill");
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: () =>
          hangAfterRequest
            ? new Promise<ManagedAgentProcessTableObservation>(() => undefined)
            : readRealPosixProcessTable(),
        onTerminationRequest: ({ processGroupId }, outcome) => {
          if (outcome === "sent") {
            terminationRequests.push([processGroupId, "SIGKILL"]);
            // From this point onward, the sampled numeric PGID could be reused.
            // No later host operation may signal it.
            hangAfterRequest = true;
          }
        },
      });
      const controller = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          ...activeNodeCommand(),
          cwd: process.cwd(),
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      try {
        await expect(
          prepareCancellationAfterTransientReadFailure(observer),
        ).resolves.toMatchObject({ supported: true, reason: "ready" });
        const teardownDeadline = deadlineAfter(75);
        observer.beginTeardown(teardownDeadline);
        controller.abort();

        const teardown = await observer.emergencyCleanup(teardownDeadline);
        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          forceKillIssued: true,
        });
        expect(hangAfterRequest).toBe(true);
        expect(terminationRequests).toEqual([[anchor.pid!, "SIGKILL"]]);
        expect(
          hostKillSpy.mock.calls.some(([, signal]) => signal === "SIGKILL"),
        ).toBe(false);

        await observer.dispose();
        await waitForChildExitBounded(anchor);
        expect(terminationRequests).toEqual([[anchor.pid!, "SIGKILL"]]);
        expect(processGroupExists(anchor.pid!)).toBe(false);
      } finally {
        hostKillSpy.mockRestore();
        await stopRetainedTestGroup(anchor);
        await observer.dispose();
      }
    },
    10_000,
  );

  it("marks an observed POSIX group escape unsupported without authorizing an individual signal", async () => {
    let rootPid = 0;
    let escaped = false;
    const signals: Array<readonly [number, string]> = [];
    const table = async (): Promise<ManagedAgentProcessTableObservation> => {
      const rootRecord = {
        parentPid: process.pid,
        processGroupId: rootPid,
        startedAt: "root",
      };
      const childRecord = {
        parentPid: rootPid,
        processGroupId: escaped ? rootPid + 1 : rootPid,
        startedAt: "child",
      };
      return available([
        [rootPid, rootRecord],
        [rootPid + 100, childRecord],
      ]);
    };
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: table,
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      escaped = true;
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: false,
        containmentSupported: false,
      });
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(child);
      controller.abort();
      observer.dispose();
    }
  });

  it("treats zombie topology drift as dead rather than a containment escape", async () => {
    let rootPid = 0;
    let zombie = false;
    let now = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: 0,
              state: "Ss",
              startedAt: "root",
            },
          ],
          [
            rootPid + 100,
            {
              parentPid: zombie ? 1 : rootPid,
              processGroupId: zombie ? rootPid + 200 : rootPid,
              sessionId: zombie ? 999 : 0,
              state: zombie ? "Z+" : "S",
              startedAt: "child",
            },
          ],
        ]),
      processGroupLiveness: () => "gone",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
      monotonicNow: () => now,
      delay: async (milliseconds) => {
        now += Math.max(1, milliseconds);
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      zombie = true;
      await observer.observeProcessTree();

      const observation = await observer.waitForQuiescence(
        deadlineAfter(1, now),
      );
      expect(observation).toMatchObject({
        quiescent: false,
        containmentSupported: true,
      });
      expect(observation.alivePidsAtDeadline).not.toContain(rootPid + 100);
      expect(observation.alivePidsAtDeadline).not.toContain(rootPid + 200);
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("keeps pre-signal non-zombie topology drift permanently fail-closed", async () => {
    let rootPid = 0;
    let escaped = false;
    let gone = false;
    let now = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        gone
          ? available([])
          : available([
              [
                rootPid,
                {
                  parentPid: process.pid,
                  processGroupId: rootPid,
                  sessionId: 0,
                  state: "Ss",
                  startedAt: "root",
                },
              ],
              [
                rootPid + 100,
                {
                  parentPid: escaped ? 1 : rootPid,
                  processGroupId: escaped ? rootPid + 200 : rootPid,
                  sessionId: escaped ? 999 : 0,
                  state: "S",
                  startedAt: "child",
                },
              ],
            ]),
      processGroupLiveness: () => "gone",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
      monotonicNow: () => now,
      delay: async (milliseconds) => {
        now += Math.max(1, milliseconds);
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      escaped = true;
      await observer.observeProcessTree();

      const teardownDeadline = deadlineAfter(1, now);
      const observation = await observer.waitForQuiescence(teardownDeadline);
      expect(observation).toMatchObject({
        quiescent: false,
        containmentSupported: false,
      });
      expect(observation.alivePidsAtDeadline).toEqual(
        expect.arrayContaining([rootPid + 100, rootPid + 200]),
      );
      expect(signals).toEqual([]);

      controller.abort();
      gone = true;
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(teardownDeadline),
      ).resolves.toMatchObject({
        quiescent: false,
        containmentSupported: false,
      });
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("keeps post-SIGKILL stable exit drift live until disappearance without invalidating containment", async () => {
    let rootPid = 0;
    let stage: "owned" | "exiting" | "gone" = "owned";
    let now = 0;
    const signals: Array<readonly [number, "SIGKILL"]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        if (stage === "gone") return available([]);
        if (stage === "exiting") {
          return available([
            [
              rootPid + 100,
              {
                parentPid: 1,
                processGroupId: rootPid,
                sessionId: 0,
                state: "?E",
                startedAt: "child",
              },
            ],
          ]);
        }
        return available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: 0,
              state: "Ss",
              startedAt: "root",
            },
          ],
          [
            rootPid + 100,
            {
              parentPid: rootPid,
              processGroupId: rootPid,
              sessionId: 0,
              state: "S",
              startedAt: "child",
            },
          ],
        ]);
      },
      processGroupLiveness: () => (stage === "gone" ? "gone" : "alive"),
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
      monotonicNow: () => now,
      delay: async (milliseconds) => {
        now += Math.max(1, milliseconds);
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      const teardownDeadline = deadlineAfter(100, now);
      observer.beginTeardown(teardownDeadline);
      controller.abort();
      await observer.observeProcessTree();
      expect(signals).toEqual([[rootPid, "SIGKILL"]]);

      stage = "exiting";
      await observer.observeProcessTree();

      stage = "gone";
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(teardownDeadline),
      ).resolves.toMatchObject({
        quiescent: true,
        deadlineMet: true,
        containmentSupported: true,
        alivePidsAtDeadline: [],
      });
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("never authorizes a group signal from zombie-only root evidence", async () => {
    let rootPid = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: 1,
              processGroupId: rootPid,
              sessionId: 0,
              state: "Z",
              startedAt: "root",
            },
          ],
        ]),
      processGroupLiveness: () => "alive",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "root_not_active",
        ownershipProven: false,
      });
      controller.abort();
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("allows normal quiescence only after a still-descended unauthenticated subgroup is positively dead", async () => {
    let rootPid = 0;
    let rootAlive = true;
    let subgroupAlive = true;
    const subgroupPid = () => rootPid + 100;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        await Promise.resolve();
        return available([
          ...(rootAlive
            ? ([
                [
                  rootPid,
                  {
                    parentPid: process.pid,
                    processGroupId: rootPid,
                    sessionId: rootPid,
                    startedAt: "root",
                  },
                ],
              ] as const)
            : []),
          ...(subgroupAlive
            ? ([
                [
                  subgroupPid(),
                  {
                    parentPid: rootPid,
                    processGroupId: subgroupPid(),
                    sessionId: subgroupPid(),
                    startedAt: "short-lived-subgroup",
                  },
                ],
              ] as const)
            : []),
        ]);
      },
      processGroupLiveness: (processGroupId) =>
        processGroupId === rootPid
          ? rootAlive
            ? "alive"
            : "gone"
          : subgroupAlive
            ? "alive"
            : "gone",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await observer.observeProcessTree();
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "containment_escaped",
        ownershipProven: false,
        observedPids: expect.arrayContaining([subgroupPid()]),
      });
      expect(signals).toEqual([]);

      subgroupAlive = false;
      await observer.observeProcessTree();
      rootAlive = false;
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: true,
        deadlineMet: true,
        containmentSupported: true,
        alivePidsAtDeadline: [],
      });
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("keeps a live unauthenticated descendant subgroup nonquiescent without granting it signal authority", async () => {
    let rootPid = 0;
    const subgroupPid = () => rootPid + 100;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: rootPid,
              startedAt: "root",
            },
          ],
          [
            subgroupPid(),
            {
              parentPid: rootPid,
              processGroupId: subgroupPid(),
              sessionId: subgroupPid(),
              startedAt: "surviving-subgroup",
            },
          ],
        ]),
      processGroupLiveness: () => "alive",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
        alivePidsAtDeadline: expect.arrayContaining([subgroupPid()]),
      });
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("keeps an unauthenticated subgroup permanently failed closed if its stable identity loses root ancestry", async () => {
    let rootPid = 0;
    let subgroupState: "descended" | "reparented" | "gone" = "descended";
    const subgroupPid = () => rootPid + 100;
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        const subgroup =
          subgroupState === "gone"
            ? []
            : [
                [
                  subgroupPid(),
                  {
                    parentPid:
                      subgroupState === "descended" ? rootPid : process.pid,
                    processGroupId: subgroupPid(),
                    sessionId: subgroupPid(),
                    startedAt: "reparented-subgroup",
                  },
                ] as const,
              ];
        return available([
          ...(subgroupState === "descended"
            ? ([
                [
                  rootPid,
                  {
                    parentPid: process.pid,
                    processGroupId: rootPid,
                    sessionId: rootPid,
                    startedAt: "root",
                  },
                ],
              ] as const)
            : []),
          ...subgroup,
        ]);
      },
      processGroupLiveness: () => "gone",
      testOnlyRequestTermination: () => "sent",
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await observer.observeProcessTree();
      subgroupState = "reparented";
      await observer.observeProcessTree();
      subgroupState = "gone";
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
        alivePidsAtDeadline: [],
      });
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it("retains a same-PGID subgroup child when its leader exits and the survivor reparents between samples", async () => {
    let rootPid = 0;
    const subgroupLeaderPid = () => rootPid + 100;
    const subgroupChildPid = () => rootPid + 101;
    let stage: "complete" | "leader_gone" | "all_gone" = "complete";
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: rootPid,
              state: "S",
              startedAt: "pending-root",
            },
          ],
          ...(stage === "complete"
            ? ([
                [
                  subgroupLeaderPid(),
                  {
                    parentPid: rootPid,
                    processGroupId: subgroupLeaderPid(),
                    sessionId: subgroupLeaderPid(),
                    state: "S",
                    startedAt: "pending-leader",
                  },
                ],
              ] as const)
            : []),
          ...(stage !== "all_gone"
            ? ([
                [
                  subgroupChildPid(),
                  {
                    parentPid:
                      stage === "complete" ? subgroupLeaderPid() : process.pid,
                    processGroupId: subgroupLeaderPid(),
                    sessionId: subgroupLeaderPid(),
                    state: "S",
                    startedAt: "pending-child",
                  },
                ],
              ] as const)
            : []),
        ]),
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "containment_escaped",
        observedPids: expect.arrayContaining([
          subgroupLeaderPid(),
          subgroupChildPid(),
        ]),
      });

      stage = "leader_gone";
      await observer.observeProcessTree();
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "containment_escaped",
        observedPids: expect.arrayContaining([subgroupChildPid()]),
      });
      forwardedController.abort();
      expect(signals).toEqual([]);

      stage = "all_gone";
      await observer.observeProcessTree();
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: false,
        reason: "containment_escaped",
      });
      expect(signals).toEqual([]);
    } finally {
      await stopRetainedTestGroup(anchor);
      forwardedController.abort();
      observer.dispose();
    }
  });

  it("keeps a subgroup escape after an authorized root kill permanently failed closed", async () => {
    let rootPid = 0;
    let subgroupState: "root_group" | "reparented" | "gone" = "root_group";
    const subgroupPid = () => rootPid + 100;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        if (subgroupState === "gone") return available([]);
        return available([
          ...(subgroupState === "root_group"
            ? ([
                [
                  rootPid,
                  {
                    parentPid: process.pid,
                    processGroupId: rootPid,
                    sessionId: rootPid,
                    state: "S",
                    startedAt: "root",
                  },
                ],
              ] as const)
            : []),
          [
            subgroupPid(),
            {
              parentPid: subgroupState === "root_group" ? rootPid : process.pid,
              processGroupId:
                subgroupState === "root_group" ? rootPid : subgroupPid(),
              sessionId:
                subgroupState === "root_group" ? rootPid : subgroupPid(),
              state: "S",
              startedAt: "survived-root-kill",
            },
          ],
        ]);
      },
      processGroupLiveness: () => "alive",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        subgroupState = "reparented";
        return "sent";
      },
    });
    const controller = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = anchor.pid!;
    try {
      await expect(observer.prepareCancellation()).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });
      const teardownDeadline = deadlineAfter(100);
      observer.beginTeardown(teardownDeadline);
      controller.abort();
      await observer.observeProcessTree();
      expect(signals).toEqual([[rootPid, "SIGKILL"]]);
      await observer.observeProcessTree();
      subgroupState = "gone";
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(teardownDeadline),
      ).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
        alivePidsAtDeadline: [],
      });
    } finally {
      await stopRetainedTestGroup(anchor);
      controller.abort();
      observer.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "blocks L2 readiness when an authenticated tool run gains an unauthenticated descendant group",
    async () => {
      let injectUnknownDescendant = false;
      let run: RegisteredDescendantToolRun | undefined;
      let syntheticPid = 2_000_000_000;
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          const observation = await readRealPosixProcessTable();
          if (!observation.available || !injectUnknownDescendant || !run) {
            return observation;
          }
          const processes = new Map(observation.processes);
          while (processes.has(syntheticPid)) syntheticPid -= 1;
          processes.set(syntheticPid, {
            parentPid: run.anchor.pid!,
            processGroupId: syntheticPid,
            sessionId: syntheticPid,
            state: "S",
            startedAt: "synthetic-unknown-l2-descendant",
          });
          return { available: true, processes };
        },
      });
      try {
        run = await startRegisteredDescendantToolRun(
          observer,
          "unknown-l2-descendant",
        );
        injectUnknownDescendant = true;
        await observer.observeProcessTree();
        await expect(observer.prepareCancellation()).resolves.toMatchObject({
          supported: false,
          reason: "containment_escaped",
          ownershipProven: false,
        });
      } finally {
        injectUnknownDescendant = false;
        await cleanupRegisteredDescendantToolRun(run);
        observer.dispose();
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "never loses a reparented escaped tool grandchild or signals its new group",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "reparented-tool-grandchild",
      );
      fixtures.push(fixture);
      const credentialFile = join(fixture.root, "tool-control.json");
      let rootPid = 0;
      let escaped = false;
      let toolParentPid = 0;
      let toolChildPid = 0;
      let toolGrandchildPid = 0;
      let escapedGroupId = 0;
      const signals: Array<readonly [number, "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        readProcessTable: async () => {
          await Promise.resolve();
          if (escaped) {
            return available([
              [
                toolGrandchildPid,
                {
                  parentPid: 1,
                  processGroupId: escapedGroupId,
                  sessionId: escapedGroupId,
                  startedAt: "tool-grandchild",
                },
              ],
            ]);
          }
          return available([
            [
              process.pid,
              {
                parentPid: process.ppid,
                processGroupId: process.pid,
                sessionId: process.pid,
                startedAt: "host",
              },
            ],
            [
              rootPid,
              {
                parentPid: process.pid,
                processGroupId: rootPid,
                sessionId: rootPid,
                startedAt: "root-100",
              },
            ],
            [
              toolParentPid,
              {
                parentPid: rootPid,
                processGroupId: toolParentPid,
                sessionId: toolParentPid,
                startedAt: "tool-parent-200",
              },
            ],
            [
              toolChildPid,
              {
                parentPid: toolParentPid,
                processGroupId: toolParentPid,
                sessionId: toolParentPid,
                startedAt: "tool-child-201",
              },
            ],
            [
              toolGrandchildPid,
              {
                parentPid: toolChildPid,
                processGroupId: toolParentPid,
                sessionId: toolParentPid,
                startedAt: "tool-grandchild",
              },
            ],
          ]);
        },
        processGroupLiveness: (groupId) =>
          escaped && groupId === escapedGroupId ? "alive" : "gone",
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "sent";
        },
      });
      const controller = new AbortController();
      observer.armToolProcessContainment();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            EXPORT_TOOL_CONTROL_SCRIPT,
            credentialFile,
          ],
          cwd: fixture.workspaceRoot,
          env: { ...process.env },
          signal: controller.signal,
        }),
      );
      rootPid = anchor.pid!;
      toolParentPid = rootPid + 10_000;
      toolChildPid = toolParentPid + 1;
      toolGrandchildPid = toolParentPid + 2;
      escapedGroupId = toolParentPid + 3;
      let registrations: readonly NetSocket[] = [];
      try {
        const credentials = await waitForToolControlCredentials(credentialFile);
        registrations = await Promise.all([
          openToolRegistration(credentials, "parent", toolParentPid),
          openToolRegistration(credentials, "child", toolChildPid),
        ]);
        await expect(observer.prepareCancellation()).resolves.toMatchObject({
          supported: true,
          reason: "ready",
          ownershipProven: true,
        });

        escaped = true;
        const registrationClosures = registrations.map((socket) =>
          once(socket, "close"),
        );
        for (const socket of registrations) socket.destroy();
        await Promise.all(registrationClosures);
        await stopRetainedTestGroup(anchor);

        const teardown = await observer.emergencyCleanup(deadlineAfter(50));

        expect(teardown).toMatchObject({
          quiescent: false,
          deadlineMet: false,
          containmentSupported: false,
        });
        expect(teardown.alivePidsAtDeadline).toEqual(
          expect.arrayContaining([toolGrandchildPid, escapedGroupId]),
        );
        expect(signals.some(([groupId]) => groupId === escapedGroupId)).toBe(
          false,
        );
      } finally {
        for (const socket of registrations) socket.destroy();
        await stopRetainedTestGroup(anchor);
        controller.abort();
        observer.dispose();
      }
    },
    10_000,
  );

  it("makes repeated SDK-forwarded abort delivery idempotent after ownership preparation", async () => {
    let rootPid = 0;
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              state: "S",
              startedAt: "root",
            },
          ],
          [
            rootPid + 100,
            {
              parentPid: rootPid,
              processGroupId: rootPid,
              state: "S",
              startedAt: "child",
            },
          ],
        ]),
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await observer.prepareCancellation();
      observer.beginTeardown(deadlineAfter(100));
      forwardedController.abort();
      forwardedController.abort();
      await observer.observeProcessTree();
      expect(signals).toEqual([[rootPid, "SIGKILL"]]);
      await observer.observeProcessTree();
      expect(signals).toHaveLength(1);
    } finally {
      await stopRetainedTestGroup(child);
      observer.dispose();
    }
  });

  it("retries transient root kill failures only after fresh authority samples", async () => {
    let rootPid = 0;
    let processTableReads = 0;
    let killAttempts = 0;
    const signals: Array<readonly [number, string]> = [];
    const signalReadCounts: number[] = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        processTableReads += 1;
        return available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              state: "S",
              startedAt: "root",
            },
          ],
        ]);
      },
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        signalReadCounts.push(processTableReads);
        if (killAttempts++ === 0) return "failure";
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = child.pid!;
    try {
      await observer.prepareCancellation();
      const teardownDeadline = deadlineAfter(100);
      await observer.emergencyCleanup(teardownDeadline);

      expect(signals).toEqual([
        [rootPid, "SIGKILL"],
        [rootPid, "SIGKILL"],
      ]);
      expect(
        signalReadCounts.every(
          (readCount, index) =>
            index === 0 || readCount > signalReadCounts[index - 1]!,
        ),
      ).toBe(true);
      await expect(
        observer.waitForQuiescence(teardownDeadline),
      ).resolves.toMatchObject({
        containmentSupported: true,
        forceKillIssued: true,
        quiescent: false,
      });
    } finally {
      await stopRetainedTestGroup(child);
      observer.dispose();
    }
  });

  it("treats an unexpected group-liveness probe error as unknown, never gone", async () => {
    let rootPid = 0;
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () =>
        available([
          [
            rootPid,
            {
              parentPid: process.pid,
              processGroupId: rootPid,
              sessionId: 0,
              state: "S",
              startedAt: "reported-live-root",
            },
          ],
        ]),
      processGroupLiveness: () => "unknown",
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    rootPid = child.pid!;
    await once(child, "exit");
    try {
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
      });
    } finally {
      controller.abort();
      observer.dispose();
    }
  });

  it("accepts complete process-table absence without probing a cached group", async () => {
    let livenessProbes = 0;
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => available([]),
      processGroupLiveness: () => {
        livenessProbes += 1;
        return "unknown";
      },
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    await once(child, "exit");
    try {
      await observer.observeProcessTree();
      await expect(
        observer.waitForQuiescence(deadlineAfter(1)),
      ).resolves.toMatchObject({
        quiescent: true,
        deadlineMet: true,
        containmentSupported: true,
        alivePidsAtDeadline: [],
      });
      expect(livenessProbes).toBe(0);
    } finally {
      controller.abort();
      observer.dispose();
    }
  });

  it("reports quiescence after the caller budget as a missed deadline", async () => {
    let now = 0;
    let measureOverrun = false;
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: async () => {
        if (measureOverrun) now = 2;
        return available([]);
      },
      monotonicNow: () => now,
    });
    const controller = new AbortController();
    const child = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    try {
      await observer.observeProcessTree();
      now = 0;
      measureOverrun = true;

      await expect(
        observer.waitForQuiescence(deadlineAfter(1, 0)),
      ).resolves.toMatchObject({
        quiescent: true,
        deadlineMet: false,
        elapsedMs: 2,
        processTableAvailable: true,
        alivePidsAtDeadline: [],
      });
    } finally {
      if (typeof child.pid === "number") {
        await stopRetainedTestGroup(child);
      }
      controller.abort();
      observer.dispose();
    }
  });

  it("rejects Windows cancellation containment before granting signal authority", async () => {
    const observer = new LocalManagedAgentProcessObserver({
      platform: "win32",
    });
    await expect(observer.prepareCancellation()).resolves.toMatchObject({
      supported: false,
      reason: "platform_unsupported",
      ownershipProven: false,
    });
    observer.dispose();
  });

  it("never tracks or signals PIDs injected through the model-writable fixture file", async () => {
    const fixture = await createManagedAgentFixture(() => "forged-pids");
    fixtures.push(fixture);
    const forgedPids = [process.pid, 2_147_483_646] as const;
    await writeFile(
      join(fixture.workspaceRoot, FIXTURE_PATHS.processPidFile),
      JSON.stringify({ parentPid: forgedPids[0], childPid: forgedPids[1] }),
    );
    const signals: Array<readonly [number, string]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    try {
      await expect(waitForManagedAgentFixturePids(fixture)).resolves.toEqual(
        forgedPids,
      );
      await observer.observeProcessTree();
      const teardownDeadline = deadlineAfter(1);
      const teardown = await observer.waitForQuiescence(teardownDeadline);
      await observer.emergencyCleanup(teardownDeadline);

      expect(teardown.observedPids).not.toContain(forgedPids[0]);
      expect(teardown.observedPids).not.toContain(forgedPids[1]);
      expect(signals).toEqual([]);
    } finally {
      observer.dispose();
    }
  });

  it("does not let a process-table read started before a signal authorize the next signal", async () => {
    let rootPid = 0;
    const reads: Array<
      (observation: ManagedAgentProcessTableObservation) => void
    > = [];
    const signals: Array<readonly [number, "SIGKILL"]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      readProcessTable: () =>
        new Promise<ManagedAgentProcessTableObservation>((resolveRead) => {
          reads.push(resolveRead);
        }),
      processGroupLiveness: () => "alive",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    rootPid = anchor.pid!;
    const rootTable = () =>
      available([
        [
          rootPid,
          {
            parentPid: process.pid,
            processGroupId: rootPid,
            sessionId: rootPid,
            state: "S",
            startedAt: "epoch-root",
          },
        ],
      ]);

    try {
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      const initialSample = observer.observeProcessTree();
      reads.shift()!(rootTable());
      await initialSample;

      const readinessTask = observer.prepareCancellation();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads.shift()!(rootTable());
      await expect(readinessTask).resolves.toMatchObject({
        supported: true,
        reason: "ready",
      });

      const preSignalSample = observer.observeProcessTree();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      observer.beginTeardown(deadlineAfter(1_000));
      forwardedController.abort();
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      expect(signals).toEqual([]);

      // Completing the read that started before teardown cannot install its
      // evidence or authorize a request in the new lifecycle generation.
      reads.shift()!(rootTable());
      await preSignalSample;
      expect(signals).toEqual([]);

      // Only the complete read that started after teardown can authorize the
      // one process-bound termination request.
      const postSignalSample = observer.observeProcessTree();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads.shift()!(rootTable());
      await postSignalSample;
      expect(signals).toEqual([[rootPid, "SIGKILL"]]);
    } finally {
      await stopRetainedTestGroup(anchor);
      forwardedController.abort();
      observer.dispose();
    }
  });

  it.each(["deadline", "dispose"] as const)(
    "seals held process-table reads after %s so late completion cannot mutate or signal",
    async (sealKind) => {
      let rootPid = 0;
      let monotonicTime = 0;
      let resolveRead!: (
        observation: ManagedAgentProcessTableObservation,
      ) => void;
      const signals: Array<readonly [number, "SIGKILL"]> = [];
      const observer = new LocalManagedAgentProcessObserver({
        platform: "darwin",
        monotonicNow: () => monotonicTime,
        readProcessTable: () =>
          new Promise<ManagedAgentProcessTableObservation>((resolve) => {
            resolveRead = resolve;
          }),
        testOnlyRequestTermination: (groupId, signal) => {
          signals.push([groupId, signal]);
          return "sent";
        },
      });
      const forwardedController = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          ...activeNodeCommand(),
          cwd: process.cwd(),
          env: { ...process.env },
          signal: forwardedController.signal,
        }),
      );
      rootPid = anchor.pid!;
      const deadline = Object.freeze({ startedAtMs: 0, deadlineAtMs: 10 });
      try {
        await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
        if (sealKind === "deadline") {
          monotonicTime = 11;
          await observer.waitForQuiescence(deadline);
        } else {
          await observer.dispose();
        }
        const signalsAtSeal = [...signals];
        resolveRead(
          available([
            [
              rootPid,
              {
                parentPid: process.pid,
                processGroupId: rootPid,
                sessionId: rootPid,
                state: "T",
                startedAt: "late-root",
              },
            ],
          ]),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        forwardedController.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(signals).toEqual(signalsAtSeal);
        expect(await observer.observeProcessTree(deadline)).toBe(false);
      } finally {
        await stopRetainedTestGroup(anchor);
        forwardedController.abort();
        await observer.dispose();
      }
    },
  );

  it("discards an in-flight background sample that completes after a newly adopted deadline", async () => {
    let monotonicTime = 0;
    let resolveRead!: (
      observation: ManagedAgentProcessTableObservation,
    ) => void;
    const signals: Array<readonly [number, "SIGKILL"]> = [];
    const observer = new LocalManagedAgentProcessObserver({
      platform: "darwin",
      monotonicNow: () => monotonicTime,
      readProcessTable: () =>
        new Promise<ManagedAgentProcessTableObservation>((resolve) => {
          resolveRead = resolve;
        }),
      processGroupLiveness: () => "gone",
      testOnlyRequestTermination: (groupId, signal) => {
        signals.push([groupId, signal]);
        return "sent";
      },
    });
    const forwardedController = new AbortController();
    const anchor = asChildProcess(
      observer.spawn({
        ...activeNodeCommand(),
        cwd: process.cwd(),
        env: { ...process.env },
        signal: forwardedController.signal,
      }),
    );
    const deadline = Object.freeze({ startedAtMs: 0, deadlineAtMs: 10 });
    try {
      await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
      const observationTask = observer.waitForQuiescence(deadline);
      monotonicTime = 11;
      resolveRead(available([]));

      await expect(observationTask).resolves.toMatchObject({
        quiescent: false,
        deadlineMet: false,
        processTableAvailable: false,
      });
      expect(signals).toEqual([]);
      expect(await observer.observeProcessTree(deadline)).toBe(false);
    } finally {
      await stopRetainedTestGroup(anchor);
      forwardedController.abort();
      await observer.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects tool-registration data delivered after the adopted deadline",
    async () => {
      const fixture = await createManagedAgentFixture(
        () => "late-tool-registration",
      );
      fixtures.push(fixture);
      let monotonicTime = 0;
      const credentialFile = join(fixture.root, "late-control.json");
      const observer = new LocalManagedAgentProcessObserver({
        monotonicNow: () => monotonicTime,
        readProcessTable: () => new Promise(() => undefined),
      });
      observer.armToolProcessContainment();
      const forwardedController = new AbortController();
      const anchor = asChildProcess(
        observer.spawn({
          command: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            EXPORT_TOOL_CONTROL_SCRIPT,
            credentialFile,
          ],
          cwd: fixture.workspaceRoot,
          env: { ...process.env },
          signal: forwardedController.signal,
        }),
      );
      let socket: NetSocket | undefined;
      const deadline = Object.freeze({ startedAtMs: 0, deadlineAtMs: 10 });
      try {
        const credentials = await waitForToolControlCredentials(credentialFile);
        socket = createConnection(credentials.socketPath);
        socket.on("error", () => undefined);
        await once(socket, "connect");
        const closed = once(socket, "close").then(() => true);
        const observationTask = observer.waitForQuiescence(deadline);
        monotonicTime = 11;
        socket.write(
          `${JSON.stringify({
            capability: credentials.capability,
            role: "parent",
            pid: process.pid,
          })}\n`,
        );

        await expect(
          Promise.race([
            closed,
            new Promise<false>((resolveTimeout) =>
              setTimeout(() => resolveTimeout(false), 50),
            ),
          ]),
        ).resolves.toBe(true);
        await expect(observationTask).resolves.toMatchObject({
          quiescent: false,
          deadlineMet: false,
        });
      } finally {
        socket?.destroy();
        forwardedController.abort();
        await observer.dispose();
        await stopRetainedTestGroup(anchor);
      }
    },
  );
});
