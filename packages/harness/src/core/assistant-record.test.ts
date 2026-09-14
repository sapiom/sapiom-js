import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2";
import {
  serializeAcceptedAssistantSystem,
  studioAssistantCompletionSystem,
  type AcceptedAssistantWireV2,
} from "@sapiom/opencode";
import {
  sourceFixture,
  sourceScope,
} from "./test-fixtures/assistant-context.js";
import {
  ASSISTANT_RECORD_MAX_BYTES,
  AssistantRecordError,
  projectAssistantRecord,
  validateAssistantRecord,
} from "./assistant-record.js";

const binding = {
  harnessSessionId: "studio-a",
  contextAuthorityScope: sourceScope,
  conversationId: "ses_fixture",
  cwd: "/workspace",
};
function user(id = "msg_user", created = 1, system?: string) {
  return {
    info: {
      id,
      sessionID: binding.conversationId,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "sapiom", modelID: "test" },
      ...(system ? { system } : {}),
    } satisfies UserMessage,
    parts: [
      {
        id: `${id}_part`,
        messageID: id,
        sessionID: binding.conversationId,
        type: "text",
        text: "Check the code",
      },
    ],
  };
}
function answer(
  id: string,
  created: number,
  parts: Record<string, unknown>[],
  overrides: Partial<AssistantMessage> = {},
) {
  return {
    info: {
      id,
      sessionID: binding.conversationId,
      role: "assistant",
      parentID: "msg_user",
      time: { created, completed: created + 1 },
      modelID: "test",
      providerID: "sapiom",
      mode: "build",
      agent: "build",
      path: { cwd: binding.cwd, root: binding.cwd },
      cost: 0,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
      ...overrides,
    } satisfies AssistantMessage,
    parts: parts.map((part, index) => ({
      id: `${id}_part${index}`,
      messageID: id,
      sessionID: binding.conversationId,
      ...part,
    })),
  };
}
const completedTool = {
  type: "tool",
  callID: "call_read",
  tool: "read",
  state: {
    status: "completed",
    input: { file: "index.ts" },
    output: "export const ok = true;",
    title: "Read",
    metadata: {},
    time: { start: 2, end: 3 },
  },
};
const project = (messages: unknown) =>
  projectAssistantRecord(messages, binding, 1, "2026-09-14T10:00:00.000Z");

