/**
 * TaskManager — registry of headless one-shot agent runs (BackgroundTask in
 * shared/types.ts). A "background" macro (ai-visualize today; deploy/run
 * candidates later) runs here instead of being injected into the user's
 * interactive session, so a long LLM turn can't hijack their thread.
 *
 * Deliberately NOT SessionManager:
 * - Tasks are spawned via plain child_process (no pty): `claude -p` is
 *   non-interactive by design — stdout is a machine-readable event stream to
 *   parse, not a TUI to render, and a non-TTY stdout also guarantees the
 *   trust dialog is skipped (see the adapter's launchTask contract).
 * - Records live only in memory and never in the session registry, so a task
 *   can't appear as a session tab or strand a ghost record: the process
 *   exits on its own when its single turn completes, and `exit` is the one
 *   lifecycle signal — no readiness gating, no liveness sweep.
 * - The task's generated config dir (keyed by task id, exactly like a
 *   session's) is deleted via `onCleanup` when it exits; a crash leaves it
 *   to the same boot-time retention sweep real sessions use.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  ENV,
  type BackgroundTask,
  type HarnessAdapter,
  type HarnessKind,
  type LaunchOpts,
} from "../shared/types.js";
import type { LaunchOptsBuilder } from "./session-manager.js";
import { parseTaskStreamLine } from "./task-stream.js";

/** Rolling status-line window kept per task — enough for the activity view's
 *  recent-history list without unbounded growth on a chatty run. */
const MAX_STATUS_LINES = 24;
/** Rolling stderr tail kept for failure display. */
const MAX_STDERR_CHARS = 2_000;
/** Finished tasks retained (per whole manager) for late-mounting clients;
 *  running tasks are always retained regardless. */
const MAX_FINISHED_TASKS = 20;

/**
 * The slice of node's ChildProcess a task actually uses — injectable so
 * tests drive fake processes without spawning anything real.
 */
export interface TaskProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type TaskSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => TaskProcess;

const defaultSpawn: TaskSpawnFn = (command, args, options) =>
  spawnChildProcess(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });

/** Thrown when the session's harness adapter has no `launchTask` (codex,
 *  today) — the macros router surfaces this as a 400 with this message. */
export class TaskNotSupportedError extends Error {
  constructor(harness: HarnessKind, label: string) {
    super(`${label} runs as a background task, which "${harness}" sessions don't support yet — use a Claude Code session.`);
    this.name = "TaskNotSupportedError";
  }
}

/** Thrown when the same macro is already running for the same session —
 *  two concurrent ai-visualize runs would race on the same index.html. */
export class TaskAlreadyRunningError extends Error {
  constructor(label: string) {
    super(`${label} is already running for this session.`);
    this.name = "TaskAlreadyRunningError";
  }
}

export interface RunTaskRequest {
  macroId: string;
  label: string;
  harnessSessionId: string;
  harness: HarnessKind;
  cwd: string;
  prompt: string;
}

export interface TaskManagerOptions {
  adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  /** Base URL the harness server is reachable at, e.g. http://127.0.0.1:4100. */
  ingestUrl: string;
  /** Per-boot secret — same one real sessions get, so the task's hooks can
   *  POST to /ingest (events for an unknown session id are silently dropped
   *  there, which is exactly what we want for tasks today). */
  ingestToken: string;
  collectorUrl?: string;
  /** Same builder real sessions use — generates the task's own --settings /
   *  --mcp-config / system-prompt files under generated/<taskId>. */
  buildLaunchOpts?: LaunchOptsBuilder;
  /** Injectable for tests. Defaults to node:child_process.spawn. */
  spawnProcess?: TaskSpawnFn;
  /** Called once the task's process has exited (either outcome) — the server
   *  wires generated-config-dir removal here, mirroring session exit. */
  onCleanup?: (taskId: string) => void;
  now?: () => string;
  generateId?: () => string;
}

export type TaskStatusListener = (task: BackgroundTask) => void;

export class TaskManager {
  private readonly adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  private readonly ingestUrl: string;
  private readonly ingestToken: string;
  private readonly collectorUrl: string | undefined;
  private readonly buildLaunchOpts: LaunchOptsBuilder;
  private readonly spawnProcess: TaskSpawnFn;
  private readonly onCleanup: (taskId: string) => void;
  private readonly now: () => string;
  private readonly generateId: () => string;

  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly processes = new Map<string, TaskProcess>();
  private readonly stderrTails = new Map<string, string>();
  /** The final result event's error text, when the stream produced one —
   *  preferred over a raw stderr tail for failure display. */
  private readonly resultErrors = new Map<string, string>();
  private readonly statusEmitter = new EventEmitter();

  constructor(options: TaskManagerOptions) {
    this.adapters = options.adapters;
    this.ingestUrl = options.ingestUrl;
    this.ingestToken = options.ingestToken;
    this.collectorUrl = options.collectorUrl;
    this.buildLaunchOpts = options.buildLaunchOpts ?? (() => ({}));
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.onCleanup = options.onCleanup ?? (() => {});
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    this.statusEmitter.setMaxListeners(0);
  }

