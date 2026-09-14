import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexRolloutBroker } from "./codex-rollout-broker.js";
import * as codexTailer from "./codex-tailer.js";

const meta = (id: string, cwd: string, timestamp: string, ordinaryTurn = true) =>
  `${JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp } })}\n` +
  (ordinaryTurn ? `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Ordinary initial request" } })}\n` : "");

describe("CodexRolloutBroker", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("correlates simultaneous child rollouts by their exact initial runtime markers", async () => {
    const { home, cwd, sessions } = await fixture();
    const marker = (digit: string) => `<sapiom-codex-runtime ref="sha256:${digit.repeat(64)}" />`;
    const input = (sessionId: string, digit: string) => ({ sessionId, runtimeEpoch: `runtime-${digit}`, cwd,
      sinceMs: Date.parse("2026-09-04T10:00:00.000Z"), requiredRuntimeMarker: marker(digit) });
    const broker = new CodexRolloutBroker(home);
    const first = input("child-a", "1"); const second = input("child-b", "2");
    broker.register(first); broker.register(second);
    for (const [name, digit] of [["child-a", "1"], ["child-b", "2"]]) {
      await writeFile(join(sessions, `${name}.jsonl`), meta(name!, cwd, "2026-09-04T10:00:01.000Z", false) +
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [
          { type: "input_text", text: `${marker(digit!)}\n\nImplement the task.` },
        ] } }) + "\n");
    }
    await expect(broker.claimFresh(first)).resolves.toEqual({ outcome: "claimed", path: join(sessions, "child-a.jsonl") });
    await expect(broker.claimFresh(second)).resolves.toEqual({ outcome: "claimed", path: join(sessions, "child-b.jsonl") });
  });

  it("does not let an ordinary pending runtime claim a delegated child's marked rollout", async () => {
    const { home, cwd, sessions } = await fixture();
    const requiredRuntimeMarker = `<sapiom-codex-runtime ref="sha256:${"3".repeat(64)}" />`;
    const ordinary = { sessionId: "aaa-ordinary", runtimeEpoch: "ordinary-runtime", cwd, sinceMs: 0 };
    const child = { sessionId: "child", runtimeEpoch: "child-runtime", cwd, sinceMs: 0, requiredRuntimeMarker };
    const broker = new CodexRolloutBroker(home);
    broker.register(ordinary); broker.register(child);
    const rollout = join(sessions, "marked-child.jsonl");
    await writeFile(rollout, meta("child-native", cwd, "2026-09-04T10:00:01.000Z", false));
    await expect(broker.claimFresh(ordinary)).resolves.toEqual({ outcome: "pending", path: null });
    await writeFile(rollout, meta("child-native", cwd, "2026-09-04T10:00:01.000Z", false) +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: `${requiredRuntimeMarker}\n\nImplement the task.` },
      ] } }) + "\n");
    await expect(broker.claimFresh(ordinary)).resolves.toEqual({ outcome: "pending", path: null });
    await expect(broker.claimFresh(child)).resolves.toEqual({ outcome: "claimed", path: rollout });
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

  it("does not assign a fresh rollout after its runtime was released during discovery", async () => {
    const { home, cwd } = await fixture();
    const candidate = {
      path: "/fake/next-rollout.jsonl",
      agentSessionId: "agent-next",
      timestampMs: Date.now(),
      mtimeMs: Date.now(),
    };
    let finishDiscovery!: (candidates: typeof candidate[]) => void;
    const finder = vi.spyOn(codexTailer, "findRolloutCandidates")
      .mockImplementationOnce(() => new Promise((resolve) => { finishDiscovery = resolve; }))
      .mockResolvedValue([candidate]);
    const broker = new CodexRolloutBroker(home);
    const pending = broker.claimFresh({
      sessionId: "retired-session",
      runtimeEpoch: "retired-runtime",
      cwd,
      sinceMs: 0,
    });
    await vi.waitFor(() => expect(finder).toHaveBeenCalledOnce());
    broker.releaseSession("retired-session");
    finishDiscovery([candidate]);
    await expect(pending).resolves.toEqual({ outcome: "pending", path: null });
    await expect(broker.claimFresh({
      sessionId: "next-session",
      runtimeEpoch: "next-runtime",
      cwd,
      sinceMs: 0,
    })).resolves.toEqual({ outcome: "claimed", path: candidate.path });
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
