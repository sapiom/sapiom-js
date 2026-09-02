import { describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH,
  ManagedAgentEventError,
  ManagedAgentEventRecorder,
  normalizeManagedAgentToolUseId,
} from "./events.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("ManagedAgentEventRecorder", () => {
  it("retains structural evidence while redacting message and tool content", () => {
    const recorder = new ManagedAgentEventRecorder("run-1", "expected-model");
    recorder.observeSdkEvent({
      type: "system",
      subtype: "init",
      session_id: SESSION_ID,
      model: "model-secret-must-not-be-copied",
    });
    recorder.observeSdkEvent({
      type: "assistant",
      session_id: SESSION_ID,
      message: {
        id: "message-1",
        content: [
          { type: "text", text: "prompt-secret" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/private/secret-path", token: "tool-secret" },
          },
        ],
      },
    });
    recorder.observeSdkEvent({
      type: "user",
      session_id: SESSION_ID,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "private-file-contents",
            is_error: false,
          },
        ],
      },
    });
    recorder.observeSdkEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION_ID,
      result: "private-final-answer",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      },
      total_cost_usd: 0.001,
      num_turns: 7,
      modelUsage: {
        "unexpected-model": {
          inputTokens: 7,
          outputTokens: 3,
        },
      },
    });
    expect(recorder.recordTerminal("success")).toBe(true);
    expect(recorder.recordTerminal("query_error")).toBe(false);

    expect(recorder.sessionId).toBe(SESSION_ID);
    expect(recorder.usage).toEqual({
      authority: "sdk_non_authoritative",
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 1,
      estimatedCostUsd: 0.001,
    });
    expect(recorder.inferenceTurns).toBe(1);
    expect(recorder.sdkNumTurns).toBe(7);
    expect(recorder.modelEvidence).toEqual({
      authority: "sdk_non_authoritative",
      initModelObserved: true,
      initModelMatchesExpectedAlias: false,
      resultModelUsageObserved: true,
      resultModelUsageMatchesExpectedAlias: false,
      resultModelCount: 1,
    });
    expect(recorder.toolEvidence).toEqual([
      {
        toolUseId: normalizeManagedAgentToolUseId("tool-1"),
        toolName: "Read",
        status: "requested",
      },
      {
        toolUseId: normalizeManagedAgentToolUseId("tool-1"),
        toolName: "Read",
        status: "success",
      },
    ]);
    expect(
      recorder.events.filter(({ type }) => type === "terminal"),
    ).toHaveLength(1);
    const serialized = JSON.stringify(recorder.events);
    for (const secret of [
      "model-secret",
      "prompt-secret",
      "/private/secret-path",
      "tool-secret",
      "private-file-contents",
      "private-final-answer",
      "tool-1",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("redacts attacker-controlled session, tool, and permission identifiers from all evidence", () => {
    const recorder = new ManagedAgentEventRecorder("run-2", "expected-model");
    const sessionSecret = "session-secret-credential";
    const toolIdSecret = "tool-id-secret-credential";
    const permissionIdSecret = "permission-id-secret-credential";
    const toolNameSecret = "ReadSecretCredential";
    const permissionNameSecret = "WriteSecretCredential";
    const messageIdSecret = "message-id-secret-credential";
    recorder.observeSdkEvent({
      type: "system",
      subtype: "init",
      session_id: sessionSecret,
    });
    recorder.observeSdkEvent({
      type: "assistant",
      session_id: sessionSecret,
      message: {
        id: messageIdSecret,
        content: [
          {
            type: "tool_use",
            id: toolIdSecret,
            name: toolNameSecret,
            input: {},
          },
        ],
      },
    });
    recorder.observeSdkEvent({
      type: "user",
      session_id: sessionSecret,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolIdSecret,
            content: "private-result",
          },
        ],
      },
    });
    recorder.recordPermission({
      toolUseId: permissionIdSecret,
      toolName: permissionNameSecret,
      decision: "deny",
      reason: "tool_not_allowed",
      source: "pre_tool_use",
      operationId: "unknown",
    });
    recorder.recordTerminal("success");

    expect(recorder.sessionId).toBeUndefined();
    expect(recorder.toolEvidence[0]?.toolName).toBe("unknown");
    expect(recorder.toolEvidence.map(({ toolUseId }) => toolUseId)).toEqual([
      normalizeManagedAgentToolUseId(toolIdSecret),
      normalizeManagedAgentToolUseId(toolIdSecret),
    ]);
    expect(recorder.permissionEvidence).toEqual([
      {
        toolUseId: normalizeManagedAgentToolUseId(permissionIdSecret),
        toolName: "unknown",
        decision: "deny",
        reason: "tool_not_allowed",
        source: "pre_tool_use",
        operationId: "unknown",
      },
    ]);
    const serialized = JSON.stringify({
      sdkSessionId: recorder.sessionId,
      events: recorder.events,
      toolEvidence: recorder.toolEvidence,
      permissionEvidence: recorder.permissionEvidence,
    });
    for (const secret of [
      sessionSecret,
      toolIdSecret,
      permissionIdSecret,
      toolNameSecret,
      permissionNameSecret,
      messageIdSecret,
      "private-result",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("requires both SDK init and result usage to report only the selected alias", () => {
    const expectedModel = "claude-sonnet-5-anthropic-anthropic-eval";
    const recorder = new ManagedAgentEventRecorder("run-model", expectedModel);
    recorder.observeSdkEvent({
      type: "system",
      subtype: "init",
      model: expectedModel,
    });
    recorder.observeSdkEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      modelUsage: { [expectedModel]: { inputTokens: 1, outputTokens: 1 } },
    });

    expect(recorder.modelEvidence).toEqual({
      authority: "sdk_non_authoritative",
      initModelObserved: true,
      initModelMatchesExpectedAlias: true,
      resultModelUsageObserved: true,
      resultModelUsageMatchesExpectedAlias: true,
      resultModelCount: 1,
    });
  });

  it("rejects missing, empty, and overlong tool-use identifiers instead of normalizing sentinels", () => {
    const invalidIds = [
      undefined,
      "",
      "   ",
      "x".repeat(MANAGED_AGENT_TOOL_USE_ID_MAX_LENGTH + 1),
    ];
    for (const invalidId of invalidIds) {
      expect(() => normalizeManagedAgentToolUseId(invalidId)).toThrow(
        ManagedAgentEventError,
      );

      const requested = new ManagedAgentEventRecorder(
        "invalid-requested",
        "expected-model",
      );
      expect(() =>
        requested.observeSdkEvent({
          type: "assistant",
          message: {
            id: "bounded-message-id",
            content: [
              {
                type: "tool_use",
                id: invalidId,
                name: "Read",
                input: { file_path: "private-path" },
              },
            ],
          },
        }),
      ).toThrow(ManagedAgentEventError);
      expect(requested.toolEvidence).toEqual([]);

      const completed = new ManagedAgentEventRecorder(
        "invalid-completed",
        "expected-model",
      );
      expect(() =>
        completed.observeSdkEvent({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: invalidId,
                content: "private-result",
              },
            ],
          },
        }),
      ).toThrow(ManagedAgentEventError);
      expect(completed.toolEvidence).toEqual([]);
    }
  });

  it("counts distinct hashed assistant ids and keeps bounded SDK turns separate", () => {
    const recorder = new ManagedAgentEventRecorder("run-3", "expected-model");
    for (const messageId of [
      "private-message-a",
      "private-message-a",
      "private-message-b",
    ]) {
      recorder.observeSdkEvent({
        type: "assistant",
        message: { id: messageId, content: [{ type: "text", text: "secret" }] },
      });
    }
    recorder.observeSdkEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 9,
    });

    expect(recorder.inferenceTurns).toBe(2);
    expect(recorder.sdkNumTurns).toBe(9);
    const serialized = JSON.stringify({
      events: recorder.events,
      inferenceTurns: recorder.inferenceTurns,
      sdkNumTurns: recorder.sdkNumTurns,
    });
    expect(serialized).not.toContain("private-message-a");
    expect(serialized).not.toContain("private-message-b");

    expect(() =>
      recorder.observeSdkEvent({
        type: "result",
        subtype: "success",
        num_turns: 21,
      }),
    ).toThrow(ManagedAgentEventError);
    expect(() =>
      recorder.observeSdkEvent({
        type: "assistant",
        message: { content: [] },
      }),
    ).toThrow(ManagedAgentEventError);
  });
});
