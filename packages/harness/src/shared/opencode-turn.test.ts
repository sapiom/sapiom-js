import { describe, expect, it } from "vitest";
import {
  finalResponseAgent,
  turnRecoveryAgent,
  openCodeTurn,
  openCodeResult,
  type OpenCodeTurnMessage,
} from "./opencode-turn.js";

import {
  openCodeCompletionPrompt,
  openCodeCompletionTokens,
  openCodeVisibleText,
  openCodeVisibleParts,
} from "./opencode-completion.js";

const user: OpenCodeTurnMessage = {
  info: { id: "msg_user", role: "user", agent: "build", time: {} },
  parts: [],
};
const answer = (text: string, overrides = {}): OpenCodeTurnMessage => ({
  info: {
    id: "msg_answer",
    role: "assistant",
    agent: "build",
    parentID: "msg_user",
    finish: "stop",
    time: { completed: 1 },
    ...overrides,
  },
  parts: [{ type: "text", text }],
});

describe("overall OpenCode turn status", () => {
  it("requires a result tied to this request, not merely a preamble or another turn's footer", () => {
    const currentUser = {
      ...user,
      info: { ...user.info!, ...openCodeCompletionPrompt() },
    };
    const token = openCodeCompletionTokens([currentUser]).get("msg_user")!;
    const footer = (status = "finished") =>
      `<!-- studio-result:${token}:${status} -->`;
    const preamble = answer(
      "I'll create both files and verify the directory structure in parallel.",
    );
    expect(openCodeTurn([currentUser, preamble], "idle")).toEqual({
      status: "stopped",
      missing: "msg_answer",
    });
    for (const status of ["finished", "failed"] as const) {
      const message = answer(`CHAT_OK\n\n${footer(status)}`);
      expect(openCodeTurn([currentUser, message], "idle")).toEqual({ status });
      expect(openCodeResult(message, token)?.answer).toBe("CHAT_OK");
      const prefixed = answer(`${footer(status)}\nCHAT_OK`);
      expect(openCodeTurn([currentUser, prefixed], "idle")).toEqual({ status });
      expect(openCodeResult(prefixed, token)?.answer).toBe("CHAT_OK");
    }
    for (const text of [
      footer(),
      `Done\n${footer("unknown")}`,
      `Done\n${footer()}\n${footer()}`,
      `Done ${footer()}`,
      `\`\`\`html\n${footer()}`,
      `~~~html\n${footer()}`,
      `${footer()} CHAT_OK`,
      `${footer()}\nCHAT_OK\n${footer()}`,
      "Done\n<!-- studio-result:00000000-0000-0000-0000-000000000000:finished -->",
    ]) {
      const turn = openCodeTurn([currentUser, answer(text)], "idle");
      expect(turn.status).not.toBe("finished");
      expect(turn).toMatchObject({
        missing: "msg_answer",
      });
    }
    expect(
      openCodeResult(answer(`\`\`\`js\nadd(2, 3)\n\`\`\`\n${footer()}`), token)
        ?.status,
    ).toBe("finished");
    for (const finish of ["length", "content-filter", "error", "unknown"]) {
      const interrupted = answer(`Done\n${footer()}`, { finish });
      expect(openCodeResult(interrupted, token)).toBeUndefined();
      expect(openCodeTurn([currentUser, interrupted], "idle")).toEqual({
        status: "failed",
      });
      expect(
        openCodeResult(answer(`${footer()}\nCHAT_OK`, { finish }), token),
      ).toBeUndefined();
    }
    const premature = {
      ...answer(`Tests passed\n${footer()}`),
      parts: [
        ...answer(`Tests passed\n${footer()}`).parts,
        { type: "tool", tool: "bash", state: { status: "completed" } },
      ],
    };
    expect(openCodeResult(premature, token)).toBeUndefined();
    expect(openCodeTurn([currentUser, premature], "idle")).toEqual({
      status: "failed",
      missing: "msg_answer",
    });
    premature.parts[1] = {
      type: "tool",
      tool: "bash",
      state: { status: "error" },
    };
    expect(openCodeTurn([currentUser, premature], "idle")).toEqual({
      status: "failed",
    });
    expect(
      openCodeTurn(
        [
          {
            ...currentUser,
            info: { ...currentUser.info, agent: turnRecoveryAgent },
          },
          answer("I'll do it next", { agent: turnRecoveryAgent }),
        ],
        "idle",
      ),
    ).toEqual({ status: "stopped" });
  });

  it("preserves completion checks across native compaction without inheriting them into unrelated legacy requests", () => {
    const currentUser = {
      ...user,
      info: { ...user.info!, ...openCodeCompletionPrompt() },
    };
    const compacted = {
      ...user,
      info: { ...user.info!, id: "msg_compaction" },
      parts: [
        {
          type: "text",
          synthetic: true,
          metadata: { compaction_continue: true },
        },
      ],
    };
    expect(
      openCodeTurn(
        [
          currentUser,
          {
            ...user,
            info: { ...user.info!, id: "msg_compaction_control" },
            parts: [{ type: "compaction" }],
          },
          answer("Conversation summary", {
            parentID: "msg_compaction_control",
            summary: true,
          }),
          compacted,
          answer("I'll create the files", { parentID: "msg_compaction" }),
        ],
        "idle",
      ),
    ).toEqual({ status: "stopped", missing: "msg_answer" });
    expect(
      openCodeTurn([currentUser, user, answer("CHAT_OK")], "idle"),
    ).toEqual({ status: "finished" });
  });

  it.each(["current", "different"])(
    "hides a %s turn's result marker throughout streaming and preserves ordinary text",
    (turn) => {
      const currentUser = {
        ...user,
        info: { ...user.info!, ...openCodeCompletionPrompt() },
      };
      const token = openCodeCompletionTokens([currentUser]).get("msg_user")!;
      const markerToken =
        turn === "current" ? token : "00000000-0000-0000-0000-000000000000";
      const footer = `<!-- studio-result:${markerToken}:finished -->`;
      for (let size = 1; size <= footer.length; size++) {
        expect(
          openCodeVisibleText(
            `CHAT_OK\n\n${footer.slice(0, size)}`,
            token,
            true,
          ),
        ).toBe("CHAT_OK");
        const parts = [
          { type: "text", text: `CHAT_OK\n\n${footer.slice(0, size)}` },
          { type: "tool" },
          { type: "text", text: footer.slice(size) },
        ];
        expect(openCodeVisibleParts(parts, token, true)).toEqual([
          "CHAT_OK",
          undefined,
          "",
        ]);
        expect(openCodeVisibleText(footer.slice(0, size), token, true)).toBe(
          "",
        );
        expect(
          openCodeVisibleParts(
            [
              { type: "text", text: footer.slice(0, size) },
              { type: "text", text: footer.slice(size) + "\nCHAT_OK" },
            ],
            token,
            true,
          ),
        ).toEqual(["", "CHAT_OK"]);
      }
      expect(openCodeVisibleText("Use x < y in the condition", token)).toBe(
        "Use x < y in the condition",
      );
      expect(openCodeVisibleText("CHAT_OK", undefined)).toBe("CHAT_OK");
      expect(
        openCodeVisibleText(
          "Keep <!-- ordinary comment --> in the example",
          token,
        ),
      ).toBe("Keep <!-- ordinary comment --> in the example");
      expect(openCodeVisibleText(footer, undefined)).toBe(footer);
    },
  );

  it.each(["finished", "failed"])(
    "hides a mismatched %s marker without confirming the recovered turn",
    (status) => {
      const currentUser = {
        ...user,
        info: {
          ...user.info!,
          agent: turnRecoveryAgent,
          ...openCodeCompletionPrompt(),
        },
      };
      const token = openCodeCompletionTokens([currentUser]).get("msg_user")!;
      const marker = `<!-- studio-result:00000000-0000-0000-0000-000000000000:${status} -->`;
      for (const text of [
        `${marker}\nThe tool call completed.`,
        `The tool call completed.\n\n${marker}`,
      ]) {
        const message = answer(text, { agent: turnRecoveryAgent });
        expect(openCodeVisibleText(text, token)).toBe(
          "The tool call completed.",
        );
        expect(openCodeResult(message, token)).toBeUndefined();
        expect(openCodeTurn([currentUser, message], "idle")).toEqual({
          status: "stopped",
        });
      }
    },
  );

  it("preserves progress and the answer around multiple markers across tool parts", () => {
    const token = "11111111-1111-1111-1111-111111111111";
    const marker =
      "<!-- studio-result:00000000-0000-0000-0000-000000000000:finished -->";
    const parts = [
      { type: "text", text: "Checking the README.\n\n" + marker.slice(0, 30) },
      { type: "tool" },
      {
        type: "text",
        text:
          marker.slice(30) +
          "\nThe README describes this project.\n\n" +
          marker,
      },
    ];
    expect(openCodeVisibleParts(parts, token)).toEqual([
      "Checking the README.\n\n",
      undefined,
      "\nThe README describes this project.",
    ]);
    expect(
      openCodeVisibleText(parts.map((part) => part.text ?? "").join(""), token),
    ).toBe("Checking the README.\n\n\nThe README describes this project.");
  });

  it.each([
    "Document the <!-- studio-result: placeholder used by Studio.",
    "<!-- studio-result:not-a-uuid:finished --> is only an example.",
    "<!-- studio-result:00000000-0000-0000-0000-00000000000g:finished --> is invalid.",
    "<!-- studio-result:000000000000-0000-0000-0000-00000000:finished --> is invalid.",
    "<!-- studio-result:00000000-0000-0000-0000-000000000000:unknown --> is invalid.",
    "<!-- studio-result:00000000-0000-0000-0000-000000000000:finished without a delimiter.",
  ])(
    "preserves invalid marker prose while streaming and after completion: %s",
    (text) => {
      const token = "11111111-1111-1111-1111-111111111111";
      for (const streaming of [true, false]) {
        expect(openCodeVisibleText(text, token, streaming)).toBe(text);
        for (let split = 0; split <= text.length; split++) {
          const parts = [
            { type: "text", text: text.slice(0, split) },
            { type: "tool" },
            { type: "text", text: text.slice(split) },
          ];
          expect(
            openCodeVisibleParts(parts, token, streaming)
              .filter((part) => part !== undefined)
              .join(""),
          ).toBe(text);
        }
      }
    },
  );

  it("restores incomplete marker candidates when streaming ends", () => {
    const token = "11111111-1111-1111-1111-111111111111";
    const marker =
      "<!-- studio-result:00000000-0000-0000-0000-000000000000:finished -->";
    for (let size = 1; size < marker.length; size++) {
      const text = `Example: ${marker.slice(0, size)}`;
      expect(openCodeVisibleText(text, token, true)).toBe("Example:");
      expect(openCodeVisibleText(text, token)).toBe(text);
      expect(openCodeVisibleParts([{ type: "text", text }], token)).toEqual([
        text,
      ]);
    }
    expect(openCodeVisibleText("Use x <", token)).toBe("Use x <");
  });

  it("keeps scanning for real markers after invalid prose", () => {
    const token = "11111111-1111-1111-1111-111111111111";
    const prose =
      "Document the <!-- studio-result: placeholder used by Studio.";
    const marker = `<!-- studio-result:00000000-0000-0000-0000-000000000000:failed -->`;
    expect(openCodeVisibleText(`${prose}\n\n${marker}`, token)).toBe(prose);
    expect(openCodeVisibleText(`${marker}\n\n${prose}`, token)).toBe(prose);
  });

  it("requires known idle state and a completed final answer", () => {
    const messages = [user, answer("Here is the explanation")];
    expect(openCodeTurn(messages, undefined).status).toBe("unknown");
    expect(openCodeTurn(messages, "busy").status).toBe("working");
    expect(openCodeTurn(messages, "retry").status).toBe("working");
    expect(openCodeTurn(messages, "idle").status).toBe("finished");
    expect(openCodeTurn([], "idle").status).toBe("ready");
  });

  it("does not mistake tool steps, preambles, or old answers for a final answer", () => {
    const preamble = answer("I'll read the files", { finish: "tool-calls" });
    expect(openCodeTurn([user, preamble], "idle").status).toBe("failed");
    expect(openCodeTurn([user, preamble, answer("  ")], "idle")).toEqual({
      status: "failed",
      missing: "msg_answer",
    });
    expect(
      openCodeTurn(
        [user, answer("Old response", { parentID: "msg_old" })],
        "idle",
      ).status,
    ).toBe("failed");
    expect(
      openCodeTurn(
        [user, answer("Compacted history", { summary: true })],
        "idle",
      ).status,
    ).toBe("failed");
  });

  it("does not recover errors, interrupted responses, or a failed recovery again", () => {
    for (const overrides of [
      { error: {} },
      { finish: "length" },
      { time: {} },
      { agent: finalResponseAgent },
      { agent: turnRecoveryAgent },
      { agent: "plan" },
    ])
      expect(openCodeTurn([user, answer("", overrides)], "idle")).toEqual({
        status: "failed",
      });
    expect(
      openCodeTurn([user, answer("Partial text", { error: {} })], "idle")
        .status,
    ).toBe("failed");
    // Permission/question rejection can stop a tool without assistant.error.
    expect(
      openCodeTurn(
        [user, { ...answer(""), parts: [{ type: "tool" }] }],
        "idle",
      ),
    ).toEqual({ status: "failed" });
  });

  it("does not mistake a recovery summary for completion of the original task", () => {
    const recoveryUser = {
      ...user,
      info: { ...user.info!, id: "msg_recovery", agent: finalResponseAgent },
    };
    const messages = [
      user,
      answer(""),
      recoveryUser,
      answer(
        "Only a todo list was created. No files were written or tests run.",
        {
          agent: finalResponseAgent,
          parentID: "msg_recovery",
        },
      ),
    ];
    expect(openCodeTurn(messages, "idle")).toEqual({ status: "failed" });
    expect(
      openCodeTurn(
        [...messages, user, answer("Files created; 3 tests passed.")],
        "idle",
      ),
    ).toEqual({ status: "finished" });
  });

  it("allows a continuation to finish, but never automatically continues it again", () => {
    const continued = {
      ...user,
      info: { ...user.info!, agent: turnRecoveryAgent },
    };
    expect(
      openCodeTurn(
        [
          continued,
          answer("Files created and tests passed.", {
            agent: turnRecoveryAgent,
          }),
        ],
        "idle",
      ),
    ).toEqual({ status: "finished" });
    expect(
      openCodeTurn(
        [continued, answer("", { agent: turnRecoveryAgent })],
        "idle",
      ),
    ).toEqual({ status: "failed" });
  });
});
