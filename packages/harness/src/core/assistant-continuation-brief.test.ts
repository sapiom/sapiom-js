import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { AssistantRecord } from "../shared/assistant-record.js";
import { buildAssistantContinuationBrief } from "./assistant-continuation-brief.js";
import { projectAssistantRecord } from "./assistant-record.js";

const binding = {
  harnessSessionId: "studio-source",
  conversationId: "ses_source",
  contextAuthorityScope: "a".repeat(64),
  cwd: "/workspace/project",
};
function fixture(count = 1): AssistantRecord {
  return projectAssistantRecord(
    Array.from({ length: count }, (_, index) => ({
      info: {
        id: `msg_user_${index}`,
        role: "user",
        sessionID: binding.conversationId,
        time: { created: index + 1 },
      },
      parts: [
        {
          id: `prt_text_${index}`,
          messageID: `msg_user_${index}`,
          sessionID: binding.conversationId,
          type: "text",
          text: `Task ${index}: preserve current work.`,
        },
      ],
    })),
    binding,
    7,
    "2026-09-14T12:00:00.000Z",
  );
}
it("freezes one exact public revision with reconstruction and no-replay provenance", () => {
  const record = fixture();
  const frozen = buildAssistantContinuationBrief(record);
  expect(frozen).toMatchObject({
    version: 1,
    binding,
    recordRevision: 7,
    retainedTurns: 1,
    omittedTurns: 0,
  });
  expect(frozen.text).toContain("not restored native memory or a new task");
  expect(frozen.text).toContain("Do not replay completed tools");
  expect(frozen.text).toContain("incomplete; do not assume success");
  expect(frozen.text).toContain("accepted-context-unavailable");
  expect(frozen.sha256).toBe(
    createHash("sha256").update(frozen.text).digest("hex"),
  );
  const original = frozen.text;
  record.turns[0]!.messages[0]!.parts = [];
  record.binding.cwd = "/other";
  expect(frozen.text).toBe(original);
  expect(frozen.binding.cwd).toBe("/workspace/project");
});
it("keeps at most twelve recent turns and reports all omissions", () => {
  const frozen = buildAssistantContinuationBrief(fixture(20));
  expect(frozen.retainedTurns).toBe(12);
  expect(frozen.omittedTurns).toBe(8);
  expect(frozen.text).not.toContain("Task 0:");
  expect(frozen.text).toContain("Task 19:");
  expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
});
it("bounds an oversized final turn without dropping the honesty block", () => {
  const record = fixture();
  record.turns[0]!.messages.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `msg_reply_${index}`,
      role: "assistant" as const,
      parentId: "msg_user_0",
      createdAt: index + 2,
      completedAt: null,
      parts: [
        {
          id: `prt_long_${index}`,
          type: "text" as const,
          text: `Reply ${index}: ${"data ".repeat(235)}`,
          truncated: false,
        },
      ],
    })),
  );
  record.messageCount = 31;
  const original = JSON.stringify(record);
  const frozen = buildAssistantContinuationBrief(record);
  expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
  expect(frozen.text).toContain("Assistant messages omitted from this excerpt");
  expect(frozen.text).toContain("Record revision 7");
  expect(frozen.text).toContain("Task 0: preserve current work.");
  expect(frozen.text).toContain("Assistant msg_reply_29:");
  expect(frozen.text).toContain("Reply 29:");
  expect(frozen.text).not.toContain("Assistant msg_reply_0:");
  expect(frozen).toEqual(buildAssistantContinuationBrief(record));
  expect(JSON.stringify(record)).toBe(original);
});
it("reserves user context and the newest Assistant parts when both messages are oversized", () => {
  const record = fixture();
  const parts = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `prt_${prefix}_${index}`,
      type: "text" as const,
      text: `${prefix} state ${index}: ${"data ".repeat(235)}`,
      truncated: false,
    }));
  record.turns[0]!.messages[0]!.parts = parts("user", 12);
  record.turns[0]!.messages.push({
    id: "msg_reply",
    role: "assistant",
    parentId: "msg_user_0",
    createdAt: 2,
    completedAt: null,
    parts: parts("assistant", 13),
  });
  record.messageCount = 2;
  const frozen = buildAssistantContinuationBrief(record);
  expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
  expect(frozen.text).toContain("user state 0:");
  expect(frozen.text).toContain("excerpt truncated");
  expect(frozen.text).toContain("assistant state 12:");
  expect(frozen.text).not.toContain("assistant state 0:");
  expect(frozen.text).toContain("1 part omitted.");
  expect(frozen.text).toContain("incomplete; do not assume success");
});
it("keeps the newest useful Assistant state ahead of later empty native messages", () => {
  const record = fixture();
  record.turns[0]!.messages.push(
    {
      id: "msg_state",
      role: "assistant",
      parentId: "msg_user_0",
      createdAt: 2,
      completedAt: null,
      parts: [
        {
          id: "prt_state",
          type: "text",
          text: "Latest useful state: implementation ready; verification still pending.",
          truncated: false,
        },
      ],
    },
    ...Array.from({ length: 200 }, (_, index) => ({
      id: `msg_empty_${index}_${"x".repeat(100)}`,
      role: "assistant" as const,
      parentId: "msg_user_0",
      createdAt: index + 3,
      completedAt: null,
      parts: [],
    })),
  );
  record.messageCount = 202;
  const frozen = buildAssistantContinuationBrief(record);
  expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
  expect(frozen.text).toContain(
    "Latest useful state: implementation ready; verification still pending.",
  );
  expect(frozen.text).toContain("Assistant messages omitted from this excerpt");
});
it("fails without usable public history or with corrupt binding metadata", () => {
  const empty = fixture(0);
  expect(() => buildAssistantContinuationBrief(empty)).toThrow("unavailable");
  expect(() =>
    buildAssistantContinuationBrief({
      ...fixture(),
      binding: { ...binding, conversationId: "studio-source" },
    }),
  ).toThrow();
});

