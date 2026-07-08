/**
 * Integration: the claude-code adapter's launchCommand spawned for real
 * under PtyRuntime, resolved against a FAKE `claude` executable placed on
 * a temporary PATH directory. Hermetic: no real Claude Code, credentials
 * or network — and deliberately no shell between us and the child, so the
 * fake agent can prove every argument arrives literally.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claudeCodeAdapter,
  findExecutableOnPath,
  PtyRuntime,
} from "../src/index.js";
import type { SessionHandle } from "../src/index.js";

jest.setTimeout(30_000);

// The fake `claude` is a POSIX shell script; CI runs on Linux and local
// development targets macOS. Skipped on Windows.
const describeIf = process.platform === "win32" ? describe.skip : describe;

/**
 * A fake interactive `claude`: prints a banner, its argv (one per line)
 * and an env marker, then echoes stdin lines at a `> ` prompt like a
 * booted agent awaiting prompt injection.
 */
const FAKE_CLAUDE_SCRIPT = `#!/bin/sh
printf 'fake-claude booted\\n'
i=0
for arg in "$@"; do
  i=$((i+1))
  printf 'argv[%s]=%s\\n' "$i" "$arg"
done
printf 'argc=%s\\n' "$#"
printf 'marker=%s\\n' "\${FAKE_CLAUDE_MARKER-unset}"
printf '> '
while IFS= read -r line; do
  printf 'received: %s\\n' "$line"
  printf '> '
done
`;

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

describeIf("claude-code adapter × PtyRuntime (fake claude on PATH)", () => {
  let runtime: PtyRuntime;
  let handles: SessionHandle[];
  let binDir: string;
  let fakeClaudePath: string;

  /**
   * PATH puts the fake first and includes only system directories after
   * it, so a real `claude` install can never win the lookup.
   */
  const envFor = (
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    PATH: `${binDir}:/usr/bin:/bin`,
    TERM: "xterm-256color",
    HOME: os.tmpdir(),
    ...extra,
  });

  beforeAll(() => {
    binDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-bin-")),
    );
    fakeClaudePath = path.join(binDir, "claude");
    fs.writeFileSync(fakeClaudePath, FAKE_CLAUDE_SCRIPT, { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    runtime = new PtyRuntime({ killTimeoutMs: 500 });
    handles = [];
  });

  afterEach(async () => {
    await Promise.all(
      handles.map((handle) => runtime.kill(handle).catch(() => undefined)),
    );
  });

  const spawnAdapter = async (
    cfg: Partial<Parameters<typeof claudeCodeAdapter.launchCommand>[0]> = {},
  ): Promise<{ handle: SessionHandle; output: OutputCollector }> => {
    const launch = claudeCodeAdapter.launchCommand({
      env: envFor(),
      ...cfg,
    });
    const handle = await runtime.create({
      ...launch,
      cwd: os.tmpdir(),
      cols: 120,
      rows: 32,
    });
    handles.push(handle);
    const output = new OutputCollector();
    runtime.onData(handle, output.listener);
    return { handle, output };
  };

  it("detects the fake claude through the same launch environment", async () => {
    await expect(
      findExecutableOnPath("claude", { env: envFor() }),
    ).resolves.toBe(fakeClaudePath);
  });

  it("spawns interactive claude resolved via PATH, with no arguments", async () => {
    const { handle, output } = await spawnAdapter();

    await output.waitFor("fake-claude booted");
    await output.waitFor("argc=0");
    expect(runtime.isAlive(handle)).toBe(true);
  });

  it("plumbs the adapter env into the child", async () => {
    const { output } = await spawnAdapter({
      env: envFor({ FAKE_CLAUDE_MARKER: "plumbing-ok" }),
    });

    await output.waitFor("marker=plumbing-ok");
  });

  it("passes the appended system prompt as a single literal argument", async () => {
    // Shell metacharacters throughout: if any shell ever interpreted the
    // argv, the subshell would run (or the argument would split) and the
    // literal match below would fail.
    const probe =
      "sys-probe $(echo interpolated) `whoami` \"double\" 'single' ; & | $HOME *";
    const { output } = await spawnAdapter({ appendSystemPrompt: probe });

    await output.waitFor("argv[1]=--append-system-prompt");
    await output.waitFor(`argv[2]=${probe}`);
    await output.waitFor("argc=2");
  });

  it("delivers prompts post-launch by writing into the booted session", async () => {
    const { handle, output } = await spawnAdapter();
    await output.waitFor("> ");

    runtime.write(handle, "install the sapiom mcp server\r");

    await output.waitFor("received: install the sapiom mcp server");
    expect(runtime.isAlive(handle)).toBe(true);
  });

  it("kill() ends the fake claude like any other session", async () => {
    const { handle, output } = await spawnAdapter();
    await output.waitFor("> ");

    await runtime.kill(handle);

    expect(runtime.isAlive(handle)).toBe(false);
  });
});
