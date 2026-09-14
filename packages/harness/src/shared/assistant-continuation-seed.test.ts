import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  openCodeTurn,
  isAssistantContinuationSeed,
  type OpenCodeTurnMessage,
} from "./opencode-turn.js";
import {
  verifyAssistantContinuationView,
  type AssistantContinuationView,
} from "./assistant-continuation.js";
import { projectAssistantRecord } from "../core/assistant-record.js";

const text = "Recorded context: the previous draft was completed.";
const view: AssistantContinuationView = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceSessionId: "source",
  sourceRecordRevision: 7,
  capturedAt: "2026-09-14T00:00:00.000Z",
  retainedTurns: 1,
  omittedTurns: 0,
  seed: {
    conversationId: "ses_child",
    messageId: "msg_seed",
    partId: "prt_seed",
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
  },
};
const seed = (): OpenCodeTurnMessage => ({
  info: {
    id: "msg_seed",
    sessionID: "ses_child",
    role: "user",
    time: { created: 1 },
  },
  parts: [
    {
      id: "prt_seed",
      messageID: "msg_seed",
      sessionID: "ses_child",
      type: "text",
      synthetic: true,
      ignored: false,
      text,
      metadata: {
        sapiomContinuation: {
          operationId: view.operationId,
          briefHash: view.seed.sha256,
        },
      },
    },
  ],
});
const binding = {
  harnessSessionId: "child",
  cwd: "/workspace",
  conversationId: "ses_child",
  contextAuthorityScope: "a".repeat(64),
};

it("keeps an exact prepared seed ready with no recovery or archived human task", async () => {
  expect(await verifyAssistantContinuationView(view, "ses_child")).toEqual(
    view,
  );
  expect(openCodeTurn([seed()], "idle", undefined, view)).toEqual({
    status: "ready",
  });
  const record = projectAssistantRecord([seed()], binding, 1, undefined, view);
  expect(record).toMatchObject({
    turns: [],
    turnCount: 0,
    messageCount: 0,
    limitations: [],
  });
  expect(openCodeTurn([seed()], "busy", undefined, view)).toEqual({
    status: "working",
  });
});

it.each([
  [
    "message identity",
    (m: OpenCodeTurnMessage) => {
      m.info!.id = "msg_other";
    },
  ],
  [
    "native identity",
    (m: OpenCodeTurnMessage) => {
      m.info!.sessionID = "ses_other";
    },
  ],
  [
    "part identity",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.id = "prt_other";
    },
  ],
  [
    "part parent",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.messageID = "msg_other";
    },
  ],
  [
    "part session",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.sessionID = "ses_other";
    },
  ],
  [
    "ordinary text",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.synthetic = false;
    },
  ],
  [
    "ignored input",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.ignored = true;
    },
  ],
  [
    "changed brief",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.text = "new human request";
    },
  ],
  [
    "missing marker",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.metadata = {};
    },
  ],
  [
    "wrong operation",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.metadata!.sapiomContinuation = {
        operationId: "other",
        briefHash: view.seed.sha256,
      };
    },
  ],
  [
    "wrong hash",
    (m: OpenCodeTurnMessage) => {
      m.parts[0]!.metadata!.sapiomContinuation = {
        operationId: view.operationId,
        briefHash: "b".repeat(64),
      };
    },
  ],
  [
    "extra part",
    (m: OpenCodeTurnMessage) => {
      (m.parts as unknown[]).push({ type: "text", text: "user request" });
    },
  ],
] as const)(
  "does not exempt a %s from normal task status",
  (_label, mutate) => {
    const message = seed();
    mutate(message);
    expect(isAssistantContinuationSeed(message, view)).toBe(false);
    expect(openCodeTurn([message], "idle", undefined, view)).toEqual({
      status: "failed",
    });
  },
);

it("does not trust a synthetic marker without server attestation or a changed attested brief", async () => {
  expect(openCodeTurn([seed()], "idle")).toEqual({ status: "failed" });
  expect(projectAssistantRecord([seed()], binding, 1).turnCount).toBe(1);
  expect(
    await verifyAssistantContinuationView({
      ...view,
      seed: { ...view.seed, text: "changed" },
    }),
  ).toBeNull();
  expect(await verifyAssistantContinuationView(view, "ses_other")).toBeNull();
});

it("counts a later human task and preserves unexpected work attached to the seed", () => {
  const user = seed();
  user.info!.id = "msg_human";
  Object.assign(user.parts[0]!, {
    id: "prt_human",
    messageID: "msg_human",
    synthetic: false,
    text: "Make the next change.",
  });
  expect(openCodeTurn([seed(), user], "idle", undefined, view)).toEqual({
    status: "failed",
  });
  expect(
    projectAssistantRecord([seed(), user], binding, 1, undefined, view),
  ).toMatchObject({ turnCount: 1, messageCount: 1 });
  const unexpected: OpenCodeTurnMessage = {
    info: {
      id: "msg_answer",
      sessionID: "ses_child",
      role: "assistant",
      parentID: "msg_seed",
      finish: "stop",
      time: { created: 2, completed: 3 },
    },
    parts: [
      {
        id: "prt_answer",
        sessionID: "ses_child",
        messageID: "msg_answer",
        type: "text",
        text: "Unexpected answer",
      },
    ],
  };
  expect(openCodeTurn([seed(), unexpected], "idle", undefined, view)).toEqual({
    status: "finished",
  });
  expect(
    projectAssistantRecord([seed(), unexpected], binding, 1, undefined, view),
  ).toMatchObject({ turnCount: 1, messageCount: 2 });
});