it.each(["blank", "omitted", "mixed"])(
  "keeps the latest useful text, tool and attachment before thirteen %s parts",
  (kind) => {
    const record = fixture();
    record.turns[0]!.messages.push({
      id: "msg_state",
      role: "assistant",
      parentId: "msg_user_0",
      createdAt: 2,
      completedAt: 3,
      parts: [
        {
          id: "prt_state",
          type: "text",
          text: "Latest result: tests pass; deployment pending.",
          truncated: false,
        },
        {
          id: "prt_tool",
          type: "tool",
          callId: "call_verify",
          name: "test",
          status: "completed",
          input: "{}",
          output: "12 tests passed",
          error: null,
          startedAt: 2,
          completedAt: 3,
          truncated: false,
        },
        {
          id: "prt_file",
          type: "file",
          name: "test-report.txt",
          mime: "text/plain",
        },
        ...Array.from({ length: 13 }, (_, index) =>
          kind === "omitted" || (kind === "mixed" && index % 2 === 0)
            ? {
                id: `prt_empty_${index}`,
                type: "omitted" as const,
                nativeType: "step-finish",
              }
            : {
                id: `prt_empty_${index}`,
                type: "text" as const,
                text: " \n\t ",
                truncated: false,
              },
        ),
      ],
    });
    record.messageCount = 2;
    const frozen = buildAssistantContinuationBrief(record);
    expect(frozen.text).toContain(
      "Latest result: tests pass; deployment pending.",
    );
    expect(frozen.text).toContain("Recorded tool test (completed)");
    expect(frozen.text).toContain("12 tests passed");
    expect(frozen.text).toContain(
      "Attachment test-report.txt (text/plain); contents omitted.",
    );
    expect(frozen.text).toContain("13 parts omitted.");
    expect(frozen.text).not.toContain("earlier parts omitted");
    expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
    expect(frozen).toEqual(buildAssistantContinuationBrief(record));
  },
);
