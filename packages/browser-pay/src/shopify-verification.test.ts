import {
  isShopifySubmission,
  READ_VERIFICATION_TEXT,
  ShopifyVerification,
} from "./shopify-verification";
import type { VerificationState } from "./verification";

const merchantOrigin = "https://shop.example";
const creq = (change = {}) =>
  Buffer.from(
    JSON.stringify({
      acsTransID: "11111111-1111-4111-8111-111111111111",
      threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
      messageType: "CReq",
      messageVersion: "2.2.0",
      challengeWindowSize: "05",
      ...change,
    }),
  ).toString("base64url");
const initial = (): VerificationState => ({
  id: "verification",
  version: 1,
  status: "preparing",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  merchantOrigin,
  total: { amount: "11.00", currency: "USD" },
  challengeCaptured: false,
  launchClaimed: false,
  checkRequested: false,
  continuationClaimed: false,
});
const submit = {
  operationName: "SubmitForCompletion",
  variables: {
    input: {
      payment: {
        paymentLines: [
          {
            paymentMethod: { directPaymentMethod: { sessionId: "same-card" } },
          },
        ],
      },
    },
  },
};
const receipt = () => ({
  data: {
    receipt: {
      id: "same-receipt",
      __typename: "ProcessedReceipt",
      purchaseOrder: {
        payment: {
          paymentLines: [{ paymentMethod: { sessionId: "same-card" } }],
        },
      },
      paymentDetails: { paymentAmount: { amount: "11", currencyCode: "USD" } },
      orderCreationStatus: { __typename: "OrderCreationSucceeded" },
      orderIdentity: { id: "order", buyerIdentifier: "ABC123456" },
    },
  },
});

function fixture(cardSession = "same-card") {
  const state = initial();
  let value: unknown = null;
  const send = jest.fn(async (method: string) => {
    if (method === "Page.createIsolatedWorld")
      return { executionContextId: 12 };
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: { id: "top", url: merchantOrigin + "/checkout" },
          childFrames: [
            {
              frame: {
                id: "auth",
                url:
                  merchantOrigin +
                  "/payments_api/redirect/show?existing=opaque",
              },
              childFrames: [{ frame: { id: "acs" } }],
            },
          ],
        },
      };
    return { result: { value } };
  });
  const adapter = new ShopifyVerification({ send }, () => state);
  const inspect = (path: string, body = "", method = "POST", frameId = "top") =>
    adapter.inspect({
      url: merchantOrigin + path,
      method,
      body,
      sessionId: "original-browser",
      frameId,
    });
  adapter.relayed({ body: JSON.stringify({ id: cardSession }) });
  const start = async () => {
    expect(
      await inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit).replace("same-card", cardSession),
      ),
    ).toBe("continue");
    await inspect(
      "/payments_api/redirect/show?existing=opaque",
      "",
      "GET",
      "auth",
    );
  };
  return {
    adapter,
    state,
    send,
    inspect,
    start,
    value: (next: unknown) => {
      value = next;
    },
  };
}

