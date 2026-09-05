/**
 * Wiring-level proof that the SERVED system prompt is what a session launches with
 * (SAP-2810). The fetch itself is covered in profiles/system-prompt-fetch.test.ts;
 * what that cannot show is that its result reaches
 * `<generated>/<id>/system-prompt.txt` — the exact bytes claude-code passes to
 * `--append-system-prompt` and codex inlines as `developer_instructions`.
 *
 * Without this, deleting `prompt` from the `generateSystemPromptFile` call leaves the
 * whole suite green while every session silently falls back to the bundled profile:
 * the feature quietly absent, which is the failure mode the drift guards exist for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type HarnessServer } from "./index.js";
import { PROJECT_AGENT_PROMPT_APPENDIX } from "../profiles/project-agent.js";
import { DEFAULT_SYSTEM_PROMPT } from "../profiles/default.js";
import type {
  HarnessAdapter,
  HarnessKind,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";

const SERVED_PROMPT = "# Served prompt\nThis text only exists on the backend.";

/** Shaped like the shipped adapters: `launch-flag` delivery, a real killable pty. */
function fakeAdapter(harness: HarnessKind): HarnessAdapter {
  const spec = (opts: LaunchOpts): SpawnSpec => ({
    command: "bash",
    args: [],
    env: {},
    cwd: opts.cwd,
  });
  return {
    id: harness,
    eventSource: harness === "codex" ? "transcript-tail" : "hooks",
    systemPromptDelivery: "launch-flag",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId, opts) => spec(opts),
    listPastSessions: async () => [],
    // The resume case below needs the adapter to claim the conversation exists.
    canResume: async () => true,
  };
}

describe("served system prompt reaches the launched session", () => {
  let dir: string;
  let generatedRoot: string;
  let cwd: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-served-prompt-"));
    generatedRoot = join(dir, "generated");
    cwd = join(dir, "project");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    // Retried like the other server specs: a session's exit-time generated-dir
    // removal is fire-and-forget and can still be running here (ENOTEMPTY).
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function boot(loadSystemPrompt: () => Promise<string>): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { "claude-code": fakeAdapter("claude-code") },
      stateRoot: dir,
      loadSystemPrompt,
    });
  }

  async function systemPromptFile(harnessSessionId: string): Promise<string> {
    return readFile(join(generatedRoot, harnessSessionId, "system-prompt.txt"), "utf8");
  }

  it("writes the served prompt, not the bundled one, on create", async () => {
    server = await boot(async () => SERVED_PROMPT);

    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });

    expect(await systemPromptFile(session.id)).toBe(`${SERVED_PROMPT}\n\n${PROJECT_AGENT_PROMPT_APPENDIX}\n`);
  });

  it("re-reads it on resume, so a redeployed prompt reaches a continued session", async () => {
    let served = SERVED_PROMPT;
    server = await boot(async () => served);

    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
    // A resume needs an agent session id; the fake adapter reports none, so record one
    // the way the hook ingest would.
    await server.sessionManager.setAgentSessionId(session.id, "agent-session-1");
    await server.sessionManager.kill(session.id);

    served = "# Redeployed prompt";
    await server.sessionManager.resume(session.id);

    expect(await systemPromptFile(session.id)).toBe(`# Redeployed prompt\n\n${PROJECT_AGENT_PROMPT_APPENDIX}\n`);
  });

  it("falls back to the bundled profile when the load fails", async () => {
    // The loader itself never throws (see profiles/system-prompt-fetch.ts), but the
    // session must survive a host that injects one that does.
    server = await boot(async () => {
      throw new Error("backend unreachable");
    });

    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });

    expect(await systemPromptFile(session.id)).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\n${PROJECT_AGENT_PROMPT_APPENDIX}\n`);
  });
});
