/**
 * Wiring-level proof of portable continue (SAP-2059): a `rehydrate` history
 * row starts a FRESH session that knows what the previous one was doing,
 * without any vendor transcript being involved.
 *
 * Deliberately end-to-end through the real server: the units are covered in
 * core/resume-brief.test.ts and core/rehydration.test.ts, and what those
 * cannot show is that the brief actually reaches the file the adapter reads.
 * The assertions run against `<generated>/<id>/system-prompt.txt` — the exact
 * bytes claude-code passes to `--append-system-prompt` and codex inlines as
 * `developer_instructions` — which is why the same test body runs for both
 * harnesses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type HarnessServer } from "./index.js";
import { DEFAULT_SYSTEM_PROMPT } from "../profiles/default.js";
import { rollingSummaryPath } from "../core/rolling-summary.js";
import type {
  AnalyticsEvent,
  AnalyticsEventType,
  HarnessAdapter,
  HarnessKind,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";

const PRIOR_SESSION = "prior-harness-session";
const PRIOR_AGENT_SESSION = "prior-agent-session";

/** An adapter shaped like the real one for `harness`, spawning bash so the pty
 *  is real and killable. Declares `launch-flag` exactly as both shipped
 *  adapters do, so the delivery channel under test is the production one. */
function fakeAdapter(harness: HarnessKind): HarnessAdapter {
  const spec = (opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd });
  return {
    id: harness,
    eventSource: harness === "codex" ? "transcript-tail" : "hooks",
    systemPromptDelivery: "launch-flag",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId, opts) => spec(opts),
    listPastSessions: async () => [
      {
        agentSessionId: PRIOR_AGENT_SESSION,
        harness,
        cwd: "",
        title: "Retry backoff",
        lastActiveAt: "2026-07-27T11:00:00.000Z",
        source: "transcript" as const,
        gitBranch: "feat/SAP-2059",
      },
    ],
    canResume: async () => false,
  };
}