describe("Shopify continuation on the original browser", () => {
  it("cancels oversized reads before consuming the full response", async () => {
    const read = new Function(`return (${READ_VERIFICATION_TEXT})`)() as (
      response: Response,
      limit: number,
    ) => Promise<string | null>;
    let chunks = 0;
    const cancel = jest.fn();
    const body = new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(16));
      },
      cancel,
    });
    expect(await read(new Response(body), 32)).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThanOrEqual(4);
    const tooLarge = new Response("not read", {
      headers: { "content-length": "100" },
    });
    const earlyCancel = jest.spyOn(tooLarge.body!, "cancel");
    expect(await read(tooLarge, 32)).toBeNull();
    expect(earlyCancel).toHaveBeenCalledTimes(1);
    expect(await read(new Response("é"), 2)).toBe("é");
    expect(await read(new Response("é"), 1)).toBeNull();
  });
  it("recognizes body and query submissions without treating receipt reads as Pay", () => {
    const url = merchantOrigin + "/checkouts/internal/graphql/persisted";
    expect(isShopifySubmission({ url, body: JSON.stringify(submit) })).toBe(
      true,
    );
    expect(
      isShopifySubmission({
        url: url + "?operationName=SubmitForCompletion",
        body: JSON.stringify({ variables: submit.variables }),
      }),
    ).toBe(true);
    expect(
      isShopifySubmission({
        url: url + "?operationName=PollForReceipt",
        body: '{"operationName":"PollForReceipt"}',
      }),
    ).toBe(false);
  });
  it("withdraws observation for unsupported or repeated submissions before capture", async () => {
    const f = fixture();
    f.adapter.relayed({ body: '{"id":"unrelated-later-response"}' });
    const wrong = JSON.stringify(submit).replace("same-card", "other-card");
    expect(
      await f.inspect("/checkouts/internal/graphql/persisted", wrong),
    ).toBe("fallback");
    await f.start();
    expect(
      await f.inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
      ),
    ).toBe("fallback");
  });
  it.each(["challengeCaptured", "launchClaimed"] as const)(
    "blocks a second payment from a fresh adapter when the backend has %s",
    async (flag) => {
      const f = fixture();
      await f.start();
      f.state.status = "requires_action";
      f.state[flag] = true;
      const fresh = new ShopifyVerification({ send: f.send }, () => f.state);
      fresh.relayed({ body: '{"id":"same-card"}' });
      f.send.mockClear();
      expect(
        await fresh.inspect({
          url: merchantOrigin + "/checkouts/internal/graphql/persisted",
          method: "POST",
          body: JSON.stringify(submit),
          sessionId: "original-browser",
          frameId: "top",
        }),
      ).toBe("block");
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    [255, "continue"],
    [256, "fallback"],
  ] as const)(
    "checks a %i-character card session against the backend limit",
    async (length, decision) => {
      const cardSession = "x".repeat(length);
      const f = fixture(cardSession);
      expect(
        await f.inspect(
          "/checkouts/internal/graphql/persisted",
          JSON.stringify(submit).replace("same-card", cardSession),
        ),
      ).toBe(decision);
    },
  );
  it("captures supported challenges and withdraws observation outside the callback frame tree", async () => {
    const f = fixture();
    await f.start();
    const request = {
      url: "https://bank.example/challenge",
      method: "POST",
      body: "creq=" + creq(),
      sessionId: "acs-session",
      frameId: "acs",
    };
    expect(await f.adapter.inspect({ ...request, frameId: "unrelated" })).toBe(
      "fallback",
    );
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
  });
  it.each(["auth", "unrelated"])(
    "checks browser-owned ancestry across OOP sessions whose root parent is %s",
    async (parentId) => {
      const f = fixture();
      const send = jest.fn(
        async (method: string, _params?: unknown, sessionId?: string) => {
          if (method !== "Page.getFrameTree") return {};
          if (sessionId === "acs-session")
            return {
              frameTree: {
                frame: { id: "acs", parentId: "processor", url: "about:blank" },
              },
            };
          if (sessionId === "processor-session")
            return {
              frameTree: {
                frame: {
                  id: "processor",
                  parentId,
                  url: "https://processor.example",
                },
              },
            };
          return {
            frameTree: {
              frame: { id: "top", url: merchantOrigin + "/checkout" },
              childFrames: [
                {
                  frame: {
                    id: "auth",
                    url:
                      merchantOrigin +
                      "/payments_api/redirect/show?existing=opaque",
                  },
                },
              ],
            },
          };
        },
      );
      const parent = jest.fn((sessionId: string) =>
        sessionId === "acs-session" ? "processor-session" : "original-browser",
      );
      const adapter = new ShopifyVerification({ send }, () => f.state, parent);
      adapter.relayed({ body: '{"id":"same-card"}' });
      await adapter.inspect({
        url: merchantOrigin + "/checkouts/internal/graphql/persisted",
        body: JSON.stringify(submit),
        method: "POST",
        frameId: "top",
        sessionId: "original-browser",
      });
      await adapter.inspect({
        url: merchantOrigin + "/payments_api/redirect/show?existing=opaque",
        body: "",
        method: "GET",
        frameId: "auth",
        sessionId: "original-browser",
      });
      const request = {
        url: "https://bank.example/challenge",
        body: "creq=" + creq(),
        method: "POST",
        frameId: "acs",
        sessionId: "acs-session",
      };
      expect(await adapter.inspect(request)).toEqual(
        parentId === "auth"
          ? { capture: { url: request.url, body: request.body } }
          : "fallback",
      );
      expect(parent).toHaveBeenCalledWith("acs-session", "processor");
    },
  );
  it("ignores another same-merchant tab's callback before binding the tracked checkout", async () => {
    const f = fixture();
    await f.inspect(
      "/checkouts/internal/graphql/persisted",
      JSON.stringify(submit),
    );
    await f.adapter.inspect({
      url: merchantOrigin + "/payments_api/redirect/show?other=tab",
      method: "GET",
      body: "",
      frameId: "other-frame",
      sessionId: "other-tab",
    });
    await f.inspect(
      "/payments_api/redirect/show?existing=opaque",
      "",
      "GET",
      "auth",
    );
    const request = {
      url: "https://bank.example/challenge",
      method: "POST",
      body: "creq=" + creq(),
      sessionId: "acs-session",
      frameId: "acs",
    };
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
  });
  it("keeps submission and challenge fences after durable takeover", async () => {
    const f = fixture();
    await f.start();
    f.state.challengeCaptured = true;
    for (const body of ["creq=unsupported", '{"messageType":"CReq"}']) {
      expect(
        await f.adapter.inspect({
          url: "https://bank.example/challenge",
          method: "POST",
          body,
          sessionId: "acs-session",
          frameId: "acs",
        }),
      ).toBe("block");
    }
    expect(
      await f.inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
      ),
    ).toBe("block");
  });
  it.each([
    ["url", 2048, true],
    ["url", 2049, false],
    ["body", 8192, true],
    ["body", 8193, false],
  ] as const)(
    "bounds the captured %s at %i characters without changing valid payloads",
    async (field, length, accepted) => {
      const f = fixture();
      await f.start();
      const prefix = "https://bank.example/challenge?reference=";
      const request = {
        url:
          field === "url"
            ? prefix + "x".repeat(length - prefix.length)
            : "https://bank.example/challenge",
        method: "POST",
        body:
          "creq=" +
          (field === "body"
            ? Buffer.from(
                Buffer.from(creq(), "base64url")
                  .toString("utf8")
                  .padEnd(Math.floor(((length - 5) * 3) / 4), " "),
              ).toString("base64url")
            : creq()),
        sessionId: "acs-session",
        frameId: "acs",
      };
      expect(request[field]).toHaveLength(length);
      const action = await f.adapter.inspect(request);
      expect(action).toEqual(
        accepted
          ? { capture: { url: request.url, body: request.body } }
          : "fallback",
      );
    },
  );
  it.each([
    ["empty", "creq="],
    ["duplicate fields", `creq=${creq()}&creq=${creq()}`],
    ["extra form fields", `creq=${creq()}&threeDSSessionData=private`],
    ["merchant HTML", "creq=%3Cscript%3Euntrusted%3C%2Fscript%3E"],
    ["control characters", `creq=${creq()}%0A`],
    ["impossible base64url length", "creq=x"],
    ["noncanonical pad bits", "creq=Zh"],
    ["extra padding", `creq=${creq()}===`],
    [
      "incorrect padding",
      "creq=" +
        creq() +
        "=".repeat((4 - (creq().length % 4)) % 4 === 1 ? 2 : 1),
    ],
    ["non-JSON data", "creq=ZXhhY3Q"],
    ["unsupported version", "creq=" + creq({ messageVersion: "1.0" })],
    ["unknown CReq fields", "creq=" + creq({ messageExtensions: [] })],
    ["invalid transaction ID", "creq=" + creq({ acsTransID: "guessed" })],
    [
      "non-string transaction ID",
      "creq=" + creq({ acsTransID: ["11111111-1111-4111-8111-111111111111"] }),
    ],
    ["unsupported window", "creq=" + creq({ challengeWindowSize: "06" })],
  ])(
    "leaves unsupported form data to the native checkout without capturing it: %s",
    async (_reason, body) => {
      const f = fixture();
      await f.start();
      expect(
        await f.adapter.inspect({
          url: "https://bank.example/challenge",
          method: "POST",
          body,
          sessionId: "acs-session",
          frameId: "acs",
        }),
      ).toBe("fallback");
    },
  );
  it("leaves unsupported URLs native and preserves encoded CReq padding", async () => {
    const f = fixture();
    await f.start();
    let raw = Buffer.from(creq(), "base64url").toString("utf8");
    if (Buffer.byteLength(raw) % 3 === 0) raw += " ";
    const encoded = Buffer.from(raw).toString("base64url");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    expect(padded).toContain("=");
    const request = {
      url: "https://bank.example/challenge?reference=exact",
      method: "POST",
      body: new URLSearchParams({ creq: padded }).toString(),
      sessionId: "acs-session",
      frameId: "acs",
    };
    expect(
      await f.adapter.inspect({ ...request, url: request.url + "\n" }),
    ).toBe("fallback");
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
  });
  it("withdraws observation if the original checkout frame cannot be verified", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("CDP unavailable"));
    const request = () =>
      f.inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
      );
    expect(await request()).toBe("fallback");
    expect(await request()).toBe("fallback");
  });
  it("leaves unsupported JSON bank challenges native and preserves merchant metadata", async () => {
    const f = fixture();
    await f.start();
    const request = {
      url: "https://bank.example/challenge",
      method: "POST",
      sessionId: "acs-session",
      frameId: "acs",
    };
    for (const body of [
      '{"creq":"challenge-reference","event":"started"}',
      '{"messageType":"CReq"}',
    ]) {
      expect(await f.adapter.inspect({ ...request, body })).toBe("fallback");
      expect(await f.inspect("/checkout/events", body)).toBe("continue");
    }
    expect(
      await f.inspect(
        "/checkout/events",
        "creq=challenge-reference&event=started",
      ),
    ).toBe("continue");
    expect(
      await f.adapter.inspect({
        ...request,
        body: '{"note":"link?other=1&creq=reference-only"}',
      }),
    ).toBe("continue");
  });
  it("leaves the bank POST native if its frame ancestry cannot be verified", async () => {
    const f = fixture();
    await f.start();
    f.send.mockRejectedValue(new Error("CDP unavailable"));
    expect(
      await f.adapter.inspect({
        url: "https://bank.example/challenge",
        method: "POST",
        body: "creq=" + creq(),
        sessionId: "acs-session",
        frameId: "acs",
      }),
    ).toBe("fallback");
  });
  it("keeps early checks pending and never executes returned HTML", async () => {
    const f = fixture();
    await f.start();
    f.state.status = "requires_action";
    f.state.challengeCaptured = true;
    f.state.launchClaimed = true;
    f.value('<form action="https://bank.example">pending</form>');
    expect(await f.adapter.continuation()).toBeNull();
    f.value(
      '<script>window.top.postMessage({type:"3ds_completed"}, "*");</script>',
    );
    const resume = await f.adapter.continuation();
    expect(resume).toEqual(expect.any(Function));
    await resume!();
    const calls = f.send.mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    const script = calls
      .filter(([method]) => method === "Runtime.evaluate")
      .at(-1)![1].expression;
    expect(script).toContain('"https://shop.example"');
    expect(script).toContain("location.href !==");
    expect(script).not.toContain("eval(");
  });
  it.each([
    "b99547c8e17e88f985ec0e11a844dd1305bf14cf70e41ca10954899050ffc567",
    "3ddb1d363e4e875c5659f2aaba308447980240ffc14b31ef90cb8ab7843bc1e5",
  ])(
    "pins read-only receipt query %s and correlates card session, receipt and terms",
    async (id) => {
      const f = fixture();
      await f.start();
      const query = {
        id,
        operationName: "PollForReceipt",
        variables: { receiptId: "same-receipt", sessionToken: "private" },
      };
      await f.inspect(
        "/checkouts/internal/graphql/persisted?operationName=PollForReceipt",
        JSON.stringify({ ...query, id: "mutation" }),
      );
      f.value(receipt());
      expect(await f.adapter.reconcile(f.state)).toBeNull();
      await f.inspect(
        "/checkouts/internal/graphql/persisted?operationName=PollForReceipt",
        JSON.stringify(query),
      );
      expect(await f.adapter.reconcile(f.state)).toMatchObject({
        outcome: "confirmed",
        cardSession: "same-card",
        amount: "11.00",
      });
      for (const alter of [
        (r: ReturnType<typeof receipt>) => {
          r.data.receipt.id = "other-receipt";
        },
        (r: ReturnType<typeof receipt>) => {
          r.data.receipt.purchaseOrder.payment.paymentLines[0].paymentMethod.sessionId =
            "other-card";
        },
        (r: ReturnType<typeof receipt>) => {
          r.data.receipt.paymentDetails.paymentAmount.amount = "12";
        },
      ]) {
        const next = receipt();
        alter(next);
        f.value(next);
        expect(await f.adapter.reconcile(f.state)).toBeNull();
      }
    },
  );
});
