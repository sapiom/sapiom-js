import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { BackgroundTask, HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import {
  TaskAlreadyRunningError,
  TaskManager,
  TaskNotSupportedError,
  type TaskProcess,
  type TaskSpawnFn,
} from "./task-manager.js";

class FakeProcess extends EventEmitter implements TaskProcess {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
}

interface Spawned {
  command: string;
  args: string[];
  options: { cwd: string; env: Record<string, string> };
  proc: FakeProcess;
}

function makeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts: LaunchOpts): SpawnSpec => ({ command: "claude", args: [], env: {}, cwd: opts.cwd }),
    resume: (_id: string, opts: LaunchOpts): SpawnSpec => ({ command: "claude", args: [], env: {}, cwd: opts.cwd }),
    listPastSessions: async () => [],
    launchTask: (opts: LaunchOpts): SpawnSpec => ({
      command: "claude",
      args: ["-p", opts.prompt ?? ""],
      env: { CLAUDECODE: null },
      cwd: opts.cwd,
    }),
    ...overrides,
  };
}

function makeManager(options: {
  adapter?: HarnessAdapter;
  onCleanup?: (taskId: string) => void;
  buildLaunchOpts?: () => Record<string, never>;
} = {}): { manager: TaskManager; spawned: Spawned[]; statuses: BackgroundTask[] } {
  const spawned: Spawned[] = [];
  const spawnProcess: TaskSpawnFn = (command, args, opts) => {
    const proc = new FakeProcess();
    spawned.push({ command, args, options: opts, proc });
    return proc;
  };
  const manager = new TaskManager({
    adapters: { "claude-code": options.adapter ?? makeAdapter() },
    ingestUrl: "http://127.0.0.1:4100",
    ingestToken: "tok-boot",
    spawnProcess,
    onCleanup: options.onCleanup,
    buildLaunchOpts: options.buildLaunchOpts,
    now: () => "2026-01-01T00:00:00.000Z",
    generateId: (() => {
      let n = 0;
      return () => `task-${++n}`;
    })(),
  });
  const statuses: BackgroundTask[] = [];
  manager.onStatusChange((task) => statuses.push(task));
  return { manager, spawned, statuses };
}

const runRequest = {
  macroId: "visualize",
  label: "Visualize",
  harnessSessionId: "sess-1",
  harness: "claude-code" as const,
  cwd: "/tmp/proj",
  prompt: "draw the canvas",
};

