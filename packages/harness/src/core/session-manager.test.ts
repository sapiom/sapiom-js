import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessAdapter, HarnessKind, HarnessSession, SpawnSpec } from "../shared/types.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ExternalHarnessError, SessionNotResumeableError } from "./errors.js";
import {
  SessionManager,
  sanitizeExitTail,
  type PtySpawnFn,
  type SessionManagerOptions,
} from "./session-manager.js";

/** Minimal fake IPty: lets tests drive onData/onExit and observe write/resize/kill.
 *  `pid` is only set when a test passes one explicitly — sweep tests need a
 *  numeric pid to probe (always paired with an injected isPidAlive so the
 *  fake pid is never checked against real OS processes); everything else
 *  leaves it undefined, which the sweep must treat as "can't tell, hands off". */
function createFakePty(pid?: number) {
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const pty = {
    pid,
    onData: (cb: (chunk: string) => void) => {
      dataListeners.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(cb);
      return { dispose: () => {} };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return {
    pty,
    emitData: (chunk: string) => dataListeners.forEach((cb) => cb(chunk)),
    emitExit: (exitCode = 0) => exitListeners.forEach((cb) => cb({ exitCode })),
  };
}

function createFakeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: vi.fn(async () => []),
    launch: vi.fn(
      (opts): SpawnSpec => ({
        command: "fake-claude",
        args: ["--launch"],
        env: {},
        cwd: opts.cwd,
      }),
    ),
    resume: vi.fn(
      (agentSessionId, opts): SpawnSpec => ({
        command: "fake-claude",
        args: ["--resume", agentSessionId],
        env: {},
        cwd: opts.cwd,
      }),
    ),
    listPastSessions: vi.fn(async () => []),
    // Resumable by default so the existing resume tests exercise resume()
    // itself; the pre-flight's own behaviour is covered by overriding this.
    canResume: vi.fn(async () => true),
    ...overrides,
  };
}

