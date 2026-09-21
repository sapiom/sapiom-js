/**
 * llm.decide() — routed wire shape (`POST /v1/capabilities/llm.decide` on the Core
 * base URL, `x-api-key` credential), verbatim pass-through of state/questions,
 * `model` forwarded only when set, the router's response returned as-is, and a
 * non-2xx mapped to LlmDecideHttpError. Real Transport, scripted fetch — no network.
 */
import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import { decide, LlmDecideHttpError, type LlmDecideSpec } from "./index.js";

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

// The exact request the gateway API spec records against api.typesafe.ai, and the
// router's normalized answer for it (jev-1.13.0, 2026-09-20) — one fixture shared
// across the SDK, the backend adapter spec, and the gateway snapshot.
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
} satisfies LlmDecideSpec;

const ROUTER_RESPONSE = {
  model: "jev-1.13.0",
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
  servedBy: "typesafe",
};

describe("llm.decide", () => {
  it("POSTs the routed capability on the Core base URL with the tenant credential", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(ROUTER_RESPONSE),
    );

    const res = await decide(SPEC, transport, "https://core.test");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://core.test/v1/capabilities/llm.decide");
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(res).toEqual(ROUTER_RESPONSE);
  });

  it("forwards state and questions verbatim and omits model when unset", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(ROUTER_RESPONSE),
    );

    await decide(SPEC, transport, "https://core.test");

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      state: SPEC.state,
      questions: SPEC.questions,
    });
  });

  it("forwards an explicit model", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse(ROUTER_RESPONSE),
    );

    await decide(
      { ...SPEC, model: "jev-1.13.0" },
      transport,
      "https://core.test",
    );

    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      model: "jev-1.13.0",
    });
  });

  it("types answers by the questions passed", async () => {
    const { transport } = makeTransport(() => jsonResponse(ROUTER_RESPONSE));

    const res = await decide(SPEC, transport, "https://core.test");

    // Compile-time: `choice` narrows to the criteria keys; `noul`/`score` are numbers.
    const team: "shipping" | "billing" | "other" = res.answers.route.choice;
    const urgent: number = res.answers.isUrgent.noul;
    const upset: number = res.answers.sentiment.score;
    expect([team, urgent, upset]).toEqual(["shipping", 0.95, 1.28]);
  });

  it("throws LlmDecideHttpError with status and parsed body on a non-2xx", async () => {
    const { transport } = makeTransport(() =>
      jsonResponse(
        {
          statusCode: 400,
          message: "questions.q.criteria must have at least two levels",
        },
        { status: 400 },
      ),
    );

    await expect(decide(SPEC, transport, "https://core.test")).rejects.toThrow(
      LlmDecideHttpError,
    );
    await expect(
      decide(SPEC, transport, "https://core.test"),
    ).rejects.toMatchObject({
      status: 400,
      body: { statusCode: 400 },
    });
  });

  it("is reachable as client.llm.decide", async () => {
    const { calls, fetch } = makeTransport(() => jsonResponse(ROUTER_RESPONSE));
    const client = createClient({ apiKey: "test-key", fetch });

    const res = await client.llm.decide(SPEC);

    expect(calls[0].url).toMatch(/\/v1\/capabilities\/llm\.decide$/);
    expect(res.answers.route.choice).toBe("shipping");
  });
});