/** Lets the readline/stream listeners attached inside run() drain. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("TaskManager", () => {
  it("spawns via the adapter's launchTask with the task's own ingest identity in env", async () => {
    const { manager, spawned, statuses } = makeManager();
    const task = await manager.run(runRequest);

    expect(task.status).toBe("running");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("claude");
    expect(spawned[0].args).toEqual(["-p", "draw the canvas"]);
    expect(spawned[0].options.cwd).toBe("/tmp/proj");
    expect(spawned[0].options.env.SAPIOM_HARNESS_INGEST_URL).toBe("http://127.0.0.1:4100/ingest");
    expect(spawned[0].options.env.SAPIOM_HARNESS_INGEST_TOKEN).toBe("tok-boot");
    expect(spawned[0].options.env.SAPIOM_HARNESS_SESSION_ID).toBe(task.id);
    // spec.env's null unset semantics apply, same as SessionManager.spawn.
    expect("CLAUDECODE" in spawned[0].options.env).toBe(false);
    expect(statuses.map((s) => s.status)).toEqual(["running"]);
    expect(manager.list()).toHaveLength(1);
  });

  it("appends parsed status lines from stdout and re-broadcasts the task on each", async () => {
    const { manager, spawned, statuses } = makeManager();
    const task = await manager.run(runRequest);

    spawned[0].proc.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.html" } }] },
      }) + "\n",
    );
    spawned[0].proc.stdout.write("not json\n");
    await tick();

    expect(manager.get(task.id)?.statusLines).toEqual(["Read a.html"]);
    expect(statuses.at(-1)?.statusLines).toEqual(["Read a.html"]);
  });

  it("completes on exit 0 and runs cleanup", async () => {
    const onCleanup = vi.fn();
    const { manager, spawned, statuses } = makeManager({ onCleanup });
    const task = await manager.run(runRequest);

    spawned[0].proc.emit("exit", 0);
    await tick();

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.exitCode).toBe(0);
    expect(finished?.endedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(finished?.errorTail).toBeNull();
    expect(onCleanup).toHaveBeenCalledWith(task.id);
    expect(statuses.at(-1)?.status).toBe("completed");
  });

  it("captures the success result event's text on the finished task as resultText", async () => {
    const { manager, spawned, statuses } = makeManager();
    const task = await manager.run(runRequest);

    spawned[0].proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"summary":"hi"}' }) + "\n",
    );
    await tick();
    // Not published while still running — only the terminal snapshot carries it.
    expect(manager.get(task.id)?.resultText).toBeNull();

    spawned[0].proc.emit("exit", 0);
    await tick();

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.resultText).toBe('{"summary":"hi"}');
    expect(statuses.at(-1)?.resultText).toBe('{"summary":"hi"}');
  });

  it("leaves resultText null on failure — the error path speaks through errorTail", async () => {
    const { manager, spawned } = makeManager();
    const task = await manager.run(runRequest);

    spawned[0].proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "partial answer" }) + "\n",
    );
    await tick();
    spawned[0].proc.emit("exit", 1);

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.resultText).toBeNull();
  });

  it("passes model/maxTurns/workflowPath through to the adapter's LaunchOpts and the task record", async () => {
    const launchTask = vi.fn(
      (opts: LaunchOpts): SpawnSpec => ({ command: "claude", args: [], env: {}, cwd: opts.cwd }),
    );
    const { manager } = makeManager({ adapter: makeAdapter({ launchTask }) });
    const task = await manager.run({
      ...runRequest,
      workflowPath: "/tmp/proj/wf-a",
      model: "sonnet",
      maxTurns: 8,
    });

    expect(task.workflowPath).toBe("/tmp/proj/wf-a");
    const opts = launchTask.mock.calls[0][0];
    expect(opts.model).toBe("sonnet");
    expect(opts.maxTurns).toBe(8);
  });

  it("fails on non-zero exit with the stderr tail as the error", async () => {
    const { manager, spawned } = makeManager();
    const task = await manager.run(runRequest);

    spawned[0].proc.stderr.write("something exploded\n");
    await tick();
    spawned[0].proc.emit("exit", 1);

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.exitCode).toBe(1);
    expect(finished?.errorTail).toBe("something exploded");
  });

  it("fails when the stream's result event reports an error, even on exit 0, preferring its text", async () => {
    const { manager, spawned } = makeManager();
    const task = await manager.run(runRequest);

    spawned[0].proc.stdout.write(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API overloaded" }) + "\n",
    );
    await tick();
    spawned[0].proc.emit("exit", 0);

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorTail).toBe("API overloaded");
  });

  it("reconciles a spawn that dies via 'error' with no 'exit' (e.g. binary not on PATH)", async () => {
    const onCleanup = vi.fn();
    const { manager, spawned } = makeManager({ onCleanup });
    const task = await manager.run(runRequest);

    spawned[0].proc.emit("error", new Error("spawn claude ENOENT"));

    const finished = manager.get(task.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorTail).toContain("ENOENT");
    expect(onCleanup).toHaveBeenCalledWith(task.id);

    // A late 'exit' after 'error' must not double-transition.
    spawned[0].proc.emit("exit", 1);
    expect(manager.get(task.id)?.status).toBe("failed");
  });

  it("throws TaskNotSupportedError when the adapter has no launchTask", async () => {
    const { manager } = makeManager({ adapter: makeAdapter({ launchTask: undefined }) });
    await expect(manager.run(runRequest)).rejects.toBeInstanceOf(TaskNotSupportedError);
    expect(manager.list()).toHaveLength(0);
  });

  it("rejects a duplicate run of the same workflow-less macro for the same session while one is in flight", async () => {
    const { manager, spawned } = makeManager();
    await manager.run(runRequest);
    await expect(manager.run(runRequest)).rejects.toBeInstanceOf(TaskAlreadyRunningError);
    // A different session may run the same macro concurrently.
    await expect(manager.run({ ...runRequest, harnessSessionId: "sess-2" })).resolves.toBeDefined();
    // And once the first finishes, the same session can run it again.
    spawned[0].proc.emit("exit", 0);
    await expect(manager.run(runRequest)).resolves.toBeDefined();
  });

  it("dedupes workflow-targeted tasks per WORKFLOW: same workflow rejected across sessions, different workflows fine in one session", async () => {
    const { manager, spawned } = makeManager();
    const wfA = { ...runRequest, workflowPath: "/tmp/proj/wf-a" };
    await manager.run(wfA);

    // Same workflow, same macro — refused no matter which session asks.
    await expect(manager.run(wfA)).rejects.toBeInstanceOf(TaskAlreadyRunningError);
    await expect(manager.run({ ...wfA, harnessSessionId: "sess-2" })).rejects.toBeInstanceOf(TaskAlreadyRunningError);

    // A DIFFERENT workflow from the same session runs concurrently — a
    // workflow switch mid-enrichment must not block the new binding's own run.
    await expect(manager.run({ ...wfA, workflowPath: "/tmp/proj/wf-b" })).resolves.toBeDefined();

    // Once the first finishes, the same workflow can run again.
    spawned[0].proc.emit("exit", 0);
    await expect(manager.run(wfA)).resolves.toBeDefined();
  });

  it("runs cleanup even when spawning itself throws (generated config files already exist)", async () => {
    const onCleanup = vi.fn();
    const spawnProcess: TaskSpawnFn = () => {
      throw new Error("no fork for you");
    };
    const manager = new TaskManager({
      adapters: { "claude-code": makeAdapter() },
      ingestUrl: "http://127.0.0.1:4100",
      ingestToken: "tok",
      spawnProcess,
      onCleanup,
      generateId: () => "task-x",
    });
    await expect(manager.run(runRequest)).rejects.toThrow("no fork for you");
    expect(onCleanup).toHaveBeenCalledWith("task-x");
    expect(manager.list()).toHaveLength(0);
  });

  it("killAll signals every still-running task process", async () => {
    const { manager, spawned } = makeManager();
    await manager.run(runRequest);
    await manager.run({ ...runRequest, harnessSessionId: "sess-2" });
    spawned[1].proc.emit("exit", 0); // finished — no longer tracked

    manager.killAll();
    expect(spawned[0].proc.killed).toBe("SIGTERM");
    expect(spawned[1].proc.killed).toBeUndefined();
  });
});
