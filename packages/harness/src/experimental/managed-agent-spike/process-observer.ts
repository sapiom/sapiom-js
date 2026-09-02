import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ManagedAgentCancellationReadiness,
  ManagedAgentProcessObserver,
  ManagedAgentTeardownDeadline,
  ManagedAgentTeardownObservation,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SAMPLE_INTERVAL_MS = 100;
const QUIESCENCE_POLL_MS = 25;
export const MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS = 200;
const MANAGED_AGENT_SUPERVISOR_PAYLOAD_ENV =
  "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";
export const MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV =
  "SAPIOM_MANAGED_AGENT_TOOL_CONTROL_SOCKET";
export const MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV =
  "SAPIOM_MANAGED_AGENT_TOOL_CONTROL_CAPABILITY";
const TOOL_REGISTRATION_MAX_BYTES = 1_024;
const DISPOSE_DRAIN_TIMEOUT_MS = 500;

/**
 * The POSIX supervisor is the observer-owned process-group leader. The real
 * SDK command runs inside its group, while the supervisor stays alive after
 * an inner-root exit whenever another group member survives. Its own bounded
 * `ps` helper remains in the group so abort and parent-disconnect cleanup
 * contain it too; the known helper PID is excluded only from the membership
 * decision that determines whether the anchor may exit.
 */
const MANAGED_AGENT_POSIX_SUPERVISOR_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const PAYLOAD_ENV = "SAPIOM_MANAGED_AGENT_SUPERVISOR_PAYLOAD";
const HELPER_TIMEOUT_MS = 200;
const POLL_INTERVAL_MS = 25;
const EMPTY_GROUP_EXIT_GRACE_MS = 750;
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;

function fail(message) {
  try { process.stderr.write(message + "\n"); } catch {}
  process.exit(1);
}

const encodedPayload = process.env[PAYLOAD_ENV];
delete process.env[PAYLOAD_ENV];
if (!encodedPayload) fail("managed-agent supervisor payload missing");

let payload;
try {
  payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
} catch {
  fail("managed-agent supervisor payload invalid");
}
if (
  !payload ||
  typeof payload.command !== "string" ||
  payload.command.length === 0 ||
  !Array.isArray(payload.args) ||
  !payload.args.every((argument) => typeof argument === "string")
) {
  fail("managed-agent supervisor command invalid");
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {});
}

function killOwnedGroup() {
  try {
    process.kill(0, "SIGKILL");
  } catch {
    process.exit(1);
  }
}

process.on("disconnect", killOwnedGroup);
// The host can close IPC after spawn() succeeds but before this module starts.
// Register first, then close the already-disconnected bootstrap window.
if (!process.connected) killOwnedGroup();

function readOtherGroupMembers() {
  return new Promise((resolveMembers) => {
    let helper;
    try {
      // Intentionally non-detached: the helper is synchronously contained by
      // the same group. Its known PID is excluded from this one snapshot.
      helper = spawn("/bin/ps", ["-axo", "pid=,pgid="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolveMembers(undefined);
      return;
    }
    const helperPid = helper.pid;
    let output = "";
    let settled = false;
    let overflowed = false;
    const finish = (members) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveMembers(members);
    };
    const timeout = setTimeout(() => {
      finish(undefined);
    }, HELPER_TIMEOUT_MS);
    helper.stdout.on("data", (chunk) => {
      if (overflowed) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_PROCESS_TABLE_BYTES) {
        overflowed = true;
        helper.stdout.destroy();
      }
    });
    helper.once("error", () => finish(undefined));
    helper.once("close", (code) => {
      if (code !== 0 || overflowed || typeof helperPid !== "number") {
        finish(undefined);
        return;
      }
      const records = new Map();
      for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) continue;
        records.set(Number(match[1]), Number(match[2]));
      }
      if (
        records.get(process.pid) !== process.pid ||
        records.get(helperPid) !== process.pid
      ) {
        finish(undefined);
        return;
      }
      finish(
        [...records.entries()]
          .filter(
            ([pid, processGroupId]) =>
              processGroupId === process.pid &&
              pid !== process.pid &&
              pid !== helperPid,
          )
          .map(([pid]) => pid),
      );
    });
  });
}

let innerClosed = false;
let innerExitCode = 1;
let membershipCheckRunning = false;
let emptyGroupObservedAt;
let pollTimer;

function scheduleMembershipCheck(delayMs = 0) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(checkMembership, delayMs);
}

async function checkMembership() {
  pollTimer = undefined;
  if (!innerClosed || membershipCheckRunning) return;
  membershipCheckRunning = true;
  const members = await readOtherGroupMembers();
  membershipCheckRunning = false;
  if (members && members.length === 0) {
    const now = performance.now();
    emptyGroupObservedAt ??= now;
    const remainingGrace =
      EMPTY_GROUP_EXIT_GRACE_MS - (now - emptyGroupObservedAt);
    if (remainingGrace > 0) {
      scheduleMembershipCheck(Math.min(POLL_INTERVAL_MS, remainingGrace));
      return;
    }
    process.stdin.unpipe();
    process.stdin.destroy();
    if (process.connected) {
      process.off("disconnect", killOwnedGroup);
      process.disconnect();
    }
    process.exitCode = innerExitCode;
    return;
  }
  emptyGroupObservedAt = undefined;
  scheduleMembershipCheck(POLL_INTERVAL_MS);
}

