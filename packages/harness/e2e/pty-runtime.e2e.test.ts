/**
 * Full-lifecycle tests for PtyRuntime against the fake-agent fixture, using
 * the real node-pty. Hermetic: spawns only `node` (the current executable)
 * with a minimal environment — no external agents, credentials or network.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PtyRuntime, UnknownSessionError } from "../src/runtime/index.js";
import type { SessionHandle } from "../src/runtime/index.js";

jest.setTimeout(30_000);

const FAKE_AGENT = path.join(
  __dirname,
  "fixtures",
  "fake-agent",
  "fake-agent.js",
);
const TRANSCRIPTS = path.join(
  __dirname,
  "fixtures",
  "fake-agent",
  "transcripts",
);

/** Collects session output and lets tests await specific content. */
class OutputCollector {
  private buffers: Buffer[] = [];
  private waiters: Array<() => void> = [];

  readonly listener = (chunk: Buffer): void => {
    this.buffers.push(chunk);
    const waiters = this.waiters;
    this.waiters = [];
    for (const notify of waiters) notify();
  };

  get text(): string {
    return Buffer.concat(this.buffers).toString("utf8");
  }

  async waitFor(needle: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.text.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for ${JSON.stringify(needle)}. Output so far:\n${this.text}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.text;
  }
}

function minimalEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
    HOME: os.tmpdir(),
    ...extra,
  };
}

describe("PtyRuntime × fake-agent (real pty)", () => {
  let runtime: PtyRuntime;
  let handles: SessionHandle[];

  const spawnAgent = async (
    transcript: string,
    opts: Partial<Parameters<PtyRuntime["create"]>[0]> = {},
  ): Promise<{
    handle: SessionHandle;
    output: OutputCollector;
    unsubscribe: () => void;
  }> => {
    const handle = await runtime.create({
      command: process.execPath,
      args: [FAKE_AGENT, path.join(TRANSCRIPTS, `${transcript}.json`)],
      env: minimalEnv(),
      cwd: path.dirname(FAKE_AGENT),
      cols: 80,
      rows: 24,
      ...opts,
    });
    handles.push(handle);
    const output = new OutputCollector();
    const unsubscribe = runtime.onData(handle, output.listener);
    return { handle, output, unsubscribe };
  };

  beforeEach(() => {
    runtime = new PtyRuntime({ killTimeoutMs: 500 });
    handles = [];
  });

  afterEach(async () => {
    await Promise.all(
      handles.map((handle) => runtime.kill(handle).catch(() => undefined)),
    );
  });

  it("spawns the fake agent and streams its boot output", async () => {
    const { handle, output } = await spawnAgent("basic-echo");

    const text = await output.waitFor("fake-agent");
    expect(text).toContain("v0.1.0");
    await output.waitFor("> ");
    expect(runtime.isAlive(handle)).toBe(true);
  });

  it("write() reaches the agent and its echo is observed", async () => {
    const { handle, output } = await spawnAgent("basic-echo");
    await output.waitFor("> ");

    runtime.write(handle, "hello world\r");

    const text = await output.waitFor("you said: hello world");
    // Busy/idle cycle ran before the echo (spinner label from the transcript).
    expect(text).toContain("thinking");
  });

  it("plumbs env, cwd, cols and rows into the child", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "fake-agent-")),
    );
    const { output } = await spawnAgent("diagnostics", {
      env: minimalEnv({ FAKE_AGENT_MARKER: "plumbing-ok" }),
      cwd,
      cols: 100,
      rows: 40,
    });

    await output.waitFor("[size] 100x40");
    await output.waitFor(`[cwd] ${cwd}`);
    await output.waitFor("[env] FAKE_AGENT_MARKER=plumbing-ok");
  });

  it("resize() does not crash and reaches the child", async () => {
    const { handle, output } = await spawnAgent("diagnostics");
    await output.waitFor("> ");

    expect(() => runtime.resize(handle, 120, 30)).not.toThrow();

    await output.waitFor("[resize] 120x30");
    expect(runtime.isAlive(handle)).toBe(true);
  });

  it("kill() terminates the session and isAlive() flips to false", async () => {
    const { handle, output } = await spawnAgent("basic-echo");
    await output.waitFor("> ");
    expect(runtime.isAlive(handle)).toBe(true);

    await runtime.kill(handle);

    expect(runtime.isAlive(handle)).toBe(false);
    // Idempotent: killing an already-dead session resolves cleanly.
    await expect(runtime.kill(handle)).resolves.toBeUndefined();
  });

  it("kill() escalates to SIGKILL when the agent ignores SIGTERM", async () => {
    const { handle, output } = await spawnAgent("stubborn");
    await output.waitFor("> ");

    await runtime.kill(handle);

    expect(runtime.isAlive(handle)).toBe(false);
    expect(output.text).toContain("SIGTERM ignored");
  });

  it("onData() unsubscribe stops delivery without affecting other listeners", async () => {
    const { handle, output, unsubscribe } = await spawnAgent("basic-echo");
    await output.waitFor("> ");

    const late = new OutputCollector();
    runtime.onData(handle, late.listener);
    unsubscribe();
    const snapshotAfterUnsubscribe = output.text;

    runtime.write(handle, "after-unsubscribe\r");
    await late.waitFor("you said: after-unsubscribe");

    expect(output.text).toBe(snapshotAfterUnsubscribe);
    expect(output.text).not.toContain("after-unsubscribe");
  });

  it("isAlive() is false for handles the runtime never issued; other methods throw", () => {
    const stranger: SessionHandle = { id: "pty-does-not-exist" };

    expect(runtime.isAlive(stranger)).toBe(false);
    expect(() => runtime.write(stranger, "x")).toThrow(UnknownSessionError);
    expect(() => runtime.resize(stranger, 80, 24)).toThrow(UnknownSessionError);
    expect(() => runtime.onData(stranger, () => undefined)).toThrow(
      UnknownSessionError,
    );
    return expect(runtime.kill(stranger)).rejects.toThrow(UnknownSessionError);
  });

  it("replays the recorded claude-code-boot transcript (banner then idle footer)", async () => {
    // Recorded at 100x30; replay at the same size so the box drawing is faithful.
    const { output } = await spawnAgent("claude-code-boot", {
      cols: 100,
      rows: 30,
    });

    await output.waitFor("Claude Code");
    await output.waitFor("? for shortcuts");
  });
});