  list(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  onStatusChange(listener: TaskStatusListener): () => void {
    this.statusEmitter.on("status", listener);
    return () => {
      this.statusEmitter.off("status", listener);
    };
  }

  /**
   * Spawns one background task. Resolves once the process is launched (not
   * when it finishes — completion arrives as a task.status broadcast).
   * Throws TaskNotSupportedError / TaskAlreadyRunningError for the two
   * user-addressable refusals; anything else (spawn failure, config
   * generation failure) propagates as-is.
   */
  async run(req: RunTaskRequest): Promise<BackgroundTask> {
    const adapter = this.adapters[req.harness];
    if (!adapter) throw new Error(`No adapter registered for harness "${req.harness}"`);
    if (!adapter.launchTask) throw new TaskNotSupportedError(req.harness, req.label);

    for (const task of this.tasks.values()) {
      if (task.status === "running" && task.macroId === req.macroId && task.harnessSessionId === req.harnessSessionId) {
        throw new TaskAlreadyRunningError(req.label);
      }
    }

    const id = this.generateId();
    const opts: LaunchOpts = {
      harnessSessionId: id,
      cwd: req.cwd,
      prompt: req.prompt,
      ...(await this.buildLaunchOpts(id, { cwd: req.cwd, harness: req.harness })),
    };
    const spec = adapter.launchTask(opts);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    env[ENV.ingestUrl] = `${this.ingestUrl.replace(/\/$/, "")}/ingest`;
    env[ENV.ingestToken] = this.ingestToken;
    env[ENV.sessionId] = id;
    if (this.collectorUrl) env[ENV.collectorUrl] = this.collectorUrl;

    const task: BackgroundTask = {
      id,
      macroId: req.macroId,
      label: req.label,
      harnessSessionId: req.harnessSessionId,
      cwd: req.cwd,
      status: "running",
      startedAt: this.now(),
      endedAt: null,
      exitCode: null,
      statusLines: [],
      errorTail: null,
    };

    let child: TaskProcess;
    try {
      child = this.spawnProcess(spec.command, spec.args, { cwd: spec.cwd, env });
    } catch (err) {
      // Never launched — nothing to track, but the generated config files
      // buildLaunchOpts just wrote still need their exit-time cleanup.
      this.onCleanup(id);
      throw err;
    }

    this.tasks.set(id, task);
    this.processes.set(id, child);
    this.trimFinished();
    this.emitStatus(task);

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleStdoutLine(id, line));
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const tail = (this.stderrTails.get(id) ?? "") + String(chunk);
      this.stderrTails.set(id, tail.slice(-MAX_STDERR_CHARS));
    });
    // A spawn-time failure surfacing async (ENOENT for a missing binary
    // arrives as "error", not "exit") still needs the task reconciled —
    // record the message where the exit handler will pick it up. "error"
    // without a later "exit" is possible for pre-spawn failures, so finish
    // directly; the guard in finish() makes a double call harmless.
    child.on("error", (err) => {
      this.stderrTails.set(id, ((this.stderrTails.get(id) ?? "") + `\n${err.message}`).slice(-MAX_STDERR_CHARS));
      this.finish(id, null);
    });
    child.on("exit", (code) => this.finish(id, code));

    return task;
  }

  /** Kills every still-running task process. Call on server shutdown, same
   *  reason as SessionManager.killAll — child processes aren't torn down by
   *  the HTTP server closing. */
  killAll(): void {
    for (const child of this.processes.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  private handleStdoutLine(id: string, line: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    const update = parseTaskStreamLine(line);
    if (!update) return;
    if (update.result?.isError && update.result.text) {
      this.resultErrors.set(id, update.result.text);
    }
    if (update.statusLines.length === 0) return;
    task.statusLines = [...task.statusLines, ...update.statusLines].slice(-MAX_STATUS_LINES);
    this.emitStatus(task);
  }

  /** The single running→finished transition — shared by "exit" and "error",
   *  which can both fire for one process, so it's idempotent. */
  private finish(id: string, exitCode: number | null): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    const resultError = this.resultErrors.get(id);
    const failed = exitCode !== 0 || resultError !== undefined;
    task.status = failed ? "failed" : "completed";
    task.exitCode = exitCode;
    task.endedAt = this.now();
    if (failed) {
      const stderrTail = this.stderrTails.get(id)?.trim();
      task.errorTail = resultError ?? (stderrTail || `exited with code ${exitCode ?? "unknown"}`);
    }
    this.processes.delete(id);
    this.stderrTails.delete(id);
    this.resultErrors.delete(id);
    this.emitStatus(task);
    this.onCleanup(id);
  }

  /** Drops the oldest finished tasks beyond MAX_FINISHED_TASKS — running
   *  tasks are never dropped. */
  private trimFinished(): void {
    const finished = this.list().filter((task) => task.status !== "running");
    if (finished.length <= MAX_FINISHED_TASKS) return;
    finished
      .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""))
      .slice(0, finished.length - MAX_FINISHED_TASKS)
      .forEach((task) => this.tasks.delete(task.id));
  }

  private emitStatus(task: BackgroundTask): void {
    this.statusEmitter.emit("status", { ...task, statusLines: [...task.statusLines] });
  }
}
