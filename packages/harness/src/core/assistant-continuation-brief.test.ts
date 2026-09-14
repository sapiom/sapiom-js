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
          text: "data ".repeat(240),
          truncated: false,
        },
      ],
    })),
  );
  record.messageCount = 31;
  const frozen = buildAssistantContinuationBrief(record);
  expect(frozen.estimatedTokens).toBeLessThanOrEqual(6000);
  expect(frozen.text).toContain("excerpt truncated");
  expect(frozen.text).toContain("Record revision 7");
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
