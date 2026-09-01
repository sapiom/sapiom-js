/**
 * Wiring-level proof of the record archive (see core/record-archive.test.ts for
 * the unit tests of the mechanisms): the acceptance criterion of SAP-2060, run
 * against a real server, a real event store and real files.
 *
 * What it proves that a unit test can't:
 *   - a session's record still renders through `GET /api/sessions/:id/record`
 *     after its events have been swept out of events.ndjson;
 *   - the archive is written on the NORMAL end of a session (the SessionEnd
 *     hook's event reaching the store) and on an ABNORMAL one (a killed pty
 *     that never produced that hook), because those are two different triggers
 *     in server/index.ts and only one of them fires in each case;
 *   - the boot pass archives conversations that ended before the archive
 *     existed, which is what keeps history that predates this feature from
 *     disappearing at its 30-day mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type HarnessServer } from "./index.js";
import type {
  AnalyticsEvent,
  HarnessAdapter,
  LaunchOpts,
  SessionRecord,
  SpawnSpec,
} from "../shared/types.js";

const TOKEN = "test-token";

/** A claude-code-shaped adapter that spawns bash — a real pty we can kill. */
function fakeClaudeAdapter(ingestTokenPath: string): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts: LaunchOpts): SpawnSpec => ({
      command: "bash",
      args: [
        "-c",
        'printf "%s" "$SAPIOM_HARNESS_INGEST_TOKEN" > "$SAPIOM_TEST_INGEST_TOKEN_PATH"; exec bash',
      ],
      env: { SAPIOM_TEST_INGEST_TOKEN_PATH: ingestTokenPath },
      cwd: opts.cwd,
    }),
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec => ({
      command: "bash",
      args: [],
      env: {},
      cwd: opts.cwd,
    }),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
}