let inner;
try {
  inner = spawn(payload.command, payload.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
} catch {
  innerClosed = true;
  scheduleMembershipCheck();
}

if (inner) {
  process.stdin.on("error", () => {});
  inner.stdin.on("error", () => {});
  inner.stdout.on("error", () => {});
  inner.stderr.on("error", () => {});
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.stdin.pipe(inner.stdin);
  inner.stdout.pipe(process.stdout, { end: false });
  inner.stderr.pipe(process.stderr, { end: false });
  inner.once("error", () => {
    innerExitCode = 1;
  });
  inner.once("close", (code) => {
    innerClosed = true;
    innerExitCode = Number.isInteger(code) ? code : 1;
    scheduleMembershipCheck();
  });
}
`;

export interface ManagedAgentKernelProcessRecord {
  readonly parentPid: number;
  readonly processGroupId?: number;
  /** POSIX session id, when the process table exposes it. */
  readonly sessionId?: number;
  /** POSIX process state used to treat zombies as already dead. */
  readonly state?: string;
  /** Kernel-reported creation time used for evidence, never POSIX authority. */
  readonly startedAt: string;
}

export type ManagedAgentKernelProcessTable = ReadonlyMap<
  number,
  ManagedAgentKernelProcessRecord
>;

export type ManagedAgentProcessTableObservation =
  | {
      readonly available: true;
      readonly processes: ManagedAgentKernelProcessTable;
    }
  | { readonly available: false };

export type ManagedAgentProcessGroupLiveness = "alive" | "gone" | "unknown";
export type ManagedAgentTerminationRequestOutcome = "sent" | "gone" | "failure";

export interface ManagedAgentTerminationRequest {
  readonly target: "root" | "tool";
  /** Diagnostic identity only. The production request path never signals it. */
  readonly processGroupId: number;
}

export interface LocalManagedAgentProcessObserverOptions {
  readonly platform?: NodeJS.Platform;
  readonly readProcessTable?: () => Promise<ManagedAgentProcessTableObservation>;
  readonly processGroupLiveness?: (
    processGroupId: number,
  ) => ManagedAgentProcessGroupLiveness;
  /**
   * Deterministic unit-test seam. Production callers must leave this unset:
   * the default path requests termination only over retained process-bound
   * channels and never turns a sampled numeric PGID into signal authority.
   */
  readonly testOnlyRequestTermination?: (
    processGroupId: number,
    signal: "SIGKILL",
    target: ManagedAgentTerminationRequest["target"],
  ) => ManagedAgentTerminationRequestOutcome;
  /** Return an outcome to veto one request; return undefined to use the channel. */
  readonly testOnlyBeforeTerminationRequest?: (
    request: ManagedAgentTerminationRequest,
  ) => ManagedAgentTerminationRequestOutcome | undefined;
  /** Simulate one role's channel write; undefined uses the real retained socket. */
  readonly testOnlyWriteToolTermination?: (
    role: ToolProcessRole,
  ) => Exclude<ManagedAgentTerminationRequestOutcome, "gone"> | undefined;
  /** Read-only test telemetry emitted after a channel request is attempted. */
  readonly onTerminationRequest?: (
    request: ManagedAgentTerminationRequest,
    outcome: ManagedAgentTerminationRequestOutcome,
  ) => void;
  readonly monotonicNow?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

interface OwnedRoot {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  identity?: ManagedAgentKernelProcessRecord;
  containmentSupported: boolean;
  ownershipProven: boolean;
  forceKillIssued: boolean;
}

type ToolProcessRole = "parent" | "child";

interface ToolProcessRegistration {
  readonly role: ToolProcessRole;
  readonly pid: number;
  readonly socket: NetSocket;
  accepted: boolean;
  closed: boolean;
  identity?: ManagedAgentKernelProcessRecord;
}

interface ObservedIdentity {
  readonly rootPid: number;
  readonly record: ManagedAgentKernelProcessRecord;
}

interface PendingUnauthenticatedSubgroup {
  readonly key: string;
  readonly rootPid: number;
  readonly rootIdentity: ManagedAgentKernelProcessRecord;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly members: Map<
    string,
    { readonly pid: number; readonly record: ManagedAgentKernelProcessRecord }
  >;
}

interface ProcessSampleTask {
  readonly token: symbol;
  readonly generation: number;
  readonly lifecycleEpoch: number;
  readonly promise: Promise<boolean>;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sameProcess(
  left: ManagedAgentKernelProcessRecord | undefined,
  right: ManagedAgentKernelProcessRecord | undefined,
): boolean {
  return Boolean(left && right && left.startedAt === right.startedAt);
}

function processIsZombie(
  record: ManagedAgentKernelProcessRecord | undefined,
): boolean {
  return record?.state?.startsWith("Z") ?? false;
}

function sameCapability(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function windowsProcessTable(): Promise<ManagedAgentKernelProcessTable> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const parsed = JSON.parse(stdout) as
    | {
        ProcessId?: unknown;
        ParentProcessId?: unknown;
        CreationDate?: unknown;
      }
    | Array<{
        ProcessId?: unknown;
        ParentProcessId?: unknown;
        CreationDate?: unknown;
      }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(
    rows.flatMap((row) =>
      typeof row.ProcessId === "number" &&
      typeof row.ParentProcessId === "number" &&
      typeof row.CreationDate === "string"
        ? [
            [
              row.ProcessId,
              {
                parentPid: row.ParentProcessId,
                startedAt: row.CreationDate,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

export function managedAgentPosixSessionColumn(
  platform: NodeJS.Platform,
): "sess" | "sid" {
  return platform === "darwin" ? "sess" : "sid";
}

export function parseManagedAgentPosixProcessTable(
  stdout: string,
): ManagedAgentKernelProcessTable {
  const entries: Array<readonly [number, ManagedAgentKernelProcessRecord]> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(
      line,
    );
    if (!match) continue;
    entries.push([
      Number(match[1]),
      {
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        sessionId: Number(match[4]),
        state: match[5]!,
        startedAt: match[6]!,
      },
    ]);
  }
  return new Map(entries);
}

async function posixProcessTable(
  platform: NodeJS.Platform,
): Promise<ManagedAgentKernelProcessTable> {
  const sessionColumn = managedAgentPosixSessionColumn(platform);
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", `pid=,ppid=,pgid=,${sessionColumn}=,stat=,lstart=`],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  return parseManagedAgentPosixProcessTable(stdout);
}

async function defaultReadProcessTable(
  platform: NodeJS.Platform,
): Promise<ManagedAgentProcessTableObservation> {
  try {
    return {
      available: true,
      processes:
        platform === "win32"
          ? await windowsProcessTable()
          : await posixProcessTable(platform),
    };
  } catch {
    return { available: false };
  }
}

function defaultProcessGroupLiveness(
  processGroupId: number,
): ManagedAgentProcessGroupLiveness {
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

function childActive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function descendantsOf(
  roots: ReadonlySet<number>,
  table: ManagedAgentKernelProcessTable,
): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, record] of table) {
      if (
        !descendants.has(pid) &&
        (roots.has(record.parentPid) || descendants.has(record.parentPid))
      ) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

/**
 * E0.4 deliberately certifies one narrow containment model. The SDK command
 * runs in an observer-owned POSIX process group. The exact host-created L2
 * fixture parent and child additionally authenticate over separate private
 * Unix-socket connections outside the workspace and keep those connections
 * open for their complete lifetimes. A random capability, a primary exact-Bash
 * policy latch, stable role identities, and fresh kernel ancestry prove that
 * every member of their detached group remains below the active owned root.
 * A tool-reported or cached PID/PGID never grants signal authority by itself.
 *
 * This is not universal built-in Bash containment or a process-tree killer.
 * Windows, an unavailable process table, missing lifetime channels, or
 * identity/ancestry drift fail certification closed. The fallback freshly
 * validates the exact fixture group, asks a still-open authenticated member to
 * terminate its own current group, proves it absent with a new sample, then
 * asks the owned supervisor over retained IPC to terminate its own group.
 * POSIX `lstart` remains evidence only: a sampled numeric PID/PGID is never
 * host signal authority. Workspace PID-file contents never enter this class.
 */
export class LocalManagedAgentProcessObserver implements ManagedAgentProcessObserver {
  readonly #platform: NodeJS.Platform;
  readonly #readProcessTable: () => Promise<ManagedAgentProcessTableObservation>;
  readonly #processGroupLiveness: (
    processGroupId: number,
  ) => ManagedAgentProcessGroupLiveness;
  readonly #testOnlyRequestTermination:
    | ((
        processGroupId: number,
        signal: "SIGKILL",
        target: ManagedAgentTerminationRequest["target"],
      ) => ManagedAgentTerminationRequestOutcome)
    | undefined;
  readonly #testOnlyBeforeTerminationRequest:
    | ((
        request: ManagedAgentTerminationRequest,
      ) => ManagedAgentTerminationRequestOutcome | undefined)
    | undefined;
  readonly #testOnlyWriteToolTermination:
    | ((
        role: ToolProcessRole,
      ) => Exclude<ManagedAgentTerminationRequestOutcome, "gone"> | undefined)
    | undefined;
  readonly #onTerminationRequest:
    | ((
        request: ManagedAgentTerminationRequest,
        outcome: ManagedAgentTerminationRequestOutcome,
      ) => void)
    | undefined;
  readonly #monotonicNow: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #roots = new Map<number, OwnedRoot>();
  readonly #observedIdentities = new Map<number, ObservedIdentity>();
  // An unarmed SDK may create a short-lived subgroup below the owned root.
  // Track the subgroup identity and every member generation, not merely its
  // leader: leader exit/reparenting must never make a surviving member vanish.
  // These records only block readiness/root kill and never grant signal power.
  readonly #pendingUnauthenticatedSubgroups = new Map<
    string,
    PendingUnauthenticatedSubgroup
  >();
  readonly #observedPids = new Set<number>();
  readonly #sampler: NodeJS.Timeout;
  readonly #boundSignals = new WeakSet<AbortSignal>();
  readonly #toolControlCapability = randomBytes(32).toString("base64url");
  readonly #toolControlSockets = new Set<NetSocket>();
  #toolControlDirectory: string | undefined;
  #toolControlSocketPath: string | undefined;
  #toolControlServer: NetServer | undefined;
  #toolControlAvailable = false;
  #toolControlFailed = false;
  #toolProcessContainmentArmed = false;
  readonly #toolProcessRegistrations = new Map<
    ToolProcessRole,
    ToolProcessRegistration
  >();
  #toolProcessGroupId: number | undefined;
  #toolProcessRootPid: number | undefined;
  #toolProcessObservationComplete = false;
  #toolProcessObservationInvalid = false;
  #toolProcessForceKillIssued = false;
  #fallbackCleanupRequested = false;
  #lastTable: ManagedAgentKernelProcessTable | undefined;
  #processTableAvailable = false;
  #processTableNeedsRefresh = false;
  #sampleGeneration = 0;
  #lifecycleEpoch = 0;
  #sealed = false;
  #hostDisposing = false;
  #abortObserved = false;
  #teardownDeadline: ManagedAgentTeardownDeadline | undefined;
  #sampleTask: ProcessSampleTask | undefined;
  #disposeTask: Promise<void> | undefined;

  public constructor(options: LocalManagedAgentProcessObserverOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#readProcessTable =
      options.readProcessTable ??
      (() => defaultReadProcessTable(this.#platform));
    this.#processGroupLiveness =
      options.processGroupLiveness ?? defaultProcessGroupLiveness;
    this.#testOnlyRequestTermination = options.testOnlyRequestTermination;
    this.#testOnlyBeforeTerminationRequest =
      options.testOnlyBeforeTerminationRequest;
    this.#testOnlyWriteToolTermination = options.testOnlyWriteToolTermination;
    this.#onTerminationRequest = options.onTerminationRequest;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#delay = options.delay ?? defaultDelay;
    if (this.#platform === "darwin" || this.#platform === "linux") {
      this.#startToolControlServer();
    }
    this.#sampler = setInterval(
      () => void this.observeProcessTree(),
      SAMPLE_INTERVAL_MS,
    );
    this.#sampler.unref();
  }

  #adoptDeadline(
    deadline: ManagedAgentTeardownDeadline,
  ): ManagedAgentTeardownDeadline {
    if (
      !Number.isFinite(deadline.startedAtMs) ||
      !Number.isFinite(deadline.deadlineAtMs) ||
      deadline.deadlineAtMs < deadline.startedAtMs
    ) {
      throw new Error("managed-agent teardown deadline is invalid");
    }
    if (!this.#teardownDeadline) {
      this.#teardownDeadline = Object.freeze({ ...deadline });
    } else if (
      deadline.startedAtMs !== this.#teardownDeadline.startedAtMs ||
      deadline.deadlineAtMs !== this.#teardownDeadline.deadlineAtMs
    ) {
      // A later caller may not reset or extend the one teardown deadline.
      throw new Error("managed-agent teardown deadline changed after adoption");
    }
    return this.#teardownDeadline;
  }

  public beginTeardown(deadline: ManagedAgentTeardownDeadline): void {
    this.#adoptDeadline(deadline);
    if (this.#abortObserved) this.#requestFallbackCleanupSynchronously();
  }

  #remainingMs(deadline: ManagedAgentTeardownDeadline): number {
    return Math.max(0, deadline.deadlineAtMs - this.#monotonicNow());
  }

  #deadlineExpiredAndSeal(): boolean {
    if (
      !this.#teardownDeadline ||
      this.#monotonicNow() < this.#teardownDeadline.deadlineAtMs
    ) {
      return false;
    }
    this.#seal();
    return true;
  }

  #seal(): void {
    if (this.#sealed) return;
    this.#sealed = true;
    this.#lifecycleEpoch += 1;
    clearInterval(this.#sampler);
  }

  #startToolControlServer(): void {
    try {
      const directory = mkdtempSync(
        join(tmpdir(), "sapiom-managed-agent-control-"),
      );
      chmodSync(directory, 0o700);
      const socketPath = join(directory, "tool.sock");
      const server = createServer((socket) =>
        this.#receiveToolRegistration(socket),
      );
      this.#toolControlDirectory = directory;
      this.#toolControlSocketPath = socketPath;
      this.#toolControlServer = server;
      server.once("listening", () => {
        this.#toolControlAvailable = true;
      });
      server.on("error", () => {
        this.#toolControlAvailable = false;
        this.#toolControlFailed = true;
      });
      server.listen(socketPath);
      server.unref();
    } catch {
      this.#toolControlAvailable = false;
      this.#toolControlFailed = true;
    }
  }

  #receiveToolRegistration(socket: NetSocket): void {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) {
      socket.destroy();
      return;
    }
    const lifecycleEpoch = this.#lifecycleEpoch;
    this.#toolControlSockets.add(socket);
    socket.on("error", () => undefined);
    let registration: ToolProcessRegistration | undefined;
    socket.once("close", () => {
      this.#toolControlSockets.delete(socket);
      if (
        this.#sealed ||
        this.#deadlineExpiredAndSeal() ||
        this.#hostDisposing ||
        lifecycleEpoch !== this.#lifecycleEpoch
      ) {
        return;
      }
      if (!registration) return;
      const current = this.#toolProcessRegistrations.get(registration.role);
      if (current !== registration) return;
      if (this.#toolProcessObservationComplete) {
        registration.closed = true;
      } else {
        // A connection that disappears before readiness cannot reserve its
        // role. Clearing it transactionally permits the trusted process to
        // retry instead of leaving an unfinishable stale pending state.
        this.#toolProcessRegistrations.delete(registration.role);
      }
      void this.observeProcessTree();
    });
    let body = "";
    let handled = false;
    const reject = (): void => {
      handled = true;
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      if (
        handled ||
        this.#sealed ||
        this.#deadlineExpiredAndSeal() ||
        lifecycleEpoch !== this.#lifecycleEpoch
      ) {
        if (this.#sealed) socket.destroy();
        return;
      }
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > TOOL_REGISTRATION_MAX_BYTES) {
        reject();
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let payload: {
        capability?: unknown;
        pid?: unknown;
        role?: unknown;
      };
      try {
        payload = JSON.parse(body.slice(0, newline)) as typeof payload;
      } catch {
        socket.destroy();
        return;
      }
      if (
        !this.#toolProcessContainmentArmed ||
        this.#toolProcessObservationComplete ||
        typeof payload.capability !== "string" ||
        !sameCapability(payload.capability, this.#toolControlCapability) ||
        (payload.role !== "parent" && payload.role !== "child") ||
        this.#toolProcessRegistrations.has(payload.role) ||
        typeof payload.pid !== "number" ||
        !Number.isSafeInteger(payload.pid) ||
        payload.pid <= 1
      ) {
        socket.destroy();
        return;
      }
      registration = {
        role: payload.role,
        pid: payload.pid,
        socket,
        accepted: false,
        closed: false,
      };
      this.#toolProcessRegistrations.set(payload.role, registration);
      void this.observeProcessTree();
    });
  }

  #bindAbortSignal(signal: AbortSignal): void {
    if (this.#boundSignals.has(signal)) return;
    this.#boundSignals.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        this.#abortObserved = true;
        // The SDK may forward its private signal before runtime enters its
        // teardown path. Remember it, but never signal from an unbounded
        // window; beginTeardown() will synchronously replay the request.
        if (!this.#teardownDeadline) return;
        if (this.#sealed || this.#deadlineExpiredAndSeal()) return;
        this.#requestFallbackCleanupSynchronously();
      },
      { once: true },
    );
    if (signal.aborted) {
      this.#abortObserved = true;
      if (this.#teardownDeadline) this.#requestFallbackCleanupSynchronously();
    }
  }

  public armToolProcessContainment(): void {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) return;
    if (this.#toolProcessContainmentArmed) return;
    this.#toolProcessContainmentArmed = true;
    if (this.#toolControlFailed) {
      for (const root of this.#roots.values()) {
        this.#invalidateRootContainment(root);
      }
    }
  }

  /**
   * Simulates abrupt host loss without terminating the Vitest process. The
   * exact fixture must treat authenticated lifetime-channel loss as a
   * fail-closed instruction to terminate its own process group.
   */
  public testOnlyDropToolLifetimeChannels(): void {
    for (const socket of this.#toolControlSockets) socket.destroy();
  }

  #invalidateRootContainment(root: OwnedRoot): void {
    root.containmentSupported = false;
  }

  #invalidateToolContainment(): void {
    this.#toolProcessObservationInvalid = true;
  }

  #hasPendingUnauthenticatedDescendants(rootPid: number): boolean {
    return [...this.#pendingUnauthenticatedSubgroups.values()].some(
      (subgroup) => subgroup.rootPid === rootPid,
    );
  }

  #subgroupKey(
    rootPid: number,
    rootIdentity: ManagedAgentKernelProcessRecord,
    processGroupId: number,
    sessionId: number,
  ): string {
    return JSON.stringify([
      rootPid,
      rootIdentity.startedAt,
      rootIdentity.parentPid,
      rootIdentity.processGroupId,
      rootIdentity.sessionId,
      processGroupId,
      sessionId,
    ]);
  }

  #memberKey(pid: number, record: ManagedAgentKernelProcessRecord): string {
    return JSON.stringify([pid, record.startedAt]);
  }

  #sameIdentityAndTopology(
    expected: ManagedAgentKernelProcessRecord,
    current: ManagedAgentKernelProcessRecord | undefined,
  ): boolean {
    return (
      sameProcess(expected, current) &&
      expected.parentPid === current!.parentPid &&
      expected.processGroupId === current!.processGroupId &&
      expected.sessionId === current!.sessionId
    );
  }

  #expectedAfterAuthorizedGroupKill(
    root: OwnedRoot,
    observed: ManagedAgentKernelProcessRecord | undefined,
    current: ManagedAgentKernelProcessRecord | undefined,
    toolProcessGroupId: number | undefined,
  ): boolean {
    if (!sameProcess(observed, current)) return false;
    if (
      observed?.processGroupId === root.pid &&
      current?.processGroupId === root.pid
    ) {
      return root.forceKillIssued;
    }
    return (
      typeof toolProcessGroupId === "number" &&
      observed?.processGroupId === toolProcessGroupId &&
      current?.processGroupId === toolProcessGroupId &&
      this.#toolProcessForceKillIssued
    );
  }

  public spawn(options: SpawnOptions): SpawnedProcess {
    if (
      this.#sealed ||
      this.#hostDisposing ||
      this.#teardownDeadline ||
      this.#deadlineExpiredAndSeal()
    ) {
      throw new Error("managed-agent process observer is closed");
    }
    const usePosixSupervisor =
      this.#platform === "darwin" || this.#platform === "linux";
    const child = (
      usePosixSupervisor
        ? spawnChild(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              MANAGED_AGENT_POSIX_SUPERVISOR_SOURCE,
            ],
            {
              cwd: options.cwd,
              env: {
                ...options.env,
                [MANAGED_AGENT_SUPERVISOR_PAYLOAD_ENV]: Buffer.from(
                  JSON.stringify({
                    command: options.command,
                    args: options.args,
                  }),
                  "utf8",
                ).toString("base64url"),
                ...(this.#toolControlSocketPath
                  ? {
                      [MANAGED_AGENT_TOOL_CONTROL_SOCKET_ENV]:
                        this.#toolControlSocketPath,
                      [MANAGED_AGENT_TOOL_CONTROL_CAPABILITY_ENV]:
                        this.#toolControlCapability,
                    }
                  : {}),
              },
              detached: true,
              stdio: ["pipe", "pipe", "pipe", "ipc"],
              windowsHide: true,
            },
          )
        : spawnChild(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            detached: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
    ) as ChildProcessWithoutNullStreams;
    // SpawnedProcess does not expose stderr to the SDK transport. Drain it
    // here without retaining or printing content so a noisy inner command
    // cannot deadlock the supervisor on pipe backpressure.
    child.stderr.on("data", () => undefined);
    child.stderr.on("error", () => undefined);
    if (typeof child.pid === "number") {
      const pid = child.pid;
      this.#roots.set(pid, {
        pid,
        child,
        containmentSupported: true,
        ownershipProven: false,
        forceKillIssued: false,
      });
      this.#observedPids.add(pid);
      // The SDK's forwarded SpawnOptions.signal arrives only after its own
      // graceful close. Keep it as an idempotent fallback; runtime deliberately
      // does not bind the raw Options.abortController to host process signals.
      this.#bindAbortSignal(options.signal);
      void this.observeProcessTree();
    }
    return child;
  }

  async #boundedProcessTableRead(
    timeoutMs: number,
  ): Promise<ManagedAgentProcessTableObservation> {
    let timeout: NodeJS.Timeout | undefined;
    const read = Promise.resolve()
      .then(() => this.#readProcessTable())
      .catch(
        (): ManagedAgentProcessTableObservation => ({
          available: false,
        }),
      );
    try {
      return await Promise.race([
        read,
        new Promise<ManagedAgentProcessTableObservation>((resolveTimeout) => {
          timeout = setTimeout(
            () => resolveTimeout({ available: false }),
            Math.max(0, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #observeToolProcessContainment(table: ManagedAgentKernelProcessTable): void {
    if (!this.#toolProcessContainmentArmed) return;
    const parent = this.#toolProcessRegistrations.get("parent");
    const child = this.#toolProcessRegistrations.get("child");
    if (
      !this.#toolProcessObservationComplete &&
      parent &&
      child &&
      !parent.socket.destroyed &&
      !child.socket.destroyed
    ) {
      const parentIdentity = table.get(parent.pid);
      const childIdentity = table.get(child.pid);
      const processGroupId = parentIdentity?.processGroupId;
      const hostProcessGroupId = table.get(process.pid)?.processGroupId;
      const groupLeaderIdentity =
        typeof processGroupId === "number"
          ? table.get(processGroupId)
          : undefined;
      const root =
        this.#roots.size === 1 ? [...this.#roots.values()][0] : undefined;
      const rootDescendants = root
        ? descendantsOf(new Set([root.pid]), table)
        : new Set<number>();
      const groupMemberPids =
        typeof processGroupId === "number"
          ? [...table.entries()].flatMap(([pid, record]) =>
              record.processGroupId === processGroupId &&
              !processIsZombie(record)
                ? [pid]
                : [],
            )
          : [];
      if (
        root &&
        childActive(root.child) &&
        table.get(root.pid)?.processGroupId === root.pid &&
        !processIsZombie(table.get(root.pid)) &&
        parentIdentity &&
        !processIsZombie(parentIdentity) &&
        childIdentity &&
        !processIsZombie(childIdentity) &&
        typeof processGroupId === "number" &&
        typeof hostProcessGroupId === "number" &&
        processGroupId > 1 &&
        processGroupId !== hostProcessGroupId &&
        !this.#roots.has(processGroupId) &&
        parent.pid !== child.pid &&
        childIdentity.parentPid === parent.pid &&
        childIdentity.processGroupId === processGroupId &&
        groupLeaderIdentity?.processGroupId === processGroupId &&
        !processIsZombie(groupLeaderIdentity) &&
        groupMemberPids.length > 0 &&
        groupMemberPids.every((pid) => rootDescendants.has(pid))
      ) {
        parent.identity = parentIdentity;
        child.identity = childIdentity;
        this.#toolProcessGroupId = processGroupId;
        this.#toolProcessRootPid = root.pid;
        for (const registration of [parent, child]) {
          if (registration.accepted) continue;
          registration.accepted = true;
          registration.socket.write('{"registered":true}\n');
        }
      }
    }

    const processGroupId = this.#toolProcessGroupId;
    if (typeof processGroupId === "number") {
      for (const [pid, record] of table) {
        if (record.processGroupId === processGroupId) {
          this.#observedPids.add(pid);
        }
      }
    }
    if (!this.#toolProcessObservationComplete) return;
    for (const registration of this.#toolProcessRegistrations.values()) {
      const current = table.get(registration.pid);
      if (
        !registration.closed &&
        current &&
        !processIsZombie(current) &&
        !this.#toolProcessForceKillIssued &&
        (!sameProcess(registration.identity, current) ||
          current.processGroupId !== processGroupId)
      ) {
        this.#invalidateToolContainment();
      }
    }
  }

  #hasFreshToolAuthority(table: ManagedAgentKernelProcessTable): boolean {
    const rootPid = this.#toolProcessRootPid;
    const processGroupId = this.#toolProcessGroupId;
    const root =
      typeof rootPid === "number" ? this.#roots.get(rootPid) : undefined;
    const parent = this.#toolProcessRegistrations.get("parent");
    const child = this.#toolProcessRegistrations.get("child");
    if (
      !root ||
      !childActive(root.child) ||
      !root.containmentSupported ||
      this.#processTableNeedsRefresh ||
      this.#toolProcessObservationInvalid ||
      typeof processGroupId !== "number" ||
      !parent?.accepted ||
      !parent.identity ||
      !child?.accepted ||
      !child.identity ||
      ![parent, child].some(
        ({ closed, socket }) => !closed && !socket.destroyed,
      )
    ) {
      return false;
    }

    const currentRoot = table.get(root.pid);
    const currentParent = table.get(parent.pid);
    const currentChild = table.get(child.pid);
    if (
      !currentRoot ||
      processIsZombie(currentRoot) ||
      !currentParent ||
      processIsZombie(currentParent) ||
      !currentChild ||
      processIsZombie(currentChild) ||
      currentRoot.processGroupId !== root.pid ||
      (root.identity && !sameProcess(root.identity, currentRoot)) ||
      (root.identity && root.identity.sessionId !== currentRoot.sessionId) ||
      !sameProcess(parent.identity, currentParent) ||
      currentParent.processGroupId !== processGroupId ||
      parent.identity.sessionId !== currentParent.sessionId ||
      !sameProcess(child.identity, currentChild) ||
      currentChild.parentPid !== parent.pid ||
      currentChild.processGroupId !== processGroupId ||
      child.identity.sessionId !== currentChild.sessionId
    ) {
      return false;
    }

    const rootDescendants = descendantsOf(new Set([root.pid]), table);
    const allowedGroups = new Set([root.pid, processGroupId]);
    if (
      [...rootDescendants].some((pid) => {
        const record = table.get(pid);
        return !record || !allowedGroups.has(record.processGroupId ?? -1);
      })
    ) {
      return false;
    }
    const groupMembers = [...table.entries()].filter(
      ([, record]) =>
        record.processGroupId === processGroupId && !processIsZombie(record),
    );
    return (
      groupMembers.length > 0 &&
      groupMembers.every(([pid]) => rootDescendants.has(pid))
    );
  }

  #rememberPendingSubgroupMembers(
    subgroup: PendingUnauthenticatedSubgroup,
    root: OwnedRoot,
    table: ManagedAgentKernelProcessTable,
    rootDescendants: ReadonlySet<number>,
  ): void {
    for (const [pid, record] of table) {
      if (
        processIsZombie(record) ||
        record.processGroupId !== subgroup.processGroupId ||
        record.sessionId !== subgroup.sessionId
      ) {
        continue;
      }
      const key = this.#memberKey(pid, record);
      const existing = subgroup.members.get(key);
      if (!existing) subgroup.members.set(key, { pid, record });
      this.#observedPids.add(pid);
      if (!rootDescendants.has(pid)) {
        this.#invalidateRootContainment(root);
      }
      if (existing && !this.#sameIdentityAndTopology(existing.record, record)) {
        this.#invalidateRootContainment(root);
      }
    }
  }

  #observePendingUnauthenticatedSubgroups(
    root: OwnedRoot,
    table: ManagedAgentKernelProcessTable,
    rootDescendants: ReadonlySet<number>,
  ): Set<number> {
    const liveMemberPids = new Set<number>();
    for (const [key, subgroup] of this.#pendingUnauthenticatedSubgroups) {
      if (subgroup.rootPid !== root.pid) continue;
      const currentRoot = table.get(root.pid);
      if (!this.#sameIdentityAndTopology(subgroup.rootIdentity, currentRoot)) {
        // The root identity is part of the pending subgroup's immutable
        // provenance. Losing it while the subgroup is unresolved is sticky.
        this.#invalidateRootContainment(root);
      }
      this.#rememberPendingSubgroupMembers(
        subgroup,
        root,
        table,
        rootDescendants,
      );

      let rememberedMemberAlive = false;
      for (const member of subgroup.members.values()) {
        const current = table.get(member.pid);
        if (!sameProcess(member.record, current) || processIsZombie(current)) {
          continue;
        }
        rememberedMemberAlive = true;
        liveMemberPids.add(member.pid);
        if (
          !this.#sameIdentityAndTopology(member.record, current) ||
          !rootDescendants.has(member.pid)
        ) {
          this.#invalidateRootContainment(root);
        }
      }
      const currentGroupMembers = [...table.entries()].filter(
        ([, record]) =>
          !processIsZombie(record) &&
          record.processGroupId === subgroup.processGroupId &&
          record.sessionId === subgroup.sessionId,
      );
      for (const [pid] of currentGroupMembers) liveMemberPids.add(pid);
      if (!rememberedMemberAlive && currentGroupMembers.length === 0) {
        // Only a complete, authoritative sample with every remembered member
        // and every replacement group member absent can clear the blocker.
        this.#pendingUnauthenticatedSubgroups.delete(key);
      }
    }
    return liveMemberPids;
  }

  #registerPendingUnauthenticatedSubgroup(
    root: OwnedRoot,
    table: ManagedAgentKernelProcessTable,
    rootDescendants: ReadonlySet<number>,
    record: ManagedAgentKernelProcessRecord,
  ): void {
    const rootIdentity = table.get(root.pid);
    const processGroupId = record.processGroupId;
    const sessionId = record.sessionId;
    if (
      !rootIdentity ||
      processIsZombie(rootIdentity) ||
      typeof processGroupId !== "number" ||
      typeof sessionId !== "number"
    ) {
      this.#invalidateRootContainment(root);
      return;
    }
    const key = this.#subgroupKey(
      root.pid,
      rootIdentity,
      processGroupId,
      sessionId,
    );
    let subgroup = this.#pendingUnauthenticatedSubgroups.get(key);
    if (!subgroup) {
      subgroup = {
        key,
        rootPid: root.pid,
        rootIdentity,
        processGroupId,
        sessionId,
        members: new Map(),
      };
      this.#pendingUnauthenticatedSubgroups.set(key, subgroup);
    }
    this.#rememberPendingSubgroupMembers(
      subgroup,
      root,
      table,
      rootDescendants,
    );
  }

  #observePosixOwnedProcesses(table: ManagedAgentKernelProcessTable): void {
    for (const root of this.#roots.values()) {
      const rootDescendants = descendantsOf(new Set([root.pid]), table);
      const pendingMemberPids = this.#observePendingUnauthenticatedSubgroups(
        root,
        table,
        rootDescendants,
      );
      // Continue observing children below every pending member even if its
      // original leader exits between complete samples.
      const descendants = descendantsOf(
        new Set([root.pid, ...pendingMemberPids]),
        table,
      );
      const toolProcessGroupId =
        this.#toolProcessRootPid === root.pid
          ? this.#toolProcessGroupId
          : undefined;
      const allowedGroups = new Set<number>([root.pid]);
      if (typeof toolProcessGroupId === "number") {
        allowedGroups.add(toolProcessGroupId);
      }
      const validateAllowedGroups =
        !this.#toolProcessContainmentArmed ||
        typeof toolProcessGroupId === "number";
      const currentlyOwned = new Set<number>([root.pid, ...descendants]);

      for (const [pid, record] of table) {
        if (processIsZombie(record)) continue;
        if (
          record.processGroupId !== root.pid &&
          record.processGroupId !== toolProcessGroupId
        ) {
          continue;
        }
        currentlyOwned.add(pid);
        if (pid !== root.pid && !descendants.has(pid)) {
          const observed = this.#observedIdentities.get(pid);
          const expectedAfterAuthorizedKill =
            this.#expectedAfterAuthorizedGroupKill(
              root,
              observed?.record,
              record,
              toolProcessGroupId,
            );
          if (expectedAfterAuthorizedKill) continue;
          if (record.processGroupId === toolProcessGroupId) {
            this.#invalidateToolContainment();
          } else {
            this.#invalidateRootContainment(root);
          }
        }
      }

      for (const [pid, observed] of this.#observedIdentities) {
        if (observed.rootPid !== root.pid) continue;
        const current = table.get(pid);
        // A successful complete process-table sample with no matching stable
        // identity is positive evidence that the old process has exited. A
        // recycled numeric PID never inherits the old observation.
        // A kernel zombie is already dead and cannot execute, migrate, or
        // authorize a signal. Its transient reparenting during reap is not a
        // live containment escape.
        if (
          !sameProcess(observed.record, current) ||
          processIsZombie(current)
        ) {
          continue;
        }
        this.#observedPids.add(pid);
        if (
          current!.parentPid !== observed.record.parentPid ||
          current!.processGroupId !== observed.record.processGroupId ||
          current!.sessionId !== observed.record.sessionId ||
          (pid !== root.pid && !currentlyOwned.has(pid))
        ) {
          const belongsToToolGroup =
            typeof toolProcessGroupId === "number" &&
            (observed.record.processGroupId === toolProcessGroupId ||
              current!.processGroupId === toolProcessGroupId);
          const expectedAfterAuthorizedKill =
            this.#expectedAfterAuthorizedGroupKill(
              root,
              observed.record,
              current,
              toolProcessGroupId,
            );
          if (expectedAfterAuthorizedKill) {
            continue;
          }
          if (belongsToToolGroup) {
            this.#invalidateToolContainment();
          } else {
            this.#invalidateRootContainment(root);
          }
        }
      }

      for (const pid of currentlyOwned) {
        const current = table.get(pid);
        if (!current || processIsZombie(current)) continue;
        const isDescendant = descendants.has(pid);
        const escapedOwnedAncestry = pid !== root.pid && !isDescendant;
        const unauthenticatedDescendant =
          validateAllowedGroups &&
          isDescendant &&
          !allowedGroups.has(current.processGroupId ?? -1);
        if (escapedOwnedAncestry || unauthenticatedDescendant) {
          const observed = this.#observedIdentities.get(pid);
          const belongsToToolGroup =
            typeof toolProcessGroupId === "number" &&
            (current.processGroupId === toolProcessGroupId ||
              observed?.record.processGroupId === toolProcessGroupId);
          if (
            unauthenticatedDescendant &&
            !this.#toolProcessContainmentArmed &&
            (!observed || sameProcess(observed.record, current))
          ) {
            this.#registerPendingUnauthenticatedSubgroup(
              root,
              table,
              rootDescendants,
              current,
            );
          } else {
            const expectedAfterAuthorizedKill =
              this.#expectedAfterAuthorizedGroupKill(
                root,
                observed?.record,
                current,
                toolProcessGroupId,
              );
            if (expectedAfterAuthorizedKill) continue;
            if (belongsToToolGroup) {
              this.#invalidateToolContainment();
            } else {
              this.#invalidateRootContainment(root);
            }
          }
        }
        const observed = this.#observedIdentities.get(pid);
        if (!observed || !sameProcess(observed.record, current)) {
          this.#observedIdentities.set(pid, {
            rootPid: root.pid,
            record: current,
          });
        }
        this.#observedPids.add(pid);
      }
    }
  }

  public async observeProcessTree(
    deadline?: ManagedAgentTeardownDeadline,
  ): Promise<boolean> {
    const activeDeadline = deadline
      ? this.#adoptDeadline(deadline)
      : this.#teardownDeadline;
    if (this.#sealed) return false;
    if (activeDeadline && this.#remainingMs(activeDeadline) <= 0) {
      this.#seal();
      return false;
    }
    if (this.#roots.size === 0 && !this.#toolProcessContainmentArmed) {
      this.#lastTable = new Map();
      this.#processTableAvailable = true;
      return true;
    }
    const boundedTimeoutMs = Math.max(
      0,
      Math.min(
        MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
        activeDeadline
          ? this.#remainingMs(activeDeadline)
          : MANAGED_AGENT_PROCESS_HELPER_TIMEOUT_MS,
      ),
    );
    const generation = this.#sampleGeneration;
    const lifecycleEpoch = this.#lifecycleEpoch;
    const reusableSample =
      this.#sampleTask?.generation === generation &&
      this.#sampleTask.lifecycleEpoch === lifecycleEpoch
        ? this.#sampleTask
        : undefined;
    if (!reusableSample) {
      const sampleToken = Symbol("managed-agent-process-sample");
      const promise = (async () => {
        const observation =
          await this.#boundedProcessTableRead(boundedTimeoutMs);
        // A deadline can be adopted while a background sample is already in
        // flight. Consult the current observer deadline at completion so that
        // such a sample cannot install evidence after the newly adopted bound.
        const completionDeadline = this.#teardownDeadline ?? activeDeadline;
        const completedBeforeDeadline = completionDeadline
          ? this.#monotonicNow() < completionDeadline.deadlineAtMs
          : true;
        if (
          this.#sealed ||
          lifecycleEpoch !== this.#lifecycleEpoch ||
          generation !== this.#sampleGeneration ||
          !completedBeforeDeadline
        ) {
          if (!completedBeforeDeadline) this.#seal();
          return false;
        }
        if (!observation.available) {
          if (
            boundedTimeoutMs > 0 ||
            this.#processTableNeedsRefresh ||
            !this.#processTableAvailable
          ) {
            this.#lastTable = undefined;
            this.#processTableAvailable = false;
          }
          return false;
        }

        const table = observation.processes;
        this.#lastTable = table;
        this.#processTableAvailable = true;
        this.#processTableNeedsRefresh = false;
        for (const root of this.#roots.values()) {
          if (this.#platform !== "win32") {
            const currentRoot = table.get(root.pid);
            if (
              currentRoot &&
              !processIsZombie(currentRoot) &&
              childActive(root.child) &&
              !root.forceKillIssued &&
              currentRoot.processGroupId !== root.pid
            ) {
              this.#invalidateRootContainment(root);
            }
            continue;
          }

          const currentRoot = table.get(root.pid);
          const seeds = new Set<number>();
          if (currentRoot && childActive(root.child)) {
            seeds.add(root.pid);
            this.#observedIdentities.set(root.pid, {
              rootPid: root.pid,
              record: currentRoot,
            });
            this.#observedPids.add(root.pid);
          }
          for (const [pid, observed] of this.#observedIdentities) {
            if (
              observed.rootPid === root.pid &&
              sameProcess(observed.record, table.get(pid))
            ) {
              seeds.add(pid);
            }
          }
          for (const pid of descendantsOf(seeds, table)) {
            const current = table.get(pid);
            if (!current) continue;
            this.#observedIdentities.set(pid, {
              rootPid: root.pid,
              record: current,
            });
            this.#observedPids.add(pid);
          }
        }
        this.#observeToolProcessContainment(table);
        if (this.#platform !== "win32") {
          this.#observePosixOwnedProcesses(table);
        }
        // Query.return() can remain pending while the SDK performs its own
        // shutdown. Advance a requested fallback from each authoritative
        // sample so the detached tool group is killed and then confirmed gone
        // before the supervisor anchor is killed last, all within the same
        // deadline.
        this.#advanceFallbackCleanup();
        return true;
      })().finally(() => {
        if (this.#sampleTask?.token === sampleToken) {
          this.#sampleTask = undefined;
        }
      });
      const sampleState: ProcessSampleTask = {
        token: sampleToken,
        generation,
        lifecycleEpoch,
        promise,
      };
      this.#sampleTask = sampleState;
    }

    const sample = (reusableSample ?? this.#sampleTask)!.promise;
    let timeout: NodeJS.Timeout | undefined;
    const available = await Promise.race([
      sample,
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), boundedTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!available && !this.#sealed) {
      // A caller with a shorter absolute deadline must not reuse a stale table
      // while a longer background sample is still pending.
      if (
        boundedTimeoutMs > 0 ||
        this.#processTableNeedsRefresh ||
        !this.#processTableAvailable
      ) {
        this.#lastTable = undefined;
        this.#processTableAvailable = false;
      } else {
        return true;
      }
    }
    return available;
  }

  public async prepareCancellation(): Promise<ManagedAgentCancellationReadiness> {
    const observedPids = (): number[] =>
      [...this.#observedPids].sort((left, right) => left - right);
    const unsupported = (
      reason: Exclude<ManagedAgentCancellationReadiness["reason"], "ready">,
    ): ManagedAgentCancellationReadiness => ({
      supported: false,
      reason,
      processTableAvailable: this.#processTableAvailable,
      containmentSupported:
        [...this.#roots.values()].every(
          ({ pid, containmentSupported }) =>
            containmentSupported &&
            !this.#hasPendingUnauthenticatedDescendants(pid),
        ) &&
        (!this.#toolProcessContainmentArmed ||
          (this.#toolProcessRegistrations.size === 2 &&
            !this.#toolProcessObservationInvalid)),
      ownershipProven: false,
      observedPids: observedPids(),
    });

    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      for (const root of this.#roots.values()) {
        this.#invalidateRootContainment(root);
      }
      return unsupported("platform_unsupported");
    }
    if (!(await this.observeProcessTree())) {
      return unsupported("process_table_unavailable");
    }
    if (this.#roots.size !== 1) return unsupported("root_count_invalid");
    const root = [...this.#roots.values()][0]!;
    if (!root.containmentSupported) {
      return unsupported("containment_escaped");
    }
    if (this.#hasPendingUnauthenticatedDescendants(root.pid)) {
      return unsupported("containment_escaped");
    }
    if (!childActive(root.child)) {
      return unsupported("root_not_active");
    }
    const currentRoot = this.#lastTable!.get(root.pid);
    if (!currentRoot || currentRoot.processGroupId !== root.pid) {
      this.#invalidateRootContainment(root);
      return unsupported("root_not_group_leader");
    }
    if (processIsZombie(currentRoot)) {
      return unsupported("root_not_active");
    }
    root.identity = currentRoot;
    if (this.#toolProcessContainmentArmed) {
      const parent = this.#toolProcessRegistrations.get("parent");
      const child = this.#toolProcessRegistrations.get("child");
      if (
        !this.#toolControlAvailable ||
        !parent?.accepted ||
        parent.closed ||
        parent.socket.destroyed ||
        !child?.accepted ||
        child.closed ||
        child.socket.destroyed ||
        typeof this.#toolProcessGroupId !== "number"
      ) {
        return unsupported("tool_process_not_registered");
      }
      if (this.#toolProcessObservationInvalid) {
        return unsupported("tool_process_identity_invalid");
      }
      if (!this.#hasFreshToolAuthority(this.#lastTable!)) {
        return unsupported("tool_process_identity_invalid");
      }
      this.#toolProcessObservationComplete = true;
    }

    root.ownershipProven = true;
    return {
      supported: true,
      reason: "ready",
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: true,
      observedPids: observedPids(),
    };
  }

  #hasFreshRootGroupAuthority(root: OwnedRoot): boolean {
    if (!root.containmentSupported || this.#processTableNeedsRefresh) {
      return false;
    }
    // The observer-created group alone is not signal authority. A missing
    // helper sample must fail closed because a cached numeric PGID can outlive
    // its original leader and be reused before the ChildProcess exit event is
    // delivered.
    if (!this.#processTableAvailable) return false;
    const current = this.#lastTable?.get(root.pid);
    const baseline =
      root.identity ?? this.#observedIdentities.get(root.pid)?.record;
    if (
      !current ||
      processIsZombie(current) ||
      current.processGroupId !== root.pid
    ) {
      return false;
    }
    return baseline
      ? sameProcess(baseline, current) &&
          current.parentPid === baseline.parentPid &&
          current.sessionId === baseline.sessionId
      : true;
  }

  #recordTerminationRequest(
    request: ManagedAgentTerminationRequest,
    outcome: ManagedAgentTerminationRequestOutcome,
  ): ManagedAgentTerminationRequestOutcome {
    this.#onTerminationRequest?.(request, outcome);
    return outcome;
  }

  #requestToolGroupTermination(
    processGroupId: number,
  ): ManagedAgentTerminationRequestOutcome {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) return "failure";
    const request = { target: "tool", processGroupId } as const;
    const vetoedOutcome = this.#testOnlyBeforeTerminationRequest?.(request);
    if (vetoedOutcome) {
      return this.#recordTerminationRequest(request, vetoedOutcome);
    }
    if (this.#testOnlyRequestTermination) {
      return this.#recordTerminationRequest(
        request,
        this.#testOnlyRequestTermination(
          request.processGroupId,
          "SIGKILL",
          request.target,
        ),
      );
    }
    const registrations = (["parent", "child"] as const)
      .map((role) => this.#toolProcessRegistrations.get(role))
      .filter(
        (candidate): candidate is ToolProcessRegistration =>
          candidate !== undefined &&
          candidate.accepted &&
          !candidate.closed &&
          !candidate.socket.destroyed &&
          candidate.socket.writable,
      );
    if (registrations.length === 0) {
      return this.#recordTerminationRequest(request, "failure");
    }
    let sent = false;
    for (const registration of registrations) {
      const simulatedOutcome = this.#testOnlyWriteToolTermination?.(
        registration.role,
      );
      if (simulatedOutcome) {
        sent ||= simulatedOutcome === "sent";
        continue;
      }
      try {
        // This retained socket is bound to the authenticated process instance,
        // not its numeric PID. The receiver calls kill(0, SIGKILL), so the
        // still-running member terminates its own current group without a host
        // snapshot-to-signal PGID reuse window. Broadcast to every live role:
        // a stale peer cannot prevent its surviving group-mate from receiving
        // the same idempotent self-group termination request.
        registration.socket.write('{"forceKill":true}\n');
        sent = true;
      } catch {
        // Try every independently authenticated channel before failing closed.
      }
    }
    return this.#recordTerminationRequest(request, sent ? "sent" : "failure");
  }

  #requestRootGroupTermination(
    root: OwnedRoot,
  ): ManagedAgentTerminationRequestOutcome {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) return "failure";
    const request = { target: "root", processGroupId: root.pid } as const;
    const vetoedOutcome = this.#testOnlyBeforeTerminationRequest?.(request);
    if (vetoedOutcome) {
      return this.#recordTerminationRequest(request, vetoedOutcome);
    }
    if (this.#testOnlyRequestTermination) {
      return this.#recordTerminationRequest(
        request,
        this.#testOnlyRequestTermination(
          request.processGroupId,
          "SIGKILL",
          request.target,
        ),
      );
    }
    if (!childActive(root.child)) {
      return this.#recordTerminationRequest(request, "gone");
    }
    if (!root.child.connected) {
      return this.#recordTerminationRequest(request, "failure");
    }
    try {
      // The IPC endpoint belongs to the retained supervisor process instance.
      // Its disconnect handler terminates its own current group. PID reuse can
      // therefore make this request fail, but can never redirect it.
      root.child.disconnect();
      return this.#recordTerminationRequest(request, "sent");
    } catch {
      return this.#recordTerminationRequest(request, "failure");
    }
  }

  #invalidateSampleAfterTerminationRequest(): void {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) return;
    // Every request invalidates every sample that started before it, including
    // channel failures. Only a complete read started in this new generation
    // may prove the target gone or authorize the next teardown step.
    this.#sampleGeneration += 1;
    this.#processTableNeedsRefresh = true;
  }

  #requestOwnedRootTerminationSynchronously(): void {
    if (this.#sealed) return;
    if (this.#platform !== "darwin" && this.#platform !== "linux") return;
    for (const root of this.#roots.values()) {
      if (
        root.forceKillIssued ||
        !childActive(root.child) ||
        this.#hasPendingUnauthenticatedDescendants(root.pid) ||
        !this.#hasFreshRootGroupAuthority(root)
      ) {
        continue;
      }
      const requestOutcome = this.#requestRootGroupTermination(root);
      this.#invalidateSampleAfterTerminationRequest();
      root.forceKillIssued = requestOutcome === "sent";
    }
  }

  #requestFallbackCleanupSynchronously(): void {
    if (this.#sealed || this.#deadlineExpiredAndSeal()) return;
    if (!this.#fallbackCleanupRequested) {
      this.#fallbackCleanupRequested = true;
      // The cleanup request itself is a lifecycle boundary. Discard any
      // earlier sample so the first process-bound termination request can only
      // follow a complete process-table read begun after teardown started.
      this.#sampleGeneration += 1;
      this.#processTableNeedsRefresh = true;
    }
    void this.observeProcessTree(this.#teardownDeadline);
  }

  #advanceFallbackCleanup(): void {
    if (
      this.#sealed ||
      this.#deadlineExpiredAndSeal() ||
      !this.#fallbackCleanupRequested ||
      this.#platform === "win32" ||
      !this.#processTableAvailable
    ) {
      return;
    }
    if (!this.#toolProcessContainmentArmed) {
      this.#requestOwnedRootTerminationSynchronously();
      return;
    }
    // Once tool containment is armed, fail closed until the authenticated
    // parent/child identities and their separate group are complete. Killing
    // only the supervisor group could otherwise strand an unknown tool group.
    if (!this.#toolProcessObservationComplete) return;

    const processGroupId = this.#toolProcessGroupId;
    if (typeof processGroupId !== "number") return;
    const table = this.#lastTable!;
    const liveToolGroupMembers = [...table.values()].some(
      (record) =>
        record.processGroupId === processGroupId && !processIsZombie(record),
    );
    if (liveToolGroupMembers && this.#toolProcessForceKillIssued) return;
    const groupLiveness = this.#processGroupLiveness(processGroupId);
    if (groupLiveness === "gone") {
      this.#requestOwnedRootTerminationSynchronously();
      return;
    }
    if (groupLiveness !== "alive") return;

    if (!this.#hasFreshToolAuthority(table)) {
      return;
    }
    if (!this.#toolProcessForceKillIssued) {
      const requestOutcome = this.#requestToolGroupTermination(processGroupId);
      this.#invalidateSampleAfterTerminationRequest();
      this.#toolProcessForceKillIssued = requestOutcome === "sent";
      if (requestOutcome === "gone") {
        this.#requestOwnedRootTerminationSynchronously();
      }
    }
  }

  #currentObservation(
    startedAt: number,
    emergencyCleanupAttempted: boolean,
  ): ManagedAgentTeardownObservation {
    const roots = [...this.#roots.values()];
    const alive = new Set<number>();
    for (const root of roots) {
      const sampledRoot = this.#lastTable?.get(root.pid);
      if (
        childActive(root.child) &&
        (!this.#processTableAvailable ||
          (sampledRoot && !processIsZombie(sampledRoot)))
      ) {
        alive.add(root.pid);
      }
      if (!this.#processTableAvailable) continue;
      const table = this.#lastTable!;
      if (this.#platform !== "win32") {
        const liveRootGroupPids = [...table.entries()].flatMap(
          ([pid, record]) =>
            record.processGroupId === root.pid && !processIsZombie(record)
              ? [pid]
              : [],
        );
        for (const pid of liveRootGroupPids) alive.add(pid);
        const groupLiveness =
          liveRootGroupPids.length > 0
            ? this.#processGroupLiveness(root.pid)
            : "gone";
        if (groupLiveness === "alive") alive.add(root.pid);
        if (groupLiveness === "unknown") {
          this.#invalidateRootContainment(root);
        }
      } else {
        for (const [pid, observed] of this.#observedIdentities) {
          if (
            observed.rootPid === root.pid &&
            sameProcess(observed.record, table.get(pid))
          ) {
            alive.add(pid);
          }
        }
      }
    }
    const toolRegistrations = [...this.#toolProcessRegistrations.values()];
    const toolProcessGroupId = this.#toolProcessGroupId;
    for (const registration of toolRegistrations) {
      if (!registration.closed && !registration.socket.destroyed) {
        alive.add(registration.pid);
      }
    }
    if (this.#processTableAvailable) {
      const table = this.#lastTable!;
      if (this.#platform !== "win32") {
        for (const [pid, observed] of this.#observedIdentities) {
          const current = table.get(pid);
          if (
            !sameProcess(observed.record, current) ||
            processIsZombie(current)
          ) {
            continue;
          }
          alive.add(pid);
          if (
            typeof current!.processGroupId === "number" &&
            (current!.parentPid !== observed.record.parentPid ||
              current!.processGroupId !== observed.record.processGroupId ||
              current!.sessionId !== observed.record.sessionId)
          ) {
            alive.add(current!.processGroupId);
          }
        }
      }
      if (typeof toolProcessGroupId === "number") {
        const liveToolGroupPids = [...table.entries()].flatMap(
          ([pid, record]) =>
            record.processGroupId === toolProcessGroupId &&
            !processIsZombie(record)
              ? [pid]
              : [],
        );
        for (const pid of liveToolGroupPids) alive.add(pid);
        const groupLiveness =
          liveToolGroupPids.length > 0
            ? this.#processGroupLiveness(toolProcessGroupId)
            : "gone";
        if (groupLiveness === "alive") alive.add(toolProcessGroupId);
        if (groupLiveness === "unknown") {
          this.#invalidateToolContainment();
        }
      }
      for (const registration of toolRegistrations) {
        const current = table.get(registration.pid);
        if (current && !processIsZombie(current)) {
          alive.add(registration.pid);
        }
      }
    }

    const processTableAvailable =
      roots.length === 0 || this.#processTableAvailable;
    const toolProcessObservationComplete =
      !this.#toolProcessContainmentArmed ||
      this.#toolProcessObservationComplete;
    const toolProcessChannelsClosed =
      !this.#toolProcessContainmentArmed ||
      (this.#toolProcessObservationComplete &&
        toolRegistrations.length === 2 &&
        toolRegistrations.every(
          ({ closed, socket }) => closed || socket.destroyed,
        ));
    const containmentSupported =
      roots.every(({ containmentSupported: supported }) => supported) &&
      roots.every(
        ({ pid }) => !this.#hasPendingUnauthenticatedDescendants(pid),
      ) &&
      (!this.#toolProcessContainmentArmed ||
        (this.#toolControlAvailable &&
          this.#toolProcessObservationComplete &&
          !this.#toolProcessObservationInvalid));
    const ownershipProven =
      roots.length > 0 &&
      roots.every(({ ownershipProven }) => ownershipProven) &&
      toolProcessObservationComplete;
    const forceKillIssued =
      roots.length > 0 && roots.every(({ forceKillIssued }) => forceKillIssued);
    const elapsedMs = Math.max(0, this.#monotonicNow() - startedAt);
    const quiescent =
      processTableAvailable &&
      containmentSupported &&
      toolProcessChannelsClosed &&
      alive.size === 0;
    return {
      quiescent,
      deadlineMet: quiescent,
      processTableAvailable,
      containmentSupported,
      ownershipProven,
      forceKillIssued,
      toolProcessObservationComplete,
      toolProcessChannelsClosed,
      elapsedMs,
      observedPids: [...this.#observedPids].sort((left, right) => left - right),
      alivePidsAtDeadline: [...alive].sort((left, right) => left - right),
      emergencyCleanupAttempted,
    };
  }

  public async waitForQuiescence(
    deadline: ManagedAgentTeardownDeadline,
  ): Promise<ManagedAgentTeardownObservation> {
    const adoptedDeadline = this.#adoptDeadline(deadline);
    const startedAt = adoptedDeadline.startedAtMs;
    const boundedTimeoutMs = Math.max(
      0,
      adoptedDeadline.deadlineAtMs - adoptedDeadline.startedAtMs,
    );
    for (;;) {
      if (this.#remainingMs(adoptedDeadline) <= 0 || this.#sealed) {
        const observation = this.#currentObservation(startedAt, false);
        this.#seal();
        return { ...observation, deadlineMet: false };
      }
      await this.observeProcessTree(adoptedDeadline);
      const observation = this.#currentObservation(startedAt, false);
      if (observation.quiescent) {
        const deadlineMet =
          this.#monotonicNow() <= adoptedDeadline.deadlineAtMs;
        // Seal atomically with the successful observation so no delayed SDK
        // spawn can appear after quiescence has been certified.
        this.#seal();
        return {
          ...observation,
          deadlineMet,
        };
      }
      if (
        observation.elapsedMs >= boundedTimeoutMs ||
        this.#remainingMs(adoptedDeadline) <= 0
      ) {
        this.#seal();
        return { ...observation, deadlineMet: false };
      }
      await this.#delay(
        Math.min(QUIESCENCE_POLL_MS, this.#remainingMs(adoptedDeadline)),
      );
    }
  }

  public async emergencyCleanup(
    deadline: ManagedAgentTeardownDeadline,
  ): Promise<ManagedAgentTeardownObservation> {
    const adoptedDeadline = this.#adoptDeadline(deadline);
    const startedAt = adoptedDeadline.startedAtMs;
    this.#requestFallbackCleanupSynchronously();
    const confirmation = await this.waitForQuiescence(adoptedDeadline);
    const elapsedMs = Math.max(0, this.#monotonicNow() - startedAt);
    const roots = [...this.#roots.values()];
    const forceKillIssued =
      roots.length > 0 && roots.every((root) => root.forceKillIssued);
    return {
      ...confirmation,
      forceKillIssued,
      elapsedMs,
      deadlineMet:
        confirmation.quiescent &&
        this.#monotonicNow() <= adoptedDeadline.deadlineAtMs,
      emergencyCleanupAttempted: true,
    };
  }

  public dispose(): Promise<void> {
    this.#disposeTask ??= this.#disposeInternal();
    return this.#disposeTask;
  }

  async #disposeInternal(): Promise<void> {
    this.#hostDisposing = true;
    this.#seal();

    // The two exact fixture processes authenticated these retained channels
    // with an observer-created capability that was never written into the
    // workspace. Ask them to exit cooperatively and require an acknowledgement;
    // workspace PID-file contents are diagnostic only and never signal input.
    const acknowledgementTasks = [
      ...this.#toolProcessRegistrations.values(),
    ].flatMap((registration) => {
      const socket = registration.socket;
      if (socket.destroyed || registration.closed) return [];
      return [
        new Promise<boolean>((resolveAcknowledgement) => {
          let settled = false;
          let body = "";
          const finish = (acknowledged: boolean): void => {
            if (settled) return;
            settled = true;
            socket.off("data", onData);
            socket.off("close", onClose);
            resolveAcknowledgement(acknowledged);
          };
          const onData = (chunk: Buffer | string): void => {
            body += chunk.toString();
            if (body.includes('"shutdownAck":true')) finish(true);
          };
          const onClose = (): void => finish(false);
          socket.on("data", onData);
          socket.once("close", onClose);
          try {
            socket.write('{"shutdown":true}\n');
          } catch {
            finish(false);
          }
        }),
      ];
    });
    if (acknowledgementTasks.length > 0) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(acknowledgementTasks),
        new Promise<void>((resolveTimeout) => {
          timeout = setTimeout(resolveTimeout, DISPOSE_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }

    // Closing the retained IPC handle lets the supervisor kill its own exact
    // process group without the test harness supplying any numeric PID/PGID.
    const rootExitTasks = [...this.#roots.values()].flatMap(({ child }) => {
      if (!childActive(child)) return [];
      if (child.connected) child.disconnect();
      return [
        new Promise<void>((resolveExit) => {
          if (!childActive(child)) {
            resolveExit();
            return;
          }
          child.once("close", () => resolveExit());
        }),
      ];
    });
    if (rootExitTasks.length > 0) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(rootExitTasks),
        new Promise<void>((resolveTimeout) => {
          timeout = setTimeout(resolveTimeout, DISPOSE_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }

    for (const socket of this.#toolControlSockets) socket.destroy();
    this.#toolControlSockets.clear();
    const serverClose = new Promise<void>((resolveClose) => {
      const server = this.#toolControlServer;
      if (!server?.listening) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
    });
    let serverCloseTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      serverClose,
      new Promise<void>((resolveTimeout) => {
        serverCloseTimeout = setTimeout(
          resolveTimeout,
          DISPOSE_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
    if (serverCloseTimeout) clearTimeout(serverCloseTimeout);
    if (this.#toolControlDirectory) {
      try {
        rmSync(this.#toolControlDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort removal after the private listener and clients close.
      }
    }
  }
}

export function createLocalManagedAgentProcessObserver(
  options: LocalManagedAgentProcessObserverOptions = {},
): ManagedAgentProcessObserver {
  return new LocalManagedAgentProcessObserver(options);
}
