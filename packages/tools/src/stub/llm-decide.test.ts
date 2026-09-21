/**
 * The local `llm.decide` stub: `run_local` must return an answer of the right
 * shape for every question type (keys preserved, probabilities well-formed) so
 * step code that branches on `noul` / `choice` / `score` runs unchanged, and a
 * step stub can still override the whole reply.
 */
import { createStubClient, type StubCallRecord } from "./index.js";

describe("stub llm.decide", () => {
  it("answers every question under its own key, in its type's shape", async () => {
    const client = createStubClient();

    const res = await client.llm.decide({
      state: "x",
      questions: {
        urgent: { type: "noul", instructions: "Is it urgent?" },
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: { shipping: null, billing: null },
        },
        mood: {
          type: "score",
          instructions: "How upset?",
          criteria: ["calm", "frustrated", "angry"],
        },
      },
    });

    expect(res.servedBy).toBe("stub");
    expect(Object.keys(res.answers).sort((a, b) => a.localeCompare(b))).toEqual(
      ["mood", "team", "urgent"],
    );

    expect(res.answers.urgent).toEqual({ type: "noul", noul: 0.5 });

    expect(res.answers.team.type).toBe("choice");
    expect(res.answers.team.choice).toBe("shipping");
    expect(res.answers.team.probabilities).toEqual({
      shipping: 0.5,
      billing: 0.5,
    });

    expect(res.answers.mood.type).toBe("score");
    expect(res.answers.mood.score).toBe(0);
    expect(res.answers.mood.legend).toEqual({
      "0": "calm",
      "1": "frustrated",
      "2": "angry",
    });
    expect(res.answers.mood.probabilities).toEqual({ "0": 1, "1": 0, "2": 0 });
  });

  it("records the call under the capability id and lets an override replace the reply", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({
      calls,
      overrides: {
        "llm.decide": {
          model: "jev-override",
          answers: { urgent: { type: "noul", noul: 0.99 } },
          usage: { inputTokens: 1, outputTokens: 1 },
          servedBy: "override",
        },
      },
    });

    const res = await client.llm.decide({
      state: "x",
      questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
    });

    expect(res.answers.urgent.noul).toBe(0.99);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      capability: "llm.decide",
      stubUsed: true,
    });
  });
});