describe("portable continue — rehydrating a fresh session", () => {
  let dir: string;
  let generatedRoot: string;
  let cwd: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-rehydrate-"));
    generatedRoot = join(dir, "generated");
    cwd = join(dir, "project");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    // Retried: a session's exit-time `removeGeneratedSessionDir` is
    // fire-and-forget, so it can still be deleting inside `generated/` while
    // this tears the whole scratch root down (ENOTEMPTY).
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** Seed events.ndjson with a prior session the harness recorded itself —
   *  the whole point being that no vendor transcript exists for it. */
  async function seedPriorSession(harness: HarnessKind): Promise<void> {
    const base = {
      seq: 1,
      userId: null,
      tenantId: null,
      machineId: "machine-1",
      harnessSessionId: PRIOR_SESSION,
      agentSessionId: PRIOR_AGENT_SESSION,
      harness,
    };
    const at = (minutes: number): string =>
      `2026-07-27T10:${String(minutes).padStart(2, "0")}:00.000Z`;
    const event = (
      n: number,
      type: AnalyticsEventType,
      payload: Record<string, unknown>,
    ): AnalyticsEvent => ({ ...base, eventId: `event-${n}`, seq: n, ts: at(n), type, payload });

    const events: AnalyticsEvent[] = [
      event(1, "session.start", { source: "startup", cwd }),
      event(2, "prompt.submitted", { prompt: "make the retry backoff jittered" }),
      event(3, "tool.call", {
        toolName: "Edit",
        toolInput: JSON.stringify({ file_path: join(cwd, "src/retry.ts") }),
        toolResponseSummary: "ok",
      }),
      event(4, "tool.call", {
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "pnpm build" }),
        toolResponseSummary: "built",
      }),
      event(5, "turn.completed", { assistantText: "Jitter is in; the tests still need updating." }),
      event(6, "session.end", { reason: "exit" }),
    ];
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  async function boot(harness: HarnessKind): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { [harness]: fakeAdapter(harness) },
      stateRoot: dir,
    });
  }

  async function systemPrompt(harnessSessionId: string): Promise<string> {
    return readFile(join(generatedRoot, harnessSessionId, "system-prompt.txt"), "utf8");
  }

  // The acceptance criterion "same code path works for claude-code and codex"
  // is the reason this is a table rather than one case: nothing in the body
  // differs per harness, which is exactly the claim.
  for (const harness of ["claude-code", "codex"] as const) {
    describe(harness, () => {
      it("seeds a fresh session with what the prior one was doing", async () => {
        await seedPriorSession(harness);
        server = await boot(harness);

        const session = await server.sessionManager.create({
          cwd,
          harness,
          rehydrateFrom: PRIOR_SESSION,
        });
        expect(session.rehydratedFrom).toBe(PRIOR_SESSION);
        // A genuinely new session, not a reattach — nothing was resumed.
        expect(session.id).not.toBe(PRIOR_SESSION);
        expect(session.agentSessionId).toBeNull();

        const prompt = await systemPrompt(session.id);
        // The harness's own profile is still there — the brief is appended to
        // it, never a replacement for it.
        expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 60));
        // …and it is labelled as a reconstruction before anything else.
        expect(prompt).toContain("reconstruction, not restored context");
        // What the session was doing.
        expect(prompt).toContain("make the retry backoff jittered");
        expect(prompt).toContain("Jitter is in; the tests still need updating.");
        expect(prompt).toContain("src/retry.ts");
        expect(prompt).toContain("pnpm build");
        expect(prompt).toContain(cwd);
        // Registry-only context the record itself cannot carry.
        expect(prompt).toContain("feat/SAP-2059");
      });

      it("resolves the prior session by the agent's own id too", async () => {
        // Transcript-only history rows carry no harnessSessionId at all, so
        // the id the SPA posts is often the agent's.
        await seedPriorSession(harness);
        server = await boot(harness);
        const session = await server.sessionManager.create({
          cwd,
          harness,
          rehydrateFrom: PRIOR_AGENT_SESSION,
        });
        expect(session.rehydratedFrom).toBe(PRIOR_AGENT_SESSION);
        expect(await systemPrompt(session.id)).toContain("make the retry backoff jittered");
      });

      it("includes the rolling summary when one was produced, and degrades without it", async () => {
        await seedPriorSession(harness);
        server = await boot(harness);

        const withoutSummary = await server.sessionManager.create({
          cwd,
          harness,
          rehydrateFrom: PRIOR_SESSION,
        });
        expect(await systemPrompt(withoutSummary.id)).not.toContain("Rolling summary");

        await mkdir(join(generatedRoot, PRIOR_SESSION), { recursive: true });
        await writeFile(
          rollingSummaryPath(generatedRoot, PRIOR_SESSION),
          "Migrating the retry path to jittered backoff; tests not yet updated.\n",
        );
        const withSummary = await server.sessionManager.create({
          cwd,
          harness,
          rehydrateFrom: PRIOR_SESSION,
        });
        expect(await systemPrompt(withSummary.id)).toContain(
          "Migrating the retry path to jittered backoff",
        );
      });

      it("starts a plain session, honestly unmarked, when nothing was recorded for the id", async () => {
        // A history row can exist with no events of ours behind it. Refusing
        // would block the only thing still possible for that row; pretending
        // would be the dishonesty this epic exists to remove.
        server = await boot(harness);
        const session = await server.sessionManager.create({
          cwd,
          harness,
          rehydrateFrom: "never-recorded-anything",
        });
        expect(session.status).toBe("running");
        expect(session.rehydratedFrom).toBeNull();
        const prompt = await systemPrompt(session.id);
        expect(prompt).not.toContain("reconstruction, not restored context");
        expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 60));
      });

      it("leaves an ordinary new session untouched", async () => {
        await seedPriorSession(harness);
        server = await boot(harness);
        const session = await server.sessionManager.create({ cwd, harness });
        expect(session.rehydratedFrom).toBeNull();
        expect(await systemPrompt(session.id)).not.toContain("reconstruction, not restored context");
      });
    });
  }

  describe("the post-ready injection channel", () => {
    /** No shipped adapter needs this — both declare `launch-flag` — so this
     *  is the proof that a future harness with no prompt flag gets working
     *  rehydration from one line in its adapter rather than silence. */
    function promptFlaglessAdapter(): HarnessAdapter {
      return { ...fakeAdapter("claude-code"), systemPromptDelivery: "post-ready-injection" };
    }

    async function bootFlagless(): Promise<HarnessServer> {
      return startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        autoCreateSession: false,
        adapters: { "claude-code": promptFlaglessAdapter() },
        stateRoot: dir,
      });
    }

    it("keeps the brief out of the prompt file and injects it once the session is ready", async () => {
      await seedPriorSession("claude-code");
      server = await bootFlagless();
      const submitInput = vi.spyOn(server.sessionManager, "submitInput");

      const session = await server.sessionManager.create({
        cwd,
        harness: "claude-code",
        rehydrateFrom: PRIOR_SESSION,
      });
      // A brief exists and will be delivered, so the session says so — but not
      // through a file this adapter never reads.
      expect(session.rehydratedFrom).toBe(PRIOR_SESSION);
      expect(await systemPrompt(session.id)).not.toContain("reconstruction, not restored context");
      // Nothing injected yet: the pty is running but not `ready`, which is the
      // state a TUI sitting on a trust prompt is in.
      expect(submitInput).not.toHaveBeenCalled();

      server.sessionManager.setReady(session.id);
      await vi.waitFor(() => {
        expect(submitInput).toHaveBeenCalledTimes(1);
      });
      const [injectedId, text, submit] = submitInput.mock.calls[0];
      expect(injectedId).toBe(session.id);
      expect(text).toContain("reconstruction, not restored context");
      expect(text).toContain("make the retry backoff jittered");
      expect(submit).toBe(true);
    });

    it("injects once, not once per status frame", async () => {
      await seedPriorSession("claude-code");
      server = await bootFlagless();
      const submitInput = vi.spyOn(server.sessionManager, "submitInput");
      const session = await server.sessionManager.create({
        cwd,
        harness: "claude-code",
        rehydrateFrom: PRIOR_SESSION,
      });

      server.sessionManager.setReady(session.id);
      await vi.waitFor(() => {
        expect(submitInput).toHaveBeenCalledTimes(1);
      });
      // Any further status broadcast (a title change, a bind) must not re-send.
      server.sessionManager.setTitle(session.id, "renamed");
      server.sessionManager.setBoundWorkflowPath(session.id, null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(submitInput).toHaveBeenCalledTimes(1);
    });

    it("injects nothing for a session that was never rehydrated", async () => {
      server = await bootFlagless();
      const submitInput = vi.spyOn(server.sessionManager, "submitInput");
      const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
      server.sessionManager.setReady(session.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(submitInput).not.toHaveBeenCalled();
    });
  });

  it("is reachable over POST /api/sessions", async () => {
    await seedPriorSession("claude-code");
    server = await boot("claude-code");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": "test-token" },
      body: JSON.stringify({ cwd, harness: "claude-code", rehydrateFrom: PRIOR_SESSION }),
    });
    expect(response.status).toBe(201);
    const session = (await response.json()) as { id: string; rehydratedFrom: string | null };
    expect(session.rehydratedFrom).toBe(PRIOR_SESSION);
    expect(await systemPrompt(session.id)).toContain("make the retry backoff jittered");
  });

  it("rejects an empty rehydrateFrom rather than silently ignoring it", async () => {
    server = await boot("claude-code");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": "test-token" },
      body: JSON.stringify({ cwd, harness: "claude-code", rehydrateFrom: "" }),
    });
    expect(response.status).toBe(400);
  });
});
