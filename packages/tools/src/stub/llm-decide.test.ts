/**
 * The local `llm.decide` stub: `run_local` must return an answer of the right
 * shape for every question type (keys preserved, probabilities well-formed) so
 * step code that branches on `noul` / `choice` / `score` runs unchanged, and a
 * step stub can still override the whole reply.
 */
import { LlmDecideHttpError } from "../llm/index.js";
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

    // Undecided means uniform: the stub must never hand a local branch a certain
    // verdict it did not earn. Midpoint score, 1/n everywhere, confidence 1/n.
    expect(res.answers.mood.type).toBe("score");
    expect(res.answers.mood.score).toBe(1);
    expect(res.answers.mood.legend).toEqual({
      "0": "calm",
      "1": "frustrated",
      "2": "angry",
    });
    expect(Object.keys(res.answers.mood.probabilities)).toEqual([
      "0",
      "1",
      "2",
    ]);
    for (const p of Object.values(res.answers.mood.probabilities)) {
      expect(p).toBeCloseTo(1 / 3);
    }
    expect(res.answers.mood.confidence).toBeCloseTo(1 / 3);
    expect(res.answers.team.confidence).toBe(0.5);
  });

  it("answers a question keyed `__proto__` as an own property, like the JSON wire does", async () => {
    const client = createStubClient();
    // Through JSON.parse `__proto__` is an ordinary own key, exactly as a caller
    // building questions from parsed input would produce it.
    const questions = JSON.parse(
      '{"__proto__":{"type":"noul","instructions":"Is this valid?"},"ok":{"type":"noul","instructions":"Ok?"}}',
    ) as Record<string, { type: "noul"; instructions: string }>;

    const res = await client.llm.decide({ state: "x", questions });

    expect(Object.keys(res.answers).sort((a, b) => a.localeCompare(b))).toEqual(
      ["__proto__", "ok"],
    );
    expect(
      Object.getOwnPropertyDescriptor(res.answers, "__proto__")?.value,
    ).toEqual({
      type: "noul",
      noul: 0.5,
    });
    // ...and the map is still a normal object, as parsed JSON is: local code
    // calling inherited methods must not hit a null prototype.
    expect(Object.getPrototypeOf(res.answers)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(res.answers, "ok")).toBe(true);
    // The direct call is the finding under test (inherited methods must work),
    // so the lint rule that would route it through Object.prototype is off here.
    // eslint-disable-next-line no-prototype-builtins
    expect(res.answers.hasOwnProperty("ok")).toBe(true);
  });

  describe("rejects what the router rejects, as the same LlmDecideHttpError 400", () => {
    const cases: Array<{
      name: string;
      questions: Record<string, unknown>;
      message: string;
    }> = [
      {
        name: "an empty score rubric",
        questions: { mood: { type: "score", instructions: "?", criteria: [] } },
        message: "question 'mood' score criteria must have at least two levels",
      },
      {
        name: "a single-level score rubric",
        questions: {
          mood: { type: "score", instructions: "?", criteria: ["only"] },
        },
        message: "question 'mood' score criteria must have at least two levels",
      },
      {
        name: "a score rubric with more than 10 levels",
        questions: {
          mood: {
            type: "score",
            instructions: "?",
            criteria: Array.from({ length: 11 }, (_, i) => `level-${i}`),
          },
        },
        message: "question 'mood' score criteria must have at most 10 levels",
      },
      {
        name: "a single-option choice",
        questions: {
          team: { type: "choice", instructions: "?", criteria: { only: null } },
        },
        message:
          "question 'team' choice criteria must have at least two options",
      },
    ];

    for (const { name, questions, message } of cases) {
      it(name, async () => {
        const client = createStubClient();
        const call = client.llm.decide({
          state: "x",
          questions: questions as never,
        });
        await expect(call).rejects.toThrow(LlmDecideHttpError);
        await expect(call).rejects.toMatchObject({
          status: 400,
          body: { statusCode: 400, message },
        });
      });
    }
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