describe("session record archive wiring", () => {
  let dir: string;
  let cwd: string;
  let eventStorePath: string;
  let recordsRoot: string;
  let ingestTokenPath: string;
  let server: HarnessServer | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-record-archive-wiring-"));
    cwd = join(dir, "project");
    eventStorePath = join(dir, "events.ndjson");
    recordsRoot = join(dir, "records");
    ingestTokenPath = join(dir, "ingest-token");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<HarnessServer> {
    const booted = await startServer({
      port: 0,
      bootToken: TOKEN,
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { "claude-code": fakeClaudeAdapter(ingestTokenPath) },
      stateRoot: dir,
    });
    baseUrl = `http://127.0.0.1:${booted.port}`;
    return booted;
  }

  /** Feed one hook event through the real ingest pipeline. */
  async function hook(
    harnessSessionId: string,
    hookEvent: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    let ingestToken = "";
    await vi.waitFor(async () => {
      ingestToken = await readFile(ingestTokenPath, "utf8");
      expect(ingestToken).not.toBe("");
    });
    const res = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingestToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hookEvent, harnessSessionId, payload }),
    });
    expect(res.status).toBe(200);
  }

  /**
   * The ingest route ACKs before it persists (see ingest.ts: the 200 is sent
   * and processing runs detached, so a slow server never stalls the agent's
   * hook pipeline). A resolved hook() therefore doesn't mean the event has
   * reached events.ndjson — wait for the bytes before acting on "stored".
   */
  async function eventsPersisted(needle: string): Promise<void> {
    await vi.waitFor(async () => {
      expect(await readFile(eventStorePath, "utf8")).toContain(needle);
    });
  }

  async function readArchived(harnessSessionId: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await readFile(join(recordsRoot, `${harnessSessionId}.json`), "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  async function fetchRecord(id: string): Promise<{ status: number; body: SessionRecord | null }> {
    const res = await fetch(`${baseUrl}/api/sessions/${id}/record`, {
      headers: { "X-Harness-Token": TOKEN },
    });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as SessionRecord) : null };
  }

  it("keeps a session readable after its events are swept", async () => {
    server = await boot();
    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });

    await hook(session.id, "SessionStart", { session_id: "agent-swept", cwd });
    await hook(session.id, "UserPromptSubmit", { prompt: "add the screening step" });
    await hook(session.id, "PostToolUse", {
      tool_name: "Edit",
      // Bigger than the archive's per-payload cap, so the compaction is
      // observable rather than assumed.
      tool_input: { old_string: "x".repeat(4000) },
      tool_response: "applied",
    });
    await hook(session.id, "Stop", { last_assistant_message: "Added it." });
    await hook(session.id, "SessionEnd", { reason: "exit" });

    // The normal end of a session archives it, with the whole conversation
    // including the session.end the record's `endedAt` comes from.
    await vi.waitFor(
      async () => {
        const archived = await readArchived(session.id);
        expect(archived?.turns).toHaveLength(1);
        expect(archived?.endedAt).not.toBeNull();
      },
      { timeout: 10_000, interval: 100 },
    );

    const archived = await readArchived(session.id);
    expect(archived?.turns[0].prompt).toBe("add the screening step");
    expect(archived?.turns[0].assistantText).toBe("Added it.");
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.turns[0].toolCalls[0].input).toMatch(/…\[truncated \d+ chars\]$/);
    expect(archived?.limitations).toContain("compacted-archive");

    // Now retention takes the events — the whole point of this ticket. Nothing
    // rewrites the archive, and the route still answers.
    await writeFile(eventStorePath, "", "utf8");

    const byHarnessId = await fetchRecord(session.id);
    expect(byHarnessId.status).toBe(200);
    expect(byHarnessId.body?.turns[0].prompt).toBe("add the screening step");
    expect(byHarnessId.body?.archivedAt).not.toBeNull();

    // And by the agent's own session id, which is all a transcript-sourced
    // history row has to ask with.
    const byAgentId = await fetchRecord("agent-swept");
    expect(byAgentId.status).toBe(200);
    expect(byAgentId.body?.harnessSessionId).toBe(session.id);

    // A session that never existed is still an honest 404 — "swept" and "never
    // recorded" stay distinguishable, they don't both become "here's nothing".
    expect((await fetchRecord("sess-never-existed")).status).toBe(404);
  }, 20_000);

  it("archives a session whose pty was killed without a SessionEnd hook", async () => {
    server = await boot();
    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });

    await hook(session.id, "SessionStart", { session_id: "agent-killed", cwd });
    await hook(session.id, "UserPromptSubmit", { prompt: "start something long" });

    // The exit handler folds the archive from events.ndjson exactly once, and
    // a fold that sees zero turns writes nothing (record-archive.ts) — so if
    // the kill wins the race against the detached ingest processing, the
    // archive never appears and no amount of waiting below can recover it.
    // Killing is only meaningful after the prompt event is on disk.
    await eventsPersisted("start something long");

    // No Stop, no SessionEnd: the agent is killed mid-turn, so the only signal
    // is the session's own transition to "exited".
    void server.sessionManager.kill(session.id);

    await vi.waitFor(
      async () => {
        expect(server!.sessionManager.get(session.id)?.status).toBe("exited");
        const archived = await readArchived(session.id);
        expect(archived?.turns).toHaveLength(1);
        // Killed mid-turn, and the record says so rather than implying it
        // finished.
        expect(archived?.limitations).toContain("incomplete-final-turn");
      },
      { timeout: 10_000, interval: 100 },
    );
  }, 20_000);

  it("archives conversations that ended before the archive existed", async () => {
    // An events file from an install that predates this feature: a complete
    // conversation, no archive, and no registry entry for it.
    const events: AnalyticsEvent[] = [
      {
        eventId: "evt-1",
        seq: 1,
        ts: "2026-06-01T10:00:00.000Z",
        userId: null,
        tenantId: null,
        machineId: "machine-1",
        harnessSessionId: "sess-legacy",
        agentSessionId: "agent-legacy",
        harness: "claude-code",
        type: "prompt.submitted",
        payload: { prompt: "from before the archive existed" },
      },
      {
        eventId: "evt-2",
        seq: 2,
        ts: "2026-06-01T10:00:01.000Z",
        userId: null,
        tenantId: null,
        machineId: "machine-1",
        harnessSessionId: "sess-legacy",
        agentSessionId: "agent-legacy",
        harness: "claude-code",
        type: "turn.completed",
        payload: { assistantText: "done" },
      },
    ];
    await writeFile(eventStorePath, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");

    server = await boot();

    await vi.waitFor(
      async () => {
        const archived = await readArchived("sess-legacy");
        expect(archived?.turns[0].prompt).toBe("from before the archive existed");
      },
      { timeout: 10_000, interval: 100 },
    );
  }, 20_000);
});