describe("SessionManager", () => {
  let dir: string;
  let sessionsPath: string;

  let managers: SessionManager[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-sm-test-"));
    sessionsPath = join(dir, "sessions.json");
    managers = [];
  });

  afterEach(async () => {
    // Pty exit/write handlers fire persist() without awaiting it; flush
    // before cleanup so a lingering write doesn't race the temp-dir removal.
    await Promise.all(managers.map((m) => m.flush()));
    await rm(dir, { recursive: true, force: true });
  });

  function makeManager(
    opts: {
      adapter?: HarnessAdapter;
      spawnPty?: PtySpawnFn;
      buildLaunchOpts?: SessionManagerOptions["buildLaunchOpts"];
      writeWorkspaceContext?: SessionManagerOptions["writeWorkspaceContext"];
      prepareWorkspaceContext?: SessionManagerOptions["prepareWorkspaceContext"];
      ensureCanvasTemplate?: SessionManagerOptions["ensureCanvasTemplate"];
      isPidAlive?: SessionManagerOptions["isPidAlive"];
      platform?: SessionManagerOptions["platform"];
      /** Pid given to every fake pty this manager spawns — see createFakePty(). */
      fakePid?: number;
    } = {},
  ) {
    const adapter = opts.adapter ?? createFakeAdapter();
    const spawns: ReturnType<typeof createFakePty>[] = [];
    const spawnPty: PtySpawnFn =
      opts.spawnPty ??
      ((file, args) => {
        const fake = createFakePty(opts.fakePid);
        spawns.push(fake);
        void file;
        void args;
        return fake.pty as unknown as ReturnType<PtySpawnFn>;
      });
    const manager = new SessionManager({
      adapters: { "claude-code": adapter },
      ingestUrl: "http://127.0.0.1:4100",
      ingestToken: "boot-token",
      sessionsPath,
      spawnPty,
      buildLaunchOpts: opts.buildLaunchOpts,
      writeWorkspaceContext: opts.writeWorkspaceContext,
      prepareWorkspaceContext: opts.prepareWorkspaceContext,
      ensureCanvasTemplate: opts.ensureCanvasTemplate,
      isPidAlive: opts.isPidAlive,
      platform: opts.platform,
    });
    managers.push(manager);
    return { manager, adapter, spawns };
  }

  it("creates a session, spawns via the adapter's SpawnSpec, and marks it running", async () => {
    const { manager, adapter } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/proj", harnessSessionId: session.id }),
    );
    expect(session.status).toBe("running");
    expect(session.cwd).toBe("/tmp/proj");
    expect(session.title).toBe("proj");
    expect(manager.get(session.id)).toEqual(session);
    expect(manager.list()).toHaveLength(1);
  });

  it("persists sessions to disk and reconciles non-exited sessions to exited on reload", async () => {
    const { manager } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    expect(session.status).toBe("running");

    const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
    expect(raw).toHaveLength(1);
    expect(raw[0]?.id).toBe(session.id);
    expect(raw[0]?.status).toBe("running");

    // A fresh process (new SessionManager instance) has no live ptys — any
    // session that was "running"/"starting" on disk must reconcile to "exited".
    const { manager: reloaded } = makeManager();
    await reloaded.init();
    expect(reloaded.get(session.id)?.status).toBe("exited");
  });

  it("routes write() and resize() to the underlying pty", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(manager.write(session.id, "echo hi\r")).toBe(true);
    expect(spawns[0]?.pty.write).toHaveBeenCalledWith("echo hi\r");

    expect(manager.resize(session.id, 120, 40)).toBe(true);
    expect(spawns[0]?.pty.resize).toHaveBeenCalledWith(120, 40);

    expect(manager.write("unknown-id", "x")).toBe(false);
    expect(manager.resize("unknown-id", 1, 1)).toBe(false);
  });

  describe("submitInput", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("splits non-empty submitted text into a text write, then a separate \\r after a delay", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const submitPromise = manager.submitInput(session.id, "hello world", true);

      // Text lands immediately; the trailing Enter must NOT be part of the
      // same write (that's exactly the bracketed-paste bug this fixes).
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("hello world");
      expect(spawns[0]?.pty.write).not.toHaveBeenCalledWith("\r");

      await vi.advanceTimersByTimeAsync(300);
      const ok = await submitPromise;

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(2);
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello world");
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("writes a bare \\r in a single call for submit:true with empty text (no splitting needed)", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const ok = await manager.submitInput(session.id, "", true);

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("\r");
    });

    it("writes only the text, with no \\r at all, when submit is false", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const ok = await manager.submitInput(session.id, "draft text", false);

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("draft text");
    });

    it("brackets the text once the app has turned bracketed paste on", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);
      // The TUI announces mode 2004 in its own output; only then is it safe to
      // send the markers rather than have them rendered as literal text.
      spawns[0]?.emitData("\x1b[?1049;2004h");

      const submitPromise = manager.submitInput(session.id, "step context\n\nDebug this step", true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await submitPromise).toBe(true);

      // One paste whose newlines can't submit a fragment, then Enter.
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(
        1,
        "\x1b[200~step context\n\nDebug this step\x1b[201~",
      );
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("writes the text raw again once the app turns bracketed paste back off", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);
      spawns[0]?.emitData("\x1b[?2004h");
      spawns[0]?.emitData("\x1b[?2004l");

      const submitPromise = manager.submitInput(session.id, "hello world", true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await submitPromise).toBe(true);

      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello world");
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("never brackets a submit:false draft — the text is the user's to edit", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);
      spawns[0]?.emitData("\x1b[?2004h");

      expect(await manager.submitInput(session.id, "draft text", false)).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("draft text");
    });

    it("paste-wraps on the adapter's assumption when NO 2004 traffic was ever observed", async () => {
      // ConPTY re-renders output instead of passing DEC private-mode sequences
      // through, so on Windows the `ESC[?2004h` announcement never arrives even
      // from an app that has the mode on — a raw multi-line write then submits
      // at its first newline. Claude Code declares assumesBracketedPaste for
      // exactly this blind spot.
      const { manager, spawns } = makeManager({
        adapter: createFakeAdapter({ assumesBracketedPaste: true }),
        platform: "win32",
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);
      spawns[0]?.emitData("welcome banner, no mode announcements");

      const submitPromise = manager.submitInput(session.id, "line one\n\nline two", true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await submitPromise).toBe(true);

      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "\x1b[200~line one\n\nline two\x1b[201~");
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("an OBSERVED reset always beats the adapter's assumption", async () => {
      // The assumption only covers the never-observed state; an app that
      // explicitly turned 2004 off would render the markers as literal text.
      const { manager, spawns } = makeManager({
        adapter: createFakeAdapter({ assumesBracketedPaste: true }),
        platform: "win32",
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);
      spawns[0]?.emitData("\x1b[?2004h");
      spawns[0]?.emitData("\x1b[?2004l");

      const submitPromise = manager.submitInput(session.id, "hello\nworld", true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await submitPromise).toBe(true);

      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello\nworld");
    });

    it("returns false for an unknown session without ever touching a pty", async () => {
      const { manager } = makeManager();
      expect(await manager.submitInput("unknown-id", "hello", true)).toBe(false);
    });

    it("does not write the trailing \\r if the session's pty is gone by the time the delay elapses", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const submitPromise = manager.submitInput(session.id, "hello", true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);

      spawns[0]?.emitExit(0);
      await vi.advanceTimersByTimeAsync(300);
      const ok = await submitPromise;

      expect(ok).toBe(false);
      // Still just the one write from before the pty exited — no trailing \r.
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
    });
  });

  describe("exit output capture (exitTail)", () => {
    it("preserves the tail of output when a session exits abnormally (non-zero code)", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      spawns[0]?.emitData("\x1b[31merror\x1b[0m: unknown option '--plugin-dir'\n");
      spawns[0]?.emitExit(1);
      await manager.flush();

      const exited = manager.get(session.id);
      expect(exited?.status).toBe("exited");
      expect(exited?.exitCode).toBe(1);
      // The agent's own error line survives — with ANSI stripped — which is the
      // whole point: a startup crash is no longer an opaque exit code.
      expect(exited?.exitTail).toContain("error: unknown option '--plugin-dir'");
      expect(exited?.exitTail).not.toContain("\x1b");
    });

    it("captures nothing for a clean exit (code 0)", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      spawns[0]?.emitData("all good, bye\n");
      spawns[0]?.emitExit(0);
      await manager.flush();

      expect(manager.get(session.id)?.exitTail ?? null).toBeNull();
    });

    it("captures nothing when an abnormal exit produced no readable output", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // Only cursor/clear control noise — nothing a human could read.
      spawns[0]?.emitData("\x1b[2J\x1b[H");
      spawns[0]?.emitExit(1);
      await manager.flush();

      expect(manager.get(session.id)?.exitTail ?? null).toBeNull();
    });

    it("captures nothing for a user-initiated kill, even when the pty reports a non-zero signal code", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      spawns[0]?.emitData("some normal session output the user was looking at\n");
      // kill() marks the handle; node-pty then reports 143 (128 + SIGTERM) on
      // some platforms — a non-zero code, but NOT a crash to diagnose.
      const killed = manager.kill(session.id);
      spawns[0]?.emitExit(143);
      await killed;
      await manager.flush();

      const exited = manager.get(session.id);
      expect(exited?.exitCode).toBe(143);
      expect(exited?.exitTail ?? null).toBeNull();
    });
  });

  describe("sanitizeExitTail", () => {
    it("strips ANSI and trailing control noise, keeping readable text", () => {
      expect(sanitizeExitTail("\x1b[31mboom\x1b[0m\r\n")).toBe("boom");
    });

    it("returns null when nothing readable remains", () => {
      expect(sanitizeExitTail("\x1b[2J\x1b[H")).toBeNull();
      expect(sanitizeExitTail("")).toBeNull();
    });

    it("keeps only the final window of a large buffer", () => {
      const out = sanitizeExitTail("x".repeat(10_000) + "TAIL_MARKER");
      expect(out?.endsWith("TAIL_MARKER")).toBe(true);
      expect((out ?? "").length).toBeLessThanOrEqual(4_096);
    });
  });

  describe("readiness gating (SessionNotReadyError / setReady / detectBlockingPrompt)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a fresh session starts not-ready even though its pty is already \"running\"", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      expect(session.status).toBe("running");
      expect(session.ready).toBe(false);
    });

    it("write() (raw keystrokes) is never gated on readiness — a human must be able to answer a blocking prompt themselves", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      expect(session.ready).toBe(false);

      expect(manager.write(session.id, "1\r")).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("1\r");
    });

    it(
      "THE RACE REPRO: submitInput() against a not-yet-ready session queues and succeeds once " +
        "setReady() fires before the grace period elapses (macro fired a beat before onboarding finished)",
      async () => {
        const { manager, spawns } = makeManager();
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        const submitPromise = manager.submitInput(session.id, "hello", true);
        // Not ready yet — must NOT have written anything, this is exactly the
        // bug: input landing on a TUI that isn't listening yet.
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // The real SessionStart hook lands a moment later.
        await vi.advanceTimersByTimeAsync(500);
        manager.setReady(session.id);

        // Generous, not tightly matched to SUBMIT_DELAY_MS: the readiness
        // poll loop's own in-flight tick can eat into part of a
        // precisely-sized advance before SUBMIT_DELAY_MS's sleep even
        // starts, since setReady() above only flips a flag — the loop still
        // has to wake up and notice it on its own schedule.
        await vi.advanceTimersByTimeAsync(1_000);
        const ok = await submitPromise;

        expect(ok).toBe(true);
        expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello");
        expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
      },
    );

    it("throws SessionNotReadyError (never silently proceeds) when a session never becomes ready within the grace period", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const submitPromise = manager.submitInput(session.id, "hello", true);
      const assertion = expect(submitPromise).rejects.toThrow(/not ready yet/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      // The whole point: nothing was ever written into the not-listening TUI.
      expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
    });

    it("resuming resets ready back to false, even for a session that was ready before its pty exited", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setAgentSessionId(session.id, "agent-1");
      manager.setReady(session.id);
      expect(manager.get(session.id)?.ready).toBe(true);

      spawns[0]?.emitExit(0);
      expect(manager.get(session.id)?.status).toBe("exited");

      await manager.resume(session.id);
      expect(manager.get(session.id)?.status).toBe("running");
      // Trust dialogs can reappear on resume (e.g. different sandbox flags)
      // — a fresh pty hasn't proven itself interactive yet either way.
      expect(manager.get(session.id)?.ready).toBe(false);
    });

    it("setReady is idempotent and a silent no-op for an unknown session id", () => {
      const { manager } = makeManager();
      expect(() => manager.setReady("unknown-id")).not.toThrow();
    });

    describe("harnesses with detectBlockingPrompt (Codex's lazy-rollout-file bridge)", () => {
      it("is not ready before the settle window elapses, even with a clean scrollback", async () => {
        const detectBlockingPrompt = vi.fn(() => false);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt, readyFallback: "immediate" }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        spawns[0]?.emitData("› Ask Codex to do anything\r\n");

        const submitPromise = manager.submitInput(session.id, "hello", true);
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // Generous, not tightly matched to READY_SETTLE_MS + SUBMIT_DELAY_MS:
        // the settle window is checked once per READY_POLL_MS poll tick, not
        // the instant it elapses, so the actual crossing (and the fresh
        // SUBMIT_DELAY_MS sleep that only starts once it does) can land
        // meaningfully later than the nominal 700ms.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(await submitPromise).toBe(true);
      });

      it("becomes ready enough after the settle window when the scrollback shows no blocking prompt (the common already-trusted case)", async () => {
        const detectBlockingPrompt = vi.fn(() => false);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt, readyFallback: "immediate" }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        spawns[0]?.emitData("› Ask Codex to do anything\r\n");

        await vi.advanceTimersByTimeAsync(700);
        const submitPromise = manager.submitInput(session.id, "hello", true);
        await vi.advanceTimersByTimeAsync(1_000);
        const ok = await submitPromise;

        expect(ok).toBe(true);
        expect(spawns[0]?.pty.write).toHaveBeenCalledWith("hello");
        // Only the tail of retained scrollback is scanned, not the full history.
        expect(detectBlockingPrompt).toHaveBeenCalledWith(expect.any(String));
      });

      it("stays not-ready while the scrollback shows a blocking prompt, then proceeds once it clears", async () => {
        let showingPrompt = true;
        const detectBlockingPrompt = vi.fn(() => showingPrompt);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt, readyFallback: "immediate" }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        spawns[0]?.emitData("Do you trust the contents of this directory?\r\n");

        const submitPromise = manager.submitInput(session.id, "hello", true);
        await vi.advanceTimersByTimeAsync(700);
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // Simulated: a human answers the prompt directly in the terminal.
        showingPrompt = false;
        spawns[0]?.emitData("› Ask Codex to do anything\r\n");
        await vi.advanceTimersByTimeAsync(1_200);
        expect(await submitPromise).toBe(true);
      });

      it("throws SessionNotReadyError if the blocking prompt never clears within the grace period", async () => {
        const detectBlockingPrompt = vi.fn(() => true);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt, readyFallback: "immediate" }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        spawns[0]?.emitData("Do you trust the contents of this directory?\r\n");

        const submitPromise = manager.submitInput(session.id, "hello", true);
        const assertion = expect(submitPromise).rejects.toThrow(/not ready yet/i);
        await vi.advanceTimersByTimeAsync(8_000);
        await assertion;

        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
      });
    });
  });

  describe("immediate ready fallback (Codex's first-prompt bridge)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const immediateAdapter = (
      detect: (scrollback: string) => boolean = () => false,
      detectReady: (scrollback: string) => boolean = (scrollback) =>
        scrollback.includes("Ask Codex to do anything"),
    ) =>
      createFakeAdapter({
        readyFallback: "immediate",
        detectBlockingPrompt: vi.fn(detect),
        detectReadyPrompt: vi.fn(detectReady),
      });

    it("publishes ready after output settles without waiting for submitInput()", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const readyStatuses: boolean[] = [];
      manager.onStatusChange((session) => readyStatuses.push(session.ready));
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("\x1b[1;1H› Ask Codex to do anything\r\n");

      await vi.advanceTimersByTimeAsync(749);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(manager.get(session.id)?.ready).toBe(true);
      expect(readyStatuses.filter(Boolean)).toHaveLength(1);
      expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
    });

    it("requires pty output before publishing ready", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      spawns[0]?.emitData("› Ask Codex to do anything\r\n");
      await vi.advanceTimersByTimeAsync(799);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("ignores Codex's animation-only synchronized repaints when settling", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("› Ask Codex to do anything\r\n");

      // Real codex-cli 0.147.0 emits a control-only frame like this about
      // every 80ms while idle. It must not postpone readiness forever.
      const animationFrame = "\x1b[?2026h\x1b[1;55H\x1b[0m\x1b[49m\x1b[K\x1b[?25l\x1b[?2026l";
      for (let elapsed = 100; elapsed <= 700; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
        spawns[0]?.emitData(animationFrame);
      }
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("keeps a blocking screen visible to readiness checks through ANSI-only redraw churn", async () => {
      const detectBlockingPrompt = vi.fn((scrollback: string) => scrollback.includes("Sign in with ChatGPT"));
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(detectBlockingPrompt),
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // A real Ratatui repaint — including its boundary markers — can span
      // several node-pty chunks.
      spawns[0]?.emitData("\x1b[?20");
      spawns[0]?.emitData("26h\x1b[2J");
      spawns[0]?.emitData("\x1b[1;1HSign in with ChatGPT\r\nProvide your own API key");
      spawns[0]?.emitData("\x1b[?20");
      spawns[0]?.emitData("26l");
      // More than the 4KB detector window of raw ANSI noise must not evict the
      // sign-in copy that remains visibly painted on the terminal.
      const animationFrame =
        "\x1b[?2026h" + "\x1b[1;55H\x1b[0m\x1b[49m\x1b[K".repeat(200) + "\x1b[?2026l";
      spawns[0]?.emitData(animationFrame);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(manager.get(session.id)?.ready).toBe(false);
      expect(detectBlockingPrompt).toHaveBeenCalledWith(expect.stringContaining("Sign in with ChatGPT"));

      // A positive composer frame clears the old-screen latch.
      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[1;1H› Ask Codex to do anything\r\n\x1b[?2026l",
      );
      await vi.advanceTimersByTimeAsync(700);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("clears a trust-screen latch on the Codex 0.143 empty composer", async () => {
      const { manager, spawns } = makeManager({
        adapter: new CodexAdapter({ binary: "fake-codex" }),
      });
      const session = await manager.create({
        cwd: "/tmp/proj",
        harness: "claude-code",
      });

      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[1;1HDo you trust the contents of this directory?\r\n" +
          "\x1b[6;1H1. Yes, continue\r\n\x1b[7;1H2. No, quit\x1b[?2026l",
      );
      await vi.advanceTimersByTimeAsync(6_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      // A diff-rendered modal can repaint only its moved selection rows while
      // retaining the underlying footer. Even without the trust heading in
      // this frame, a single known modal fragment must keep the latch closed.
      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[6;1H  1. Yes, continue\r\n" +
          "\x1b[7;1H› 2. No, quit\r\n" +
          "\x1b[14;1Hgpt-5.5 default · /tmp/proj\x1b[?2026l",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      // Real empty-composer copy captured from Codex 0.143.0 after the user
      // accepted the trust screen. v0.3.3 only recognized the newer "Ask
      // Codex to do anything" copy, so the safety latch never reopened.
      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[10;1H⚠ MCP startup incomplete (failed: notion, render)\r\n" +
          "\x1b[12;1H› Use /skills to list available skills\r\n" +
          "\x1b[14;1Hgpt-5.5 default · /tmp/proj\x1b[?2026l",
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(manager.get(session.id)?.ready).toBe(false);

      // Give the poll loop a generous crossing beyond READY_SETTLE_MS rather
      // than pinning this regression to the exact constant by one millisecond.
      await vi.advanceTimersByTimeAsync(600);
      expect(manager.get(session.id)?.ready).toBe(true);
      expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
    });

    it("retains a blocking screen across partial synchronized diff repaints until the composer is proven", async () => {
      const detectBlockingPrompt = vi.fn(
        (output: string) =>
          output.includes("Sign in with ChatGPT to use Codex") &&
          output.includes("connect an API key for usage-based billing"),
      );
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(detectBlockingPrompt),
      });
      const session = await manager.create({
        cwd: "/tmp/proj",
        harness: "claude-code",
      });

      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[1;1HSign in with ChatGPT to use Codex\r\n" +
          "or connect an API key for usage-based billing\x1b[?2026l",
      );
      // Real Ratatui arrow-key navigation repaints only the changed choice
      // row. Losing the earlier full frame here was the review regression.
      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[8;1H  1. Sign in with ChatGPT\r\n> 2. Sign in with Device Code\x1b[?2026l",
      );

      // Even the liveness ceiling must never override a recognized blocker.
      await vi.advanceTimersByTimeAsync(5_500);
      expect(manager.get(session.id)?.ready).toBe(false);
      expect(detectBlockingPrompt).toHaveBeenCalledWith(
        expect.stringContaining("connect an API key for usage-based billing"),
      );

      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[1;1H› Ask Codex to do anything\r\n\x1b[?2026l",
      );
      await vi.advanceTimersByTimeAsync(850);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("uses a hard ceiling when visible startup animation never leaves a 700ms quiet window", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({
        cwd: "/tmp/proj",
        harness: "claude-code",
      });

      for (let frame = 1; frame <= 12; frame += 1) {
        spawns[0]?.emitData(
          `\x1b[?2026h\x1b[1;1HStarting Codex ${frame}\x1b[?2026l`,
        );
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(manager.get(session.id)?.ready).toBe(false);

      // Only 300ms since the latest visible frame, but more than five seconds
      // since the first: the liveness ceiling now wins.
      await vi.advanceTimersByTimeAsync(300);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("uses the hard ceiling when a clean synchronized repaint never emits its end marker", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({
        cwd: "/tmp/proj",
        harness: "claude-code",
      });
      spawns[0]?.emitData("\x1b[?2026h\x1b[1;1H› Ask Codex to do anything\r\n");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(151);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("does not let the hard ceiling override a blocking repaint missing its end marker", async () => {
      const detectBlockingPrompt = (output: string) =>
        output.includes("Finish signing in via your browser") &&
        output.includes("open the following link to authenticate");
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(detectBlockingPrompt),
      });
      const session = await manager.create({
        cwd: "/tmp/proj",
        harness: "claude-code",
      });
      spawns[0]?.emitData(
        "\x1b[?2026h\x1b[1;1HFinish signing in via your browser\r\n" +
          "open the following link to authenticate\r\n",
      );

      await vi.advanceTimersByTimeAsync(8_000);
      expect(manager.get(session.id)?.ready).toBe(false);
    });

    it("restarts the settle window when later startup output arrives", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("early Codex banner\r\n");

      await vi.advanceTimersByTimeAsync(600);
      spawns[0]?.emitData("later startup frame\r\n");

      // Spawn age has passed the old 700ms threshold, but the latest frame
      // has not been quiet for 700ms yet.
      await vi.advanceTimersByTimeAsync(749);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("waits through a blocking prompt and publishes ready after the user clears it", async () => {
      let showingPrompt = true;
      const detectBlockingPrompt = vi.fn(() => showingPrompt);
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(detectBlockingPrompt),
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("Do you trust the contents of this directory?\r\n");

      // Leave the prompt open beyond the hard ceiling. Clearing it must start
      // a fresh candidate window rather than inheriting an already-expired one.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      // A human answers through raw terminal input; Codex redraws its composer.
      showingPrompt = false;
      spawns[0]?.emitData("\x1b[1;1H› Ask Codex to do anything\r\n");
      await vi.advanceTimersByTimeAsync(749);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(manager.get(session.id)?.ready).toBe(true);
      expect(detectBlockingPrompt).toHaveBeenCalled();
    });

    it("rechecks for a late blocking screen before writing after readiness has latched", async () => {
      let showingPrompt = false;
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(() => showingPrompt),
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("› Ask Codex to do anything\r\n");
      await vi.advanceTimersByTimeAsync(750);
      expect(manager.get(session.id)?.ready).toBe(true);

      showingPrompt = true;
      spawns[0]?.emitData("Sign in with ChatGPT\r\n");
      const submitPromise = manager.submitInput(session.id, "held prompt", true);
      expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

      // `ready` remains the single latched status transition, but injection
      // waits for the adapter's current frame to become safe again.
      expect(manager.get(session.id)?.ready).toBe(true);
      showingPrompt = false;
      spawns[0]?.emitData("› Ask Codex to do anything\r\n");
      await vi.advanceTimersByTimeAsync(1_200);

      expect(await submitPromise).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "held prompt");
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("stops after a real readiness signal and does not broadcast ready twice", async () => {
      const detectBlockingPrompt = vi.fn(() => false);
      const { manager, spawns } = makeManager({
        adapter: immediateAdapter(detectBlockingPrompt),
      });
      const readyStatuses: boolean[] = [];
      manager.onStatusChange((session) => readyStatuses.push(session.ready));
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("› Ask Codex to do anything\r\n");

      await vi.advanceTimersByTimeAsync(300);
      const detectorCallsBeforeSignal = detectBlockingPrompt.mock.calls.length;
      manager.setReady(session.id);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(manager.get(session.id)?.ready).toBe(true);
      expect(readyStatuses.filter(Boolean)).toHaveLength(1);
      expect(detectBlockingPrompt).toHaveBeenCalledTimes(
        detectorCallsBeforeSignal,
      );
    });

    it("stops the old monitor when its pty exits and is replaced on resume", async () => {
      const { manager, spawns } = makeManager({ adapter: immediateAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setAgentSessionId(session.id, "agent-1");
      spawns[0]?.emitData("› old Codex composer\r\n");

      await vi.advanceTimersByTimeAsync(300);
      spawns[0]?.emitExit(0);
      await manager.resume(session.id);
      expect(spawns).toHaveLength(2);

      // The old clean frame must not promote the fresh, still-empty pty.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      spawns[1]?.emitData("› resumed Codex composer\r\n");
      await vi.advanceTimersByTimeAsync(800);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("does not proactively promote a legacy detect-only adapter", async () => {
      const detectBlockingPrompt = vi.fn(() => false);
      const { manager, spawns } = makeManager({
        adapter: createFakeAdapter({ detectBlockingPrompt }),
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("legacy composer\r\n");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      // Its pre-existing request-time compatibility path remains intact.
      const submitPromise = manager.submitInput(session.id, "hello", true);
      await vi.advanceTimersByTimeAsync(500);
      expect(await submitPromise).toBe(true);
      expect(manager.get(session.id)?.ready).toBe(false);
    });
  });

  describe("hook-timeout ready fallback (Claude Code's broken-hook rescue)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const hookTimeoutAdapter = (detect: (scrollback: string) => boolean = () => false) =>
      createFakeAdapter({
        readyFallback: "hook-timeout",
        detectBlockingPrompt: vi.fn(detect),
      });

    it("flips ready ~20s after spawn when the hook never lands and the screen shows no blocking prompt", async () => {
      // The Windows failure this rescues: the SessionStart hook runs `node`
      // through the agent's hook shell; where that resolution breaks, ready
      // never flips and the SPA's held first prompt is dropped after 10min.
      const { manager, spawns } = makeManager({ adapter: hookTimeoutAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("welcome to claude\r\n> ");

      await vi.advanceTimersByTimeAsync(19_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(manager.get(session.id)?.ready).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("marking ready by fallback"));
    });

    it("never fires when the real hook already landed — a healthy machine sees no behavior change", async () => {
      const { manager, spawns } = makeManager({ adapter: hookTimeoutAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("welcome\r\n");
      manager.setReady(session.id);

      await vi.advanceTimersByTimeAsync(25_000);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("keeps waiting while a blocking prompt is on screen — the submit \\r must never answer a trust dialog", async () => {
      let showingPrompt = true;
      const { manager, spawns } = makeManager({ adapter: hookTimeoutAdapter(() => showingPrompt) });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("Do you trust the files in this folder?\r\n");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.get(session.id)?.ready).toBe(false);

      // The user answers the dialog in the terminal; the next poll may flip.
      showingPrompt = false;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(manager.get(session.id)?.ready).toBe(true);
    });

    it("requires SOME output first — a pty that never drew anything is still starting, not hook-broken", async () => {
      const { manager } = makeManager({ adapter: hookTimeoutAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.get(session.id)?.ready).toBe(false);
    });

    it("stops polling once the pty exits", async () => {
      const { manager, spawns } = makeManager({ adapter: hookTimeoutAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("output\r\n");
      spawns[0]?.emitExit(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.get(session.id)?.ready).toBe(false);
      expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("marking ready by fallback"));
    });

    it("is not armed for adapters without a declared fallback", async () => {
      const { manager, spawns } = makeManager({ adapter: createFakeAdapter() });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitData("output\r\n");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.get(session.id)?.ready).toBe(false);
    });
  });

  it("replays the scrollback buffer to new attach()ers and streams live data", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    spawns[0]?.emitData("hello ");
    spawns[0]?.emitData("world");

    const received: string[] = [];
    const detach = manager.attach(session.id, (chunk) => received.push(chunk));
    expect(received).toEqual(["hello world"]);

    spawns[0]?.emitData("!");
    expect(received).toEqual(["hello world", "!"]);

    detach?.();
    spawns[0]?.emitData("ignored");
    expect(received).toEqual(["hello world", "!"]);
  });

  describe("onActivity", () => {
    it("broadcasts once immediately, then throttles further data within the window", async () => {
      vi.useFakeTimers();
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const activity: string[] = [];
      manager.onActivity((id) => activity.push(id));

      spawns[0]?.emitData("hello");
      expect(activity).toEqual([session.id]);

      // Still within the 2s throttle window — no second broadcast yet.
      spawns[0]?.emitData("more");
      await vi.advanceTimersByTimeAsync(1_000);
      spawns[0]?.emitData("even more");
      expect(activity).toEqual([session.id]);

      // Past the window — the next chunk broadcasts again.
      await vi.advanceTimersByTimeAsync(1_100);
      spawns[0]?.emitData("after the window");
      expect(activity).toEqual([session.id, session.id]);

      vi.useRealTimers();
    });

    it("broadcasts independently per session", async () => {
      const { manager, spawns } = makeManager();
      const a = await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
      const b = await manager.create({ cwd: "/tmp/b", harness: "claude-code" });

      const activity: string[] = [];
      manager.onActivity((id) => activity.push(id));

      spawns[0]?.emitData("from a");
      spawns[1]?.emitData("from b");

      expect(activity).toEqual([a.id, b.id]);
    });

    it("stops notifying an unsubscribed listener", async () => {
      const { manager, spawns } = makeManager();
      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const activity: string[] = [];
      const unsubscribe = manager.onActivity((id) => activity.push(id));
      unsubscribe();

      spawns[0]?.emitData("hello");
      expect(activity).toEqual([]);
    });
  });

  it("marks a session exited when its pty exits, and notifies status listeners", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    const statuses: HarnessSession["status"][] = [];
    manager.onStatusChange((s) => {
      if (s.id === session.id) statuses.push(s.status);
    });

    spawns[0]?.emitExit(1);

    expect(manager.get(session.id)?.status).toBe("exited");
    expect(manager.get(session.id)?.exitCode).toBe(1);
    expect(statuses).toEqual(["exited"]);
  });

  it("kill() signals the pty for a running session and returns a Promise resolving true; returns Promise<false> otherwise", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    // kill() now returns Promise<boolean> — fire-and-forget still works via void,
    // but here we confirm the resolved value and that the signal was sent.
    const killResult = manager.kill(session.id);
    expect(killResult).toBeInstanceOf(Promise);
    expect(spawns[0]?.pty.kill).toHaveBeenCalled();

    // Let the exit propagate so the promise resolves.
    spawns[0]?.emitExit(0);
    expect(await killResult).toBe(true);

    // Unknown session: resolves false immediately.
    expect(await manager.kill("unknown-id")).toBe(false);
  });

  it("killAll() signals every currently-live pty and resolves when all exit", async () => {
    const { manager, spawns } = makeManager();
    const a = await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
    const b = await manager.create({ cwd: "/tmp/b", harness: "claude-code" });
    spawns[0]?.emitExit(0); // a exits on its own before killAll() runs

    // Drive the exit event on b so killAll() can resolve.
    const killAllPromise = manager.killAll();
    spawns[1]?.emitExit(0);
    await killAllPromise;

    expect(spawns[0]?.pty.kill).not.toHaveBeenCalled(); // already gone — nothing to signal
    expect(spawns[1]?.pty.kill).toHaveBeenCalled();
    expect(manager.get(a.id)?.status).toBe("exited");
    void b;
  });

  it("killAll() is a harmless no-op with no live sessions", async () => {
    const { manager } = makeManager();
    await expect(manager.killAll()).resolves.toBeUndefined();
  });

  it("resume() requires a known agentSessionId and respawns via adapter.resume", async () => {
    const { manager, adapter, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    await expect(manager.resume(session.id)).rejects.toThrow(/no agentSessionId/);

    manager.setAgentSessionId(session.id, "agent-uuid-1");
    spawns[0]?.emitExit(0);
    expect(manager.get(session.id)?.status).toBe("exited");

    const resumed = await manager.resume(session.id);
    expect(adapter.resume).toHaveBeenCalledWith(
      "agent-uuid-1",
      expect.objectContaining({ harnessSessionId: session.id, cwd: "/tmp/proj" }),
    );
    expect(resumed.status).toBe("running");
    expect(resumed.id).toBe(session.id);

    await expect(manager.resume("does-not-exist")).rejects.toThrow(/Unknown session/);
  });

  it("awaits an async buildLaunchOpts and merges its result into launch opts", async () => {
    const buildLaunchOpts = vi.fn(async (harnessSessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { settingsFile: `/generated/${harnessSessionId}/settings.json` };
    });
    const { manager, adapter } = makeManager({ buildLaunchOpts });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(buildLaunchOpts).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ cwd: "/tmp/proj", harness: "claude-code" }),
    );
    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({ settingsFile: `/generated/${session.id}/settings.json` }),
    );
  });

  it("also awaits an async buildLaunchOpts on resume()", async () => {
    const buildLaunchOpts = vi.fn(async (harnessSessionId: string) => ({
      mcpConfigFile: `/generated/${harnessSessionId}/mcp-config.json`,
    }));
    const { manager, adapter, spawns } = makeManager({ buildLaunchOpts });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    manager.setAgentSessionId(session.id, "agent-uuid-1");
    spawns[0]?.emitExit(0);

    await manager.resume(session.id);

    expect(adapter.resume).toHaveBeenLastCalledWith(
      "agent-uuid-1",
      expect.objectContaining({ mcpConfigFile: `/generated/${session.id}/mcp-config.json` }),
    );
  });

  it("registerHistorical() creates an exited placeholder session resumable later", async () => {
    const { manager } = makeManager();
    const session = manager.registerHistorical({
      agentSessionId: "agent-uuid-9",
      harness: "claude-code",
      cwd: "/tmp/proj",
      title: "past session",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });

    expect(session.status).toBe("exited");
    expect(session.agentSessionId).toBe("agent-uuid-9");

    const resumed = await manager.resume(session.id);
    expect(resumed.status).toBe("running");
  });

  describe("resume() resumability pre-flight", () => {
    /** A session record that looks perfectly resumable — status exited, an
     *  agentSessionId captured from the SessionStart hook — which is exactly
     *  the phantom shape: 16 of 49 real registry entries on the dev machine
     *  measured this way (SAP-2057 first reported 15 of 46), and
     *  every one of them was a Resume button guaranteed to fail. */
    function registerPhantom(manager: SessionManager) {
      return manager.registerHistorical({
        agentSessionId: "agent-uuid-phantom",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "never prompted",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
    }

    it("throws SessionNotResumeableError instead of spawning when the agent no longer holds the conversation", async () => {
      const adapter = createFakeAdapter({ canResume: vi.fn(async () => false) });
      const { manager, spawns } = makeManager({ adapter });
      const session = registerPhantom(manager);

      await expect(manager.resume(session.id)).rejects.toThrow(SessionNotResumeableError);
      // The point of the pre-flight: no doomed pty. Previously this spawned
      // `claude --resume <id>`, which exited 1 with "No conversation found".
      expect(spawns).toHaveLength(0);
      expect(adapter.resume).not.toHaveBeenCalled();
    });

    it("names the agent and the reason so the 409 tells the user WHY", async () => {
      const adapter = createFakeAdapter({ canResume: vi.fn(async () => false) });
      const { manager } = makeManager({ adapter });
      const session = registerPhantom(manager);

      await expect(manager.resume(session.id)).rejects.toMatchObject({
        code: "SESSION_NOT_RESUMEABLE",
        message: expect.stringContaining("Claude Code"),
      });
      await expect(manager.resume(session.id)).rejects.toThrow(
        /before their first prompt are never written to the coding agent's history/,
      );
    });

    it("probes the agent's store with the session's own agentSessionId and cwd", async () => {
      const canResume = vi.fn(async () => true);
      const { manager } = makeManager({ adapter: createFakeAdapter({ canResume }) });
      const session = registerPhantom(manager);

      await manager.resume(session.id);

      expect(canResume).toHaveBeenCalledWith("agent-uuid-phantom", "/tmp/proj");
    });

    it("leaves a rejected session's record untouched — still exited, same lastActiveAt", async () => {
      const { manager } = makeManager({ adapter: createFakeAdapter({ canResume: vi.fn(async () => false) }) });
      const session = registerPhantom(manager);

      await expect(manager.resume(session.id)).rejects.toThrow(SessionNotResumeableError);

      const after = manager.get(session.id);
      expect(after?.status).toBe("exited");
      // The duration bug: stamping lastActiveAt here made a session idle since
      // last night report "Ran for 6h 25m" purely because someone clicked Resume.
      expect(after?.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("rolls lastActiveAt back when the resume passes pre-flight but dies before a live pty", async () => {
      const { manager } = makeManager({
        adapter: createFakeAdapter({ canResume: vi.fn(async () => true) }),
        spawnPty: () => {
          throw new Error("node-pty exploded");
        },
      });
      const session = registerPhantom(manager);

      await expect(manager.resume(session.id)).rejects.toThrow("node-pty exploded");

      const after = manager.get(session.id);
      expect(after?.status).toBe("exited");
      // No pty ever ran, so the session's last real activity is unchanged —
      // "we noticed it's dead" is not activity.
      expect(after?.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("still short-circuits on a missing agentSessionId without probing the adapter", async () => {
      const canResume = vi.fn(async () => true);
      const { manager } = makeManager({ adapter: createFakeAdapter({ canResume }) });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      await manager.kill(session.id);

      await expect(manager.resume(session.id)).rejects.toThrow(SessionNotResumeableError);
      expect(canResume).not.toHaveBeenCalled();
    });
  });

  it("new sessions start with boundWorkflowPath: null", async () => {
    const { manager } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    expect(session.boundWorkflowPath).toBeNull();
    expect(manager.get(session.id)?.boundWorkflowPath).toBeNull();
  });

  describe("harness-context.json wiring", () => {
    it("create() writes the initial workspace context for every session, regardless of caller", async () => {
      const writeWorkspaceContext = vi.fn(async () => {});
      const { manager } = makeManager({ writeWorkspaceContext });

      // No REST layer involved at all here — this is exactly the
      // autoCreateSession call shape (server/index.ts calling
      // sessionManager.create() directly), the entry point that used to skip
      // the write entirely because it lived in the REST handler instead.
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      expect(writeWorkspaceContext).toHaveBeenCalledTimes(1);
      expect(writeWorkspaceContext).toHaveBeenCalledWith(session);
    });

    it("create() writes the workspace context before the pty is actually spawned", async () => {
      const order: string[] = [];
      const writeWorkspaceContext = vi.fn(async () => {
        order.push("write");
      });
      const spawnPty: PtySpawnFn = (file, args) => {
        order.push("spawn");
        void file;
        void args;
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ writeWorkspaceContext, spawnPty });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // The agent's very first read of HARNESS_CONTEXT_FILE must never race
      // session creation with an ENOENT — that only holds if the write is
      // fully awaited before the real process (the pty) ever starts.
      expect(order).toEqual(["write", "spawn"]);
    });

    it("create() surfaces a writeWorkspaceContext rejection and reconciles the record to exited", async () => {
      const writeWorkspaceContext = vi.fn(async () => {
        throw new Error("disk full");
      });
      const { manager } = makeManager({ writeWorkspaceContext });

      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).rejects.toThrow("disk full");
      // The record was persisted as "starting" before the failing write — it
      // must not stay that way (a non-exited record with no pty behind it
      // renders as a ghost tab forever).
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0]?.status).toBe("exited");
    });

    it("resume() always awaits schema-aware context preparation before spawning", async () => {
      const order: string[] = [];
      const buildLaunchOpts = vi.fn(async () => {
        order.push("prompt");
        return {};
      });
      const prepareWorkspaceContext = vi.fn(async () => {
        order.push("prepare");
      });
      const spawnPty: PtySpawnFn = (file, args) => {
        order.push("spawn");
        void file;
        void args;
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ buildLaunchOpts, prepareWorkspaceContext, spawnPty });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await manager.resume(session.id);

      expect(prepareWorkspaceContext).toHaveBeenCalledTimes(1);
      expect(prepareWorkspaceContext).toHaveBeenCalledWith(manager.get(session.id));
      expect(order).toEqual(["prompt", "prepare", "spawn"]);
    });

    it("resume() refuses to spawn when context preparation cannot make the prompt schema safe", async () => {
      const prepareWorkspaceContext = vi.fn(async () => {
        throw new Error("context path unreadable");
      });
      const { manager, spawns } = makeManager({ prepareWorkspaceContext });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });

      await expect(manager.resume(session.id)).rejects.toThrow("context path unreadable");

      expect(spawns).toHaveLength(0);
      expect(manager.get(session.id)).toMatchObject({
        status: "exited",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("defaults to a no-op for both hooks so tests with fake cwds never touch the real filesystem", async () => {
      // makeManager() with no overrides exercises the SessionManagerOptions
      // defaults directly against a fake cwd ("/tmp/proj") that this test
      // never creates on disk. If the defaults silently did real fs I/O
      // instead of no-op'ing, this would either throw (ENOENT under a path
      // that doesn't exist) or leave a real .sapiom dir behind on the test
      // runner's machine — neither happens, proving both defaults are inert.
      const { manager } = makeManager();
      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).resolves.toBeDefined();

      const historical = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(manager.resume(historical.id)).resolves.toBeDefined();
    });
  });

  describe("canvas template wiring", () => {
    it("create() drops the canvas template for every session, regardless of caller", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {});
      const { manager } = makeManager({ ensureCanvasTemplate });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      expect(ensureCanvasTemplate).toHaveBeenCalledTimes(1);
      expect(ensureCanvasTemplate).toHaveBeenCalledWith("/tmp/proj");
    });

    it("create() ensures the canvas template before the pty is actually spawned", async () => {
      const order: string[] = [];
      const ensureCanvasTemplate = vi.fn(async () => {
        order.push("canvas");
      });
      const spawnPty: PtySpawnFn = (file, args) => {
        order.push("spawn");
        void file;
        void args;
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ ensureCanvasTemplate, spawnPty });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // Same reasoning as writeWorkspaceContext: the canvas pane can open the
      // moment the session reports "running", so the template must already
      // be on disk before the real process (the pty) ever starts.
      expect(order).toEqual(["canvas", "spawn"]);
    });

    it("resume() also ensures the canvas template — the function itself is the backfill check", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {});
      const { manager } = makeManager({ ensureCanvasTemplate });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      ensureCanvasTemplate.mockClear(); // registerHistorical() doesn't call it; isolate resume()'s call

      await manager.resume(session.id);

      expect(ensureCanvasTemplate).toHaveBeenCalledWith("/tmp/proj");
    });

    it("defaults to a no-op so tests with fake cwds never touch the real filesystem", async () => {
      const { manager } = makeManager();
      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).resolves.toBeDefined();
    });
  });

  describe("ghost-session reconciliation (non-exited records with no live pty)", () => {
    it("create() reconciles the record to exited when ensureCanvasTemplate rejects", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {
        throw new Error("read-only fs");
      });
      const { manager } = makeManager({ ensureCanvasTemplate });

      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).rejects.toThrow("read-only fs");
      expect(manager.list()[0]?.status).toBe("exited");
    });

    it("create() reconciles the record to exited when the pty spawn itself throws", async () => {
      const spawnPty: PtySpawnFn = () => {
        throw new Error("posix_spawnp failed");
      };
      const { manager } = makeManager({ spawnPty });
      const statuses: string[] = [];
      manager.onStatusChange((s) => statuses.push(s.status));

      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).rejects.toThrow(
        "posix_spawnp failed",
      );
      expect(manager.list()[0]?.status).toBe("exited");
      expect(statuses).toContain("exited");

      // The reconciliation must be durable, not just in-memory — a persisted
      // "starting" record would still ghost after the SPA refetches state.
      await manager.flush();
      const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
      expect(raw[0]?.status).toBe("exited");
    });

    it("resume() reconciles the record back to exited when a pre-spawn step rejects", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {
        throw new Error("read-only fs");
      });
      const { manager } = makeManager({ ensureCanvasTemplate });
      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });

      await expect(manager.resume(session.id)).rejects.toThrow("read-only fs");
      // resume() flipped it to "starting" and persisted before failing — it
      // must land back on "exited", not stay stranded mid-transition.
      expect(manager.get(session.id)?.status).toBe("exited");
    });

    it("kill() transitions a stale non-exited record with no pty to exited instead of failing", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      spawns[0]?.emitExit(0);
      // Simulate the ghost state directly (the transitions that used to
      // produce it are all reconciled now): a record stuck non-exited whose
      // pty handle is long gone.
      const record = manager.get(session.id)!;
      record.status = "running";

      const statuses: string[] = [];
      manager.onStatusChange((s) => statuses.push(s.status));
      // kill() now returns Promise<boolean>; the ghost path resolves immediately.
      expect(await manager.kill(session.id)).toBe(true);
      expect(manager.get(session.id)?.status).toBe("exited");
      expect(statuses).toEqual(["exited"]);

      // A genuinely exited record is still a no-op false, as before.
      expect(await manager.kill(session.id)).toBe(false);
      expect(await manager.kill("unknown-id")).toBe(false);
    });

    describe("sweepDeadSessions", () => {
      it("synthesizes an exit for a running session whose process died without onExit ever firing", async () => {
        // The node-pty missed-exit bug (see kill()'s fallback), but for a
        // process that died on its own — no kill() call means no fallback
        // was ever armed, which is exactly what the sweep exists to catch.
        const { manager } = makeManager({ fakePid: 4242, isPidAlive: () => false });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        expect(session.status).toBe("running");

        const statuses: string[] = [];
        manager.onStatusChange((s) => statuses.push(s.status));
        manager.sweepDeadSessions();

        expect(manager.get(session.id)?.status).toBe("exited");
        expect(manager.get(session.id)?.exitCode).toBeNull();
        expect(statuses).toEqual(["exited"]);
        // The dead handle is fully released, same as a real onExit.
        expect(manager.attach(session.id, () => {})).toBeUndefined();

        await manager.flush();
        const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
        expect(raw[0]?.status).toBe("exited");
      });

      it("leaves sessions whose process is alive untouched", async () => {
        const { manager } = makeManager({ fakePid: 4242, isPidAlive: () => true });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        manager.sweepDeadSessions();

        expect(manager.get(session.id)?.status).toBe("running");
      });

      it("never probes a pty without a numeric pid, and never declares it dead", async () => {
        const isPidAlive = vi.fn(() => false);
        const { manager } = makeManager({ isPidAlive }); // fake pty with pid: undefined
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        manager.sweepDeadSessions();

        expect(isPidAlive).not.toHaveBeenCalled();
        expect(manager.get(session.id)?.status).toBe("running");
      });

      it("reconciles a non-exited record with no pty only after it outlives the grace window", async () => {
        const { manager, spawns } = makeManager();
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
        spawns[0]?.emitExit(0);
        const record = manager.get(session.id)!;
        record.status = "starting"; // simulate the stale mid-transition ghost

        // Fresh record (lastActiveAt just now): could be a create()/resume()
        // still inside its legitimate pre-spawn window — hands off.
        record.lastActiveAt = new Date().toISOString();
        manager.sweepDeadSessions();
        expect(manager.get(session.id)?.status).toBe("starting");

        // Same record well past any plausible spawn window: dead, reconcile.
        record.lastActiveAt = new Date(Date.now() - 60_000).toISOString();
        manager.sweepDeadSessions();
        expect(manager.get(session.id)?.status).toBe("exited");
      });
    });
  });

  describe("setBoundWorkflowPath", () => {
    it("updates the in-memory session, persists it, and notifies status listeners", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();

      expect(manager.get(session.id)?.boundWorkflowPath).toBe("/tmp/leasing");
      expect(statuses).toEqual(["/tmp/leasing"]);

      const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
      expect(raw.find((s) => s.id === session.id)?.boundWorkflowPath).toBe("/tmp/leasing");
    });

    it("unbinds with null, persisting and notifying again", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, null);
      await manager.flush();

      expect(manager.get(session.id)?.boundWorkflowPath).toBeNull();
      expect(statuses).toEqual([null]);
    });

    it("is a no-op (doesn't throw, doesn't notify) for an unknown session id", async () => {
      const { manager } = makeManager();
      const statuses: string[] = [];
      manager.onStatusChange(() => statuses.push("fired"));

      expect(() => manager.setBoundWorkflowPath("does-not-exist", "/tmp/leasing")).not.toThrow();
      await manager.flush();
      expect(statuses).toEqual([]);
    });

    it("is a no-op when rebinding to the already-current value (no redundant persist/notify)", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();
      expect(statuses).toEqual([]);
    });
  });

  it("injects the contract's ENV.* variables into the spawned process env", async () => {
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const spawnPty: PtySpawnFn = (_file, _args, options) => {
      capturedEnvs.push(options.env ?? {});
      const fake = createFakePty();
      return fake.pty as unknown as ReturnType<PtySpawnFn>;
    };
    const { manager } = makeManager({ spawnPty });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    const env = capturedEnvs[0];
    expect(env?.["SAPIOM_HARNESS_INGEST_URL"]).toBe("http://127.0.0.1:4100/ingest");
    expect(env?.["SAPIOM_HARNESS_INGEST_TOKEN"]).toBe("boot-token");
    expect(env?.["SAPIOM_HARNESS_SESSION_ID"]).toBe(session.id);
  });

  it("owns a colour-capable PTY environment instead of inheriting launcher suppression", async () => {
    const previous = {
      NO_COLOR: process.env.NO_COLOR,
      FORCE_COLOR: process.env.FORCE_COLOR,
      TERM: process.env.TERM,
      COLORTERM: process.env.COLORTERM,
    };
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
    process.env.TERM = "dumb";
    process.env.COLORTERM = "";

    try {
      const capturedEnvs: Record<string, string | undefined>[] = [];
      const spawnPty: PtySpawnFn = (_file, _args, options) => {
        capturedEnvs.push(options.env ?? {});
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ spawnPty });
      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      expect(capturedEnvs[0]?.NO_COLOR).toBeUndefined();
      expect(capturedEnvs[0]?.FORCE_COLOR).toBeUndefined();
      expect(capturedEnvs[0]?.TERM).toBe("xterm-256color");
      expect(capturedEnvs[0]?.COLORTERM).toBe("truecolor");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("unsets env vars the adapter's SpawnSpec maps to null", async () => {
    process.env["HARNESS_TEST_UNSET_ME"] = "should-be-removed";
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const adapter = createFakeAdapter({
      launch: vi.fn(
        (opts): SpawnSpec => ({
          command: "fake-claude",
          args: [],
          env: { HARNESS_TEST_UNSET_ME: null },
          cwd: opts.cwd,
        }),
      ),
    });
    const spawnPty: PtySpawnFn = (_file, _args, options) => {
      capturedEnvs.push(options.env ?? {});
      const fake = createFakePty();
      return fake.pty as unknown as ReturnType<PtySpawnFn>;
    };
    const { manager } = makeManager({ adapter, spawnPty });
    await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(capturedEnvs[0]?.["HARNESS_TEST_UNSET_ME"]).toBeUndefined();
    delete process.env["HARNESS_TEST_UNSET_ME"];
  });

  /**
   * The desktop host pins `ESBUILD_BINARY_PATH` at an esbuild binary outside
   * app.asar, because it cannot exec one from inside the archive. That pin must
   * not reach the agent: this loop copies the WHOLE parent environment into the
   * pty, so the agent — and everything the agent spawns in the user's own repo —
   * inherited a pin to OUR esbuild build. Any project on a different esbuild
   * version (vite, vitest, tsup, tsx, astro…) then dies with
   * `Cannot start service: Host version "0.25.12" does not match binary version
   * "0.28.1"` on a project that builds fine outside the app.
   */
  it("never leaks the host's ESBUILD_BINARY_PATH pin into the agent's environment", async () => {
    process.env["ESBUILD_BINARY_PATH"] = "/app/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild";
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const spawnPty: PtySpawnFn = (_file, _args, options) => {
      capturedEnvs.push(options.env ?? {});
      const fake = createFakePty();
      return fake.pty as unknown as ReturnType<PtySpawnFn>;
    };
    const { manager } = makeManager({ spawnPty });
    await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(capturedEnvs[0]?.["ESBUILD_BINARY_PATH"]).toBeUndefined();
    // Everything else still comes through — this is a targeted strip, not a
    // switch to a clean environment (the agent needs PATH, HOME, the lot).
    expect(capturedEnvs[0]?.["PATH"]).toBe(process.env["PATH"]);
    delete process.env["ESBUILD_BINARY_PATH"];
  });

  describe("awaitable kill — liveness-fallback resolution", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("REGRESSION: kill() resolves via the synthesis/liveness path when node-pty's onExit never fires (missed-exit bug)", async () => {
      // Simulate the node-pty missed-exit bug: the pty's kill() is called
      // but its onExit listeners are never invoked — the OS process is gone
      // (isPidAlive returns false) but the event never arrives. kill() must
      // still resolve within the escalation window via the synthesized exit.
      let pidAlive = true;
      const { manager, spawns } = makeManager({
        fakePid: 9999,
        isPidAlive: () => pidAlive,
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      expect(session.status).toBe("running");

      // Confirm the pty exists and won't emit onExit on its own — the exit
      // listeners on the fake pty exist, but we never call emitExit().
      expect(spawns[0]?.pty.kill).not.toHaveBeenCalled();

      const killPromise = manager.kill(session.id);
      // kill() sent SIGTERM (the initial pty.kill() with no signal arg).
      expect(spawns[0]?.pty.kill).toHaveBeenCalledTimes(1);

      // The process is now "dead" at the OS level but node-pty hasn't fired.
      pidAlive = false;

      // Advance past KILL_ESCALATION_MS (2000ms): the escalation fires and
      // checks isPidAlive. Since the process is already dead, it skips SIGKILL
      // and schedules the KILL_ESCALATION_CONFIRM_MS (500ms) confirm window.
      await vi.advanceTimersByTimeAsync(2_000);

      // Advance past KILL_ESCALATION_CONFIRM_MS: the confirm fires, sees
      // isPidAlive=false, and calls markExited() → resolves handle.exited.
      await vi.advanceTimersByTimeAsync(500);

      // The promise must now be resolved — await it to confirm.
      expect(await killPromise).toBe(true);
      expect(manager.get(session.id)?.status).toBe("exited");
    });

    it("kill() resolves immediately via real onExit when node-pty fires before the escalation window", async () => {
      const { manager, spawns } = makeManager({ fakePid: 8888, isPidAlive: () => false });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const killPromise = manager.kill(session.id);
      // Drive the real onExit — this fires before the escalation timer.
      spawns[0]?.emitExit(0);

      // Promise should resolve immediately (the real path, not the synthesis path).
      expect(await killPromise).toBe(true);
      expect(manager.get(session.id)?.status).toBe("exited");
      expect(manager.get(session.id)?.exitCode).toBe(0);
    });

    it("kill() escalates to SIGKILL when the process survives SIGTERM, then resolves once it dies", async () => {
      // Process ignores SIGTERM (stubborn process), but dies after SIGKILL.
      let pidAlive = true;
      const { manager, spawns } = makeManager({
        fakePid: 7777,
        isPidAlive: () => pidAlive,
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const killPromise = manager.kill(session.id);
      expect(spawns[0]?.pty.kill).toHaveBeenCalledTimes(1); // initial SIGTERM (no arg)

      // Advance to KILL_ESCALATION_MS: process is still alive → SIGKILL sent.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(spawns[0]?.pty.kill).toHaveBeenCalledTimes(2); // SIGKILL
      expect(spawns[0]?.pty.kill).toHaveBeenLastCalledWith("SIGKILL");

      // Now the process dies (SIGKILL lands) — simulate via emitExit.
      pidAlive = false;
      spawns[0]?.emitExit(137); // SIGKILL exit code

      expect(await killPromise).toBe(true);
      expect(manager.get(session.id)?.exitCode).toBe(137);
    });

    it("killAll() resolves once all sessions are confirmed dead, even when exits come at different times", async () => {
      const { manager, spawns } = makeManager({ fakePid: 6666, isPidAlive: () => false });
      const a = await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
      const b = await manager.create({ cwd: "/tmp/b", harness: "claude-code" });

      const killAllPromise = manager.killAll();
      let resolved = false;
      void killAllPromise.then(() => {
        resolved = true;
      });

      // Neither has exited yet — killAll() should not be resolved.
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // First session exits.
      spawns[0]?.emitExit(0);
      await vi.advanceTimersByTimeAsync(0);
      // Second session still alive — not resolved yet.
      expect(resolved).toBe(false);

      // Second session exits.
      spawns[1]?.emitExit(0);
      await killAllPromise;
      expect(resolved).toBe(true);
      expect(manager.get(a.id)?.status).toBe("exited");
      expect(manager.get(b.id)?.status).toBe("exited");
    });

    it("killAll() resolves via liveness synthesis when node-pty misses exits for all sessions", async () => {
      // Both ptys swallow their onExit events — killAll() must still resolve
      // via the missed-exit synthesis path within the escalation window.
      let pidAlive = true;
      const { manager } = makeManager({ fakePid: 5555, isPidAlive: () => pidAlive });
      await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
      await manager.create({ cwd: "/tmp/b", harness: "claude-code" });

      const killAllPromise = manager.killAll();
      let resolved = false;
      void killAllPromise.then(() => {
        resolved = true;
      });

      // Mark the OS processes as gone — liveness check will confirm this.
      pidAlive = false;

      // Advance past the full escalation window.
      await vi.advanceTimersByTimeAsync(2_000 + 500);

      await killAllPromise;
      expect(resolved).toBe(true);
    });

    it("REGRESSION: kill() resolves unconditionally in the confirm window even when isPidAlive stays true (EPERM zombie after SIGKILL)", async () => {
      // An EPERM zombie: process.kill(pid, 0) still returns true (EPERM means
      // "exists but can't be signalled") even after SIGKILL. The old confirm-
      // timer guarded on `!isPidAlive(pid)` — that would leave handle.exited
      // pending forever. The fixed confirm callback synthesizes markExited()
      // unconditionally (SIGKILL was already sent; the session is over).
      const { manager, spawns } = makeManager({
        fakePid: 4444,
        // Always "alive" — simulates an EPERM zombie that survives all probes.
        isPidAlive: () => true,
      });
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const killPromise = manager.kill(session.id);
      // Initial signal sent.
      expect(spawns[0]?.pty.kill).toHaveBeenCalledTimes(1);

      // Advance past KILL_ESCALATION_MS: isPidAlive returns true → SIGKILL sent.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(spawns[0]?.pty.kill).toHaveBeenCalledTimes(2);
      expect(spawns[0]?.pty.kill).toHaveBeenLastCalledWith("SIGKILL");

      // Advance past KILL_ESCALATION_CONFIRM_MS: the confirm callback fires.
      // isPidAlive is still true (zombie) but the fix synthesizes unconditionally.
      await vi.advanceTimersByTimeAsync(500);

      expect(await killPromise).toBe(true);
      expect(manager.get(session.id)?.status).toBe("exited");
    });
  });

  describe("ExternalHarnessError — real-path (no mocks)", () => {
    /**
     * A sessions.json entry with harness="conductor" can appear via an earlier
     * build, a hand-edited file, or a future import. These tests verify the
     * real production code path: when getAdapter() / submitInput() encounter
     * an external-mode harness id they surface HARNESS_EXTERNAL (409) rather
     * than AdapterNotFoundError or a silent false.
     *
     * We cast "conductor" as HarnessKind in registerHistorical() to simulate
     * a persisted record that predates the typed enum.
     */

    it("resume() throws ExternalHarnessError for a session persisted with harness='conductor'", async () => {
      const { manager } = makeManager();

      // Simulate a session record that arrived from disk or an earlier build.
      const session = manager.registerHistorical({
        agentSessionId: "agent-session-abc",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      await expect(manager.resume(session.id)).rejects.toThrow(ExternalHarnessError);
    });

    it("resume() ExternalHarnessError has code HARNESS_EXTERNAL and names the harness label", async () => {
      const { manager } = makeManager();

      const session = manager.registerHistorical({
        agentSessionId: "agent-session-def",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      let caught: unknown;
      try {
        await manager.resume(session.id);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ExternalHarnessError);
      const err = caught as ExternalHarnessError;
      expect(err.code).toBe("HARNESS_EXTERNAL");
      expect(err.message).toMatch(/Conductor/);
      expect(err.harness).toBe("conductor");
    });

    it("submitInput() throws ExternalHarnessError for a session with harness='conductor' and no live pty", async () => {
      const { manager } = makeManager();

      const session = manager.registerHistorical({
        agentSessionId: "agent-session-ghi",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      await expect(manager.submitInput(session.id, "hello")).rejects.toThrow(ExternalHarnessError);
    });

    it("submitInput() ExternalHarnessError has code HARNESS_EXTERNAL", async () => {
      const { manager } = makeManager();

      const session = manager.registerHistorical({
        agentSessionId: "agent-session-jkl",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      let caught: unknown;
      try {
        await manager.submitInput(session.id, "test input");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ExternalHarnessError);
      expect((caught as ExternalHarnessError).code).toBe("HARNESS_EXTERNAL");
    });
  });
});
