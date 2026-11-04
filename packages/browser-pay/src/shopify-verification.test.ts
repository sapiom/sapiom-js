import {
  isShopifySubmission,
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
            { frame: { id: "auth" }, childFrames: [{ frame: { id: "acs" } }] },
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
  it("forwards one original card-session mutation and blocks a repeated payment", async () => {
    const f = fixture();
    f.adapter.relayed({ body: '{"id":"unrelated-later-response"}' });
    const wrong = JSON.stringify(submit).replace("same-card", "other-card");
    expect(
      await f.inspect("/checkouts/internal/graphql/persisted", wrong),
    ).toBe("block");
    await f.start();
    expect(
      await f.inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
      ),
    ).toBe("block");
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
    [256, "block"],
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
  it("captures only a challenge in the recorded merchant authentication frame tree", async () => {
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
      "block",
    );
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
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
          : "block",
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
    "blocks unsupported form data without forwarding it: %s",
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
      ).toBe("block");
    },
  );
  it("blocks control characters in challenge URLs and preserves encoded CReq padding", async () => {
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
    ).toBe("block");
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
  });
  it("blocks the payment mutation if its original checkout frame cannot be verified", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("CDP unavailable"));
    const request = () =>
      f.inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
      );
    expect(await request()).toBe("block");
    expect(await request()).toBe("block");
  });
  it("blocks unsupported JSON bank challenges while preserving merchant metadata requests", async () => {
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
      expect(await f.adapter.inspect({ ...request, body })).toBe("block");
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
  it("blocks the bank POST if its frame ancestry cannot be verified", async () => {
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
    ).toBe("block");
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
  it("pins the read-only receipt query and correlates card session, receipt and terms", async () => {
    const f = fixture();
    await f.start();
    const query = {
      id: "b99547c8e17e88f985ec0e11a844dd1305bf14cf70e41ca10954899050ffc567",
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
  });
});
