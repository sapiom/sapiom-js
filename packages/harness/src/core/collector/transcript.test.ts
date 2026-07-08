import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalyticsEvent } from "../../shared/types.js";
import { enrichTurnCompleted, readLastAssistantTurn } from "./transcript.js";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("readLastAssistantTurn", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-transcript-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist", async () => {
    const result = await readLastAssistantTurn(path.join(tmpDir, "missing.jsonl"));
    expect(result).toBeNull();
  });

  it("extracts model, text, and usage from the last assistant message", async () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    await fs.writeFile(
      filePath,
      [
        line({ type: "user", message: { role: "user", content: "hi" } }),
        line({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
              { type: "text", text: "First reply." },
              { type: "tool_use", name: "Bash" },
            ],
            usage: { input_tokens: 120, output_tokens: 45 },
          },
        }),
        line({ type: "user", message: { role: "user", content: "thanks" } }),
      ].join(""),
      "utf8",
    );

    const turn = await readLastAssistantTurn(filePath);
    expect(turn).toEqual({
      model: "claude-opus-4-8",
      lastAssistantText: "First reply.",
      usage: { inputTokens: 120, outputTokens: 45 },
    });
  });

  it("picks the most recent assistant turn when there are several", async () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    await fs.writeFile(
      filePath,
      [
        line({
          type: "assistant",
          message: { role: "assistant", model: "m-old", content: "old reply" },
        }),
        line({ type: "user", message: { role: "user", content: "more" } }),
        line({
          type: "assistant",
          message: { role: "assistant", model: "m-new", content: "newest reply" },
        }),
      ].join(""),
      "utf8",
    );

    const turn = await readLastAssistantTurn(filePath);
    expect(turn?.model).toBe("m-new");
    expect(turn?.lastAssistantText).toBe("newest reply");
  });

  it("only reads the tail when the file exceeds maxBytes", async () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    const oldTurn = line({
      type: "assistant",
      message: { role: "assistant", model: "m-should-be-skipped", content: "too old" },
    });
    const padding = line({ type: "user", message: { role: "user", content: "x".repeat(200) } });
    const recentTurn = line({
      type: "assistant",
      message: { role: "assistant", model: "m-recent", content: "recent reply" },
    });

    await fs.writeFile(filePath, oldTurn + padding.repeat(10) + recentTurn, "utf8");

    // Cap small enough to only cover the tail padding + recent turn.
    const turn = await readLastAssistantTurn(filePath, 500);
    expect(turn?.model).toBe("m-recent");
  });

  it("returns null when the tail window has no assistant message", async () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    await fs.writeFile(filePath, line({ type: "user", message: { role: "user", content: "hi" } }), "utf8");
    const turn = await readLastAssistantTurn(filePath);
    expect(turn).toBeNull();
  });
});

describe("enrichTurnCompleted", () => {
  let tmpDir: string;
  const baseEvent: AnalyticsEvent = {
    eventId: "evt-1",
    ts: "2026-07-08T00:00:00.000Z",
    userId: null,
    machineId: "machine-1",
    harnessSessionId: "session-1",
    agentSessionId: "agent-1",
    harness: "claude-code",
    type: "turn.completed",
    payload: { stopHookActive: false },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-transcript-enrich-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("enriches turn.completed payloads with transcript data", async () => {
    const filePath = path.join(tmpDir, "transcript.jsonl");
    await fs.writeFile(
      filePath,
      line({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: "done",
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      "utf8",
    );

    const enriched = await enrichTurnCompleted(baseEvent, filePath);
    expect(enriched.payload).toMatchObject({
      stopHookActive: false,
      model: "claude-sonnet-5",
      lastAssistantText: "done",
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });

  it("is a no-op for non turn.completed events", async () => {
    const event = { ...baseEvent, type: "session.end" as const };
    const enriched = await enrichTurnCompleted(event, path.join(tmpDir, "unused.jsonl"));
    expect(enriched).toBe(event);
  });

  it("is a no-op when no transcript path is given", async () => {
    const enriched = await enrichTurnCompleted(baseEvent, undefined);
    expect(enriched).toBe(baseEvent);
  });
});