describe("native Assistant record projection", () => {
  it("groups the known user first when native timestamps tie and IDs sort differently", () => {
    const response = answer("msg_a", 1, [{ type: "text", text: "Done" }], {
      parentID: "msg_z",
    });
    const record = project([response, user("msg_z", 1)]);
    expect(record.turns[0]!.messages.map((message) => message.id)).toEqual([
      "msg_z",
      "msg_a",
    ]);
    expect(record.turns[0]!.incomplete).toBe(false);
  });
  it("preserves real native multi-step provenance and interrupted work without leaking private fields", () => {
    const record = project([
      user(),
      answer(
        "msg_step",
        2,
        [completedTool, { type: "reasoning", text: "private reasoning" }],
        { finish: "tool-calls" },
      ),
      answer("msg_final", 4, [{ type: "text", text: "The file looks good" }]),
      user("msg_next", 7),
      answer(
        "msg_interrupted",
        8,
        [{ type: "text", text: "Started checking" }],
        { parentID: "msg_next", time: { created: 8 } },
      ),
    ]);
    expect(record.turns.map((turn) => [turn.id, turn.incomplete])).toEqual([
      ["msg_user", false],
      ["msg_next", true],
    ]);
    expect(record.turns[0]!.messages.map((message) => message.id)).toEqual([
      "msg_user",
      "msg_step",
      "msg_final",
    ]);
    expect(record.turns[0]!.messages[1]!.parts[0]).toMatchObject({
      id: "msg_step_part0",
      callId: "call_read",
      name: "read",
      status: "completed",
      output: "export const ok = true;",
      startedAt: 2,
      completedAt: 3,
    });
    expect(record.limitations).toContain("private-parts-omitted");
    expect(JSON.stringify(record)).not.toContain("private reasoning");
    expect(JSON.stringify(record)).not.toContain('"tokens"');
  });

  it("retains shared accepted references and hides split completion markers", () => {
    const { accepted, candidate } = sourceFixture();
    const { context, instructionSet, ...ref } = accepted;
    const inline = instructionSet.sources.flatMap((source) =>
      source.status !== "available"
        ? []
        : [
            {
              kind: source.kind,
              format: source.format,
              sourceId: source.id,
              text: Buffer.from(
                candidate.materials.find(
                  (material) => material.sourceId === source.id,
                )!.bytes,
              ).toString("utf8"),
            },
          ],
    );
    const text = ({ sourceId, text }: { sourceId: string; text: string }) => ({
      sourceId,
      text,
    });
    const wire: AcceptedAssistantWireV2 = {
      schemaVersion: 2,
      accepted: ref,
      attemptToken: ref.acceptanceId,
      context,
      stable: {
        sourceManifest: instructionSet,
        policy: text(inline.find((source) => source.kind === "policy")!),
        guidance: inline
          .filter(
            (source) => source.kind !== "policy" && source.format === "utf8",
          )
          .map(text),
        manifests: inline
          .filter((source) => source.format === "json")
          .map(text),
      },
    };
    const system = serializeAcceptedAssistantSystem(
      studioAssistantCompletionSystem(ref.acceptanceId),
      wire,
    );
    const messages = [
      user("msg_user", 1, system),
      answer("msg_done", 2, [
        { type: "text", text: "<!-- studio-res" },
        { type: "text", text: `ult:${ref.acceptanceId}:finished -->\nDone` },
      ]),
    ];
    const record = project(messages);
    expect(record.turns[0]!.acceptedContext).toEqual(ref);
    expect(record.turns[0]!.incomplete).toBe(false);
    expect(
      record.turns[0]!.messages[1]!.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toBe("Done");
    expect(JSON.stringify(record)).not.toContain("Exact profile");
    expect(() =>
      projectAssistantRecord(
        messages,
        { ...binding, contextAuthorityScope: "b".repeat(64) },
        1,
      ),
    ).toThrow(AssistantRecordError);
  });

  it("keeps public history when saved execution context is malformed", () => {
    const record = project([
      user("msg_user", 1, "StudioAssistantContext/v2\nmalformed"),
    ]);
    expect(record.turns[0]!.messages[0]!.parts[0]).toMatchObject({
      text: "Check the code",
    });
    expect(record.turns[0]!.acceptedContext).toBeNull();
    expect(record.limitations).toContain("accepted-context-unavailable");
  });

  it("makes unknown parts and attachments explicit without copying arbitrary bodies", () => {
    const record = project([
      user(),
      answer("msg_answer", 2, [
        { type: "future-part", secret: "not public" },
        {
          type: "file",
          filename: "report.txt",
          mime: "text/plain",
          url: "data:private",
        },
      ]),
    ]);
    expect(record.turns[0]!.messages[1]!.parts).toEqual([
      { id: "msg_answer_part0", type: "omitted", nativeType: "future-part" },
      {
        id: "msg_answer_part1",
        type: "file",
        name: "report.txt",
        mime: "text/plain",
      },
    ]);
    expect(record.limitations).toEqual(
      expect.arrayContaining(["unknown-parts", "attachment-content-omitted"]),
    );
    expect(JSON.stringify(record)).not.toMatch(/not public|data:private/);
  });

  it.each([
    "wrong-session",
    "wrong-parent",
    "duplicate-message",
    "duplicate-part",
    "wrong-part-parent",
    "wrong-workspace",
  ])("rejects %s identities", (failure) => {
    const prompt = user(),
      response = answer("msg_answer", 2, [{ type: "text", text: "Done" }]);
    if (failure === "wrong-session") prompt.info.sessionID = "ses_other";
    if (failure === "wrong-parent") response.info.parentID = "msg_missing";
    if (failure === "duplicate-message") response.info.id = prompt.info.id;
    if (failure === "duplicate-part")
      response.parts[0]!.id = prompt.parts[0]!.id;
    if (failure === "wrong-part-parent")
      response.parts[0]!.messageID = "msg_other";
    if (failure === "wrong-workspace") response.info.path.cwd = "/other";
    expect(() => project([prompt, response])).toThrow(AssistantRecordError);
  });

  it("caps fields and a single tool-heavy turn, retaining explicit loss and original counts", () => {
    const tool = {
      ...completedTool,
      state: { ...completedTool.state, output: "🦊".repeat(1000) },
    };
    const record = project([
      user(),
      answer("msg_answer", 2, [
        { type: "text", text: "x".repeat(5000) },
        ...Array.from({ length: 300 }, () => tool),
      ]),
    ]);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
      ASSISTANT_RECORD_MAX_BYTES,
    );
    expect(record.limitations).toEqual(
      expect.arrayContaining(["field-truncation", "dropped-message-content"]),
    );
    expect(record.messageCount).toBe(2);
    expect(record.turns[0]!.messages[0]!.id).toBe("msg_user");
    expect(
      record.turns[0]!.messages[1]!.parts.filter(
        (part) => part.type === "tool",
      ).every((part) => part.output!.length <= 512 && part.truncated),
    ).toBe(true);
  });

  it("clips retained prose and tool inputs at their separate field caps", () => {
    const record = project([
      user(),
      answer("msg_answer", 2, [
        { type: "text", text: "x".repeat(5000) },
        {
          ...completedTool,
          state: {
            ...completedTool.state,
            input: { content: "y".repeat(2000) },
          },
        },
      ]),
    ]);
    const [text, tool] = record.turns[0]!.messages[1]!.parts;
    expect(text).toMatchObject({
      type: "text",
      text: "x".repeat(4000),
      truncated: true,
    });
    expect(tool).toMatchObject({ type: "tool", truncated: true });
    expect(tool!.type === "tool" && tool.input.length).toBe(512);
    expect(record.limitations).toContain("field-truncation");
    expect(record.limitations).not.toContain("dropped-message-content");
  });

  it("drops oldest turns for the byte cap while keeping the original count", () => {
    const record = project(
      Array.from({ length: 90 }, (_, index) => {
        const prompt = user(`msg_${index}`, index + 1);
        prompt.parts[0]!.text = "z".repeat(4000);
        return prompt;
      }),
    );
    expect(record.turnCount).toBe(90);
    expect(record.turns.length).toBeLessThan(90);
    expect(record.turns.at(-1)!.id).toBe("msg_89");
    expect(record.limitations).toContain("dropped-early-turns");
    expect(() =>
      validateAssistantRecord({ ...record, messageCount: 0 }, binding),
    ).toThrow(AssistantRecordError);
  });
});
