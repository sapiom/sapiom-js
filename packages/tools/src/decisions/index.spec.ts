/**
 * decisions.evaluate() — routed wire shape (`POST /v1/capabilities/decisions.evaluate` on the Core
 * base URL, `x-api-key` credential), verbatim pass-through of state/questions,
 * `model` forwarded only when set, public response data preserved, and a
 * non-2xx mapped to DecisionsHttpError. Real Transport, scripted fetch — no network.
 */
import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import {
  evaluate,
  DecisionsHttpError,
  type DecisionsEvaluateResponse,
  type DecisionsEvaluateSpec,
} from "./index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handler: (call: FetchCall) => Response | Promise<Response>,
  apiKey: string | undefined = "test-key",
): {
  transport: Transport;
  calls: FetchCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof globalThis.fetch;
  return {
    transport: new Transport({ apiKey, fetch: fetchMock }),
    calls,
    fetch: fetchMock,
  };
}

// Public decision data returned by the HTTP API, without routing identity.
const SPEC = {
  state: {
    message:
      "The customer says the package has not arrived and they need it for a wedding tomorrow.",
  },
  questions: {
    isUrgent: {
      type: "noul",
      instructions: "Is this support request urgent?",
      criteria: {
        true: "Immediate action needed",
        false: "Can wait for normal support",
      },
    },
    route: {
      type: "choice",
      instructions: "Which team should handle `message`?",
      criteria: {
        shipping: "Delivery and carrier issues",
        billing: "Charges and refunds",
        other: null,
      },
    },
    sentiment: {
      type: "score",
      instructions: "How upset is the customer in `message`?",
      criteria: ["calm", "concerned", "frustrated", "angry"],
    },
  },
} satisfies DecisionsEvaluateSpec;

const PUBLIC_RESPONSE = {
  answers: {
    isUrgent: { type: "noul", noul: 0.95 },
    route: {
      type: "choice",
      choice: "shipping",
      confidence: 1,
      probabilities: { shipping: 1, billing: 0, other: 0 },
    },
    sentiment: {
      type: "score",
      score: 1.28,
      confidence: 0.71,
      legend: {
        "0": "calm",
        "1": "concerned",
        "2": "frustrated",
        "3": "angry",
      },
      probabilities: { "0": 0, "1": 0.72, "2": 0.28, "3": 0 },
    },
  },
  usage: { inputTokens: 433, outputTokens: 71 },
} satisfies DecisionsEvaluateResponse<typeof SPEC.questions>;

describe("decisions.evaluate", () => {
  it("POSTs the routed capability on the Core base URL with the tenant credential", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(PUBLIC_RESPONSE),
    );

    const res = await evaluate(SPEC, transport, "https://core.test");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://core.test/v1/capabilities/decisions.evaluate",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(res).toEqual(PUBLIC_RESPONSE);
    // @ts-expect-error Routing identity is not part of the public response type.
    expect(res.model).toBeUndefined();
    // @ts-expect-error Routing identity is not part of the public response type.
    expect(res.servedBy).toBeUndefined();
    expect(res).not.toHaveProperty("model");
    expect(res).not.toHaveProperty("servedBy");
    expect(res).not.toHaveProperty("cost");
  });

  it.each([0, 0.000035112])(
    "preserves a cost estimate of %s and its metadata",
    async (estimateUsd) => {
      const cost = {
        estimateUsd,
        currency: "USD",
        reference: "transaction-test",
        isEstimate: true,
        source: "quote",
      };
      const response = { ...PUBLIC_RESPONSE, cost };
      const { transport } = makeTransport(() => jsonResponse(response));

      const res = await evaluate(SPEC, transport, "https://core.test");

      expect(res).toEqual(response);
      const estimate: number | undefined = res.cost?.estimateUsd;
      const source: "quote" | undefined = res.cost?.source;
      expect(estimate).toBe(estimateUsd);
      expect(source).toBe("quote");
    },
  );

  it("keeps answer keys named model and servedBy", async () => {
    const spec = {
      state: "test",
      questions: {
        model: { type: "noul", instructions: "Is this a model?" },
        servedBy: { type: "noul", instructions: "Was this served?" },
      },
    } satisfies DecisionsEvaluateSpec;
    const response = {
      answers: {
        model: { type: "noul", noul: 0 },
        servedBy: { type: "noul", noul: 1 },
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const { transport } = makeTransport(() => jsonResponse(response));

    expect(await evaluate(spec, transport, "https://core.test")).toEqual(
      response,
    );
  });

  it("forwards state and questions verbatim and omits model when unset", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(PUBLIC_RESPONSE),
    );

    await evaluate(SPEC, transport, "https://core.test");

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      state: SPEC.state,
      questions: SPEC.questions,
    });
  });

  it("forwards an explicit model", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(PUBLIC_RESPONSE),
    );

    await evaluate(
      { ...SPEC, model: "systemone-1.0.0" },
      transport,
      "https://core.test",
    );

    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      model: "systemone-1.0.0",
    });
  });

  it("types answers by the questions passed", async () => {
    const { transport } = makeTransport(() => jsonResponse(PUBLIC_RESPONSE));

    const res = await evaluate(SPEC, transport, "https://core.test");

    // Compile-time: `choice` narrows to the criteria keys; `noul`/`score` are numbers.
    const team: "shipping" | "billing" | "other" = res.answers.route.choice;
    const urgent: number = res.answers.isUrgent.noul;
    const upset: number = res.answers.sentiment.score;
    expect([team, urgent, upset]).toEqual(["shipping", 0.95, 1.28]);
  });

  it("throws DecisionsHttpError with status and parsed body on a non-2xx", async () => {
    const { transport } = makeTransport(() =>
      jsonResponse(
        {
          statusCode: 400,
          message: "questions.q.criteria must have at least two levels",
        },
        { status: 400 },
      ),
    );

    await expect(
      evaluate(SPEC, transport, "https://core.test"),
    ).rejects.toThrow(DecisionsHttpError);
    await expect(
      evaluate(SPEC, transport, "https://core.test"),
    ).rejects.toMatchObject({
      status: 400,
      body: { statusCode: 400 },
    });
  });

  it("is reachable as client.decisions.evaluate", async () => {
    const { calls, fetch } = makeTransport(() => jsonResponse(PUBLIC_RESPONSE));
    const client = createClient({ apiKey: "test-key", fetch });

    const res = await client.decisions.evaluate(SPEC);

    expect(calls[0].url).toMatch(/\/v1\/capabilities\/decisions\.evaluate$/);
    expect(res.answers.route.choice).toBe("shipping");
  });
});
