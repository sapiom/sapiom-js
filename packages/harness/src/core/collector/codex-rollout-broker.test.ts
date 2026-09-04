import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexRolloutBroker } from "./codex-rollout-broker.js";

const meta = (id: string, cwd: string, timestamp: string) =>
  `${JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp } })}\n`;

describe("CodexRolloutBroker", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "codex-rollout-broker-"));
    const cwd = join(home, "project");
    const sessions = join(home, ".codex", "sessions", "2026", "09", "04");
    await Promise.all([mkdir(cwd), mkdir(sessions, { recursive: true })]);
    roots.push(home);
    return { home, cwd, sessions };
  }

  it("uniquely assigns concurrent same-root rollouts by process epoch", async () => {
    const { home, cwd, sessions } = await fixture();
    const firstTime = Date.parse("2026-09-04T10:00:00.000Z");
    const secondTime = Date.parse("2026-09-04T10:00:01.000Z");
    const firstPath = join(sessions, "rollout-first.jsonl");
    const secondPath = join(sessions, "rollout-second.jsonl");
    await writeFile(
      firstPath,
      meta("agent-first", cwd, "2026-09-04T10:00:00.500Z"),
    );
    await writeFile(
      secondPath,
      meta("agent-second", cwd, "2026-09-04T10:00:01.500Z"),
    );
    const broker = new CodexRolloutBroker(home);
    broker.register({
      sessionId: "first",
      runtimeEpoch: "runtime-1",
      cwd,
      sinceMs: firstTime,
    });
    broker.register({
      sessionId: "second",
      runtimeEpoch: "runtime-2",
      cwd,
      sinceMs: secondTime,
    });

    await expect(
      broker.claimFresh({
        sessionId: "first",
        runtimeEpoch: "runtime-1",
        cwd,
        sinceMs: firstTime,
      }),
    ).resolves.toEqual({ outcome: "claimed", path: firstPath });
    await expect(
      broker.claimFresh({
        sessionId: "second",
        runtimeEpoch: "runtime-2",
        cwd,
        sinceMs: secondTime,
      }),
    ).resolves.toEqual({ outcome: "claimed", path: secondPath });
  });

  it("fails closed when same-root process epochs cannot distinguish candidates", async () => {
    const { home, cwd, sessions } = await fixture();
    const sinceMs = Date.parse("2026-09-04T10:00:00.000Z");
    await writeFile(
      join(sessions, "rollout-a.jsonl"),
      meta("agent-a", cwd, "2026-09-04T10:00:01.000Z"),
    );
    await writeFile(
      join(sessions, "rollout-b.jsonl"),
      meta("agent-b", cwd, "2026-09-04T10:00:02.000Z"),
    );
    const broker = new CodexRolloutBroker(home);
    broker.register({
      sessionId: "first",
      runtimeEpoch: "runtime-1",
      cwd,
      sinceMs,
    });
    broker.register({
      sessionId: "second",
      runtimeEpoch: "runtime-2",
      cwd,
      sinceMs,
    });

    await expect(
      broker.claimFresh({
        sessionId: "first",
        runtimeEpoch: "runtime-1",
        cwd,
        sinceMs,
      }),
    ).resolves.toEqual({ outcome: "ambiguous", path: null });
    await expect(
      broker.claimFresh({
        sessionId: "second",
        runtimeEpoch: "runtime-2",
        cwd,
        sinceMs,
      }),
    ).resolves.toEqual({ outcome: "ambiguous", path: null });
  });

  it("allows only the same Harness session to reclaim an exact rollout on resume", async () => {
    const { home, cwd, sessions } = await fixture();
    const rolloutPath = join(sessions, "rollout-resume.jsonl");
    await writeFile(
      rolloutPath,
      meta("agent-resume", cwd, "2026-09-04T10:00:01.000Z"),
    );
    const broker = new CodexRolloutBroker(home);
    const base = { cwd, sinceMs: 0, agentSessionId: "agent-resume" };
    await expect(
      broker.claimExact({
        ...base,
        sessionId: "owner",
        runtimeEpoch: "runtime-1",
      }),
    ).resolves.toEqual({ outcome: "claimed", path: rolloutPath });
    broker.release("owner", "runtime-1");
    await expect(
      broker.claimExact({
        ...base,
        sessionId: "owner",
        runtimeEpoch: "runtime-2",
      }),
    ).resolves.toEqual({ outcome: "claimed", path: rolloutPath });
    await expect(
      broker.claimExact({
        ...base,
        sessionId: "foreign",
        runtimeEpoch: "runtime-3",
      }),
    ).resolves.toEqual({ outcome: "pending", path: null });
  });
});
