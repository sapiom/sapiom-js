import { describe, expect, it } from "vitest";
import {
  openCodeCompletionPrompt,
  openCodeCompletionTokens,
  openCodeConversationToken,
} from "./opencode-completion.js";
import { openCodeTurn, type OpenCodeTurnMessage } from "./opencode-turn.js";

const marker = (token: string, status = "finished") =>
  `<!-- studio-result:${token}:${status} -->`;

/** One map chat turn sent the way the router sends it. */
function prompt(
  history: readonly OpenCodeTurnMessage[],
  id: string,
): OpenCodeTurnMessage {
  return {
    info: {
      id,
      role: "user",
      agent: "build",
      time: {},
      ...openCodeCompletionPrompt({
        mapChat: true,
        token: openCodeConversationToken(history),
      }),
    },
    parts: [{ type: "text", text: "Which agent is simplest?" }],
  };
}

const answer = (
  id: string,
  parentID: string,
  text: string,
  overrides: Partial<NonNullable<OpenCodeTurnMessage["info"]>> = {},
  parts: OpenCodeTurnMessage["parts"] = [],
): OpenCodeTurnMessage => ({
  info: {
    id,
    role: "assistant",
    agent: "build",
    parentID,
    finish: "stop",
    time: { completed: 1 },
    ...overrides,
  },
  parts: [...parts, { type: "text", text }],
});

const tokenOf = (messages: readonly OpenCodeTurnMessage[], id: string) =>
  openCodeCompletionTokens(messages).get(id)!;

describe("one result token per conversation (SAP-3876)", () => {
  it("mints a token for a new conversation and reuses it for every later turn", () => {
    expect(openCodeConversationToken([])).toBeUndefined();
    const history: OpenCodeTurnMessage[] = [prompt([], "msg_u1")];
    const first = tokenOf(history, "msg_u1");
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    history.push(answer("msg_a1", "msg_u1", `${marker(first)}\nHello`));
    for (let turn = 2; turn <= 7; turn++) {
      history.push(prompt(history, `msg_u${turn}`));
      expect(tokenOf(history, `msg_u${turn}`)).toBe(first);
      history.push(
        answer(`msg_a${turn}`, `msg_u${turn}`, `${marker(first)}\nok`),
      );
      expect(openCodeTurn(history, "idle")).toEqual({ status: "finished" });
    }
  });

  it("reads a later turn that copies the first turn's marker as finished, not missing", () => {
    const history: OpenCodeTurnMessage[] = [prompt([], "msg_u1")];
    const first = tokenOf(history, "msg_u1");
    history.push(answer("msg_a1", "msg_u1", `${marker(first)}\nHello`));
    history.push(prompt(history, "msg_u2"));
    // The p42a run: the answer carries the token it wrote one turn earlier.
    history.push(answer("msg_a2", "msg_u2", `${marker(first)}\nready`));
    expect(openCodeTurn(history, "idle")).toEqual({ status: "finished" });
  });

  it("follows the token the model already echoes in a conversation that predates the fix", () => {
    // Recorded shape of ses_ef62…: per-request tokens, and from turn 3 on
    // every answer repeated turn 2's token.
    const legacy = (id: string, token: string): OpenCodeTurnMessage => ({
      info: {
        id,
        role: "user",
        agent: "build",
        time: {},
        system: `StudioAssistantResult/v2:${token}\n`,
      },
      parts: [],
    });
    const t1 = "f9d79743-28c1-4361-820c-26b6cbda5f4e";
    const t2 = "d5d56cb2-31e1-4ff3-87b4-8e751cec1ea3";
    const t3 = "50accf0f-8cf8-49a4-8c59-c33ff36e1e30";
    const history: OpenCodeTurnMessage[] = [
      legacy("msg_u1", t1),
      answer("msg_a1", "msg_u1", `${marker(t1)}\none`),
      legacy("msg_u2", t2),
      answer("msg_a2", "msg_u2", `${marker(t2)}\ntwo`),
      legacy("msg_u3", t3),
      answer("msg_a3", "msg_u3", `${marker(t2)}\nthree`),
      // A reply that declares t2 and quotes turn 1 still echoes t2.
      answer(
        "msg_a3b",
        "msg_u3",
        `${marker(t2)}\nEarlier I wrote:\n${marker(t1)}\none`,
      ),
      // The user quoting an old answer is not the model echoing it.
      {
        info: { id: "msg_quote", role: "user", agent: "build", time: {} },
        parts: [{ type: "text", text: `${marker(t1)}\none` }],
      },
    ];
    expect(openCodeConversationToken(history)).toBe(t2);
    history.push(prompt(history, "msg_u4"));
    history.push(answer("msg_a4", "msg_u4", `${marker(t2)}\nfour`));
    expect(openCodeTurn(history, "idle")).toEqual({ status: "finished" });
  });

  it("never adopts a token the server did not mint for this conversation", () => {
    const made = "00000000-0000-4000-8000-000000000000";
    const history: OpenCodeTurnMessage[] = [prompt([], "msg_u1")];
    const first = tokenOf(history, "msg_u1");
    history.push(
      answer("msg_a1", "msg_u1", `${marker(made)}\nHello`),
      // A marker quoted by the user or carried in a tool result is not an echo.
      {
        info: { id: "msg_u2", role: "user", agent: "build", time: {} },
        parts: [{ type: "text", text: marker(made) }],
      },
    );
    expect(openCodeConversationToken(history)).toBe(first);
    history.push(prompt(history, "msg_u3"));
    history.push(answer("msg_a3", "msg_u3", `${marker(made)}\nready`));
    expect(openCodeTurn(history, "idle")).toEqual({
      status: "stopped",
      missing: "msg_a3",
    });
  });

  it("does not let an unfinished turn read as finished because its marker is reused", () => {
    const history: OpenCodeTurnMessage[] = [prompt([], "msg_u1")];
    const first = tokenOf(history, "msg_u1");
    history.push(answer("msg_a1", "msg_u1", `${marker(first)}\nHello`));
    history.push(prompt(history, "msg_u2"));
    const text = `${marker(first)}\nI'll check the steps next.`;
    const unfinished = [
      // Still choosing tools.
      answer("msg_a2", "msg_u2", text, { finish: "tool-calls" }),
      // A tool call alongside the marker.
      answer("msg_a2", "msg_u2", text, {}, [
        { type: "tool", tool: "read", state: { status: "completed" } },
      ]),
      // A native error.
      answer("msg_a2", "msg_u2", text, { error: { name: "APIError" } }),
      // Interrupted before completion.
      answer("msg_a2", "msg_u2", text, { time: {} }),
    ];
    for (const message of unfinished)
      expect(openCodeTurn([...history, message], "idle").status).toBe("failed");
    // An answer with no marker still reads as missing and gets recovery.
    expect(
      openCodeTurn(
        [...history, answer("msg_a2", "msg_u2", "I'll check the steps next.")],
        "idle",
      ),
    ).toEqual({ status: "stopped", missing: "msg_a2" });
  });
});
