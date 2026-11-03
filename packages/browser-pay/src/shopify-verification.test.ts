import { ShopifyVerification } from "./shopify-verification";
import type { VerificationState } from "./verification";

const merchantOrigin = "https://shop.example";
const initial = (): VerificationState => ({
  id: "verification",
  version: 1,
  status: "requires_action",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  merchantOrigin,
  total: { amount: "11.00", currency: "USD" },
  challengeCaptured: true,
  launchClaimed: true,
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

function fixture() {
  const state = initial();
  let value: unknown = null;
  const send = jest.fn(async (method: string) => {
    if (method === "Page.createIsolatedWorld")
      return { executionContextId: 12 };
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: { id: "top" },
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
  adapter.relayed({ body: '{"id":"same-card"}' });
  const start = async () => {
    expect(
      await inspect(
        "/checkouts/internal/graphql/persisted",
        JSON.stringify(submit),
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
  it("forwards one original card-session mutation and blocks a repeated payment", async () => {
    const f = fixture();
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
  it("captures only a challenge in the recorded merchant authentication frame tree", async () => {
    const f = fixture();
    await f.start();
    const request = {
      url: "https://bank.example/challenge",
      method: "POST",
      body: "creq=exact",
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
  it("keeps early checks pending and never executes returned HTML", async () => {
    const f = fixture();
    await f.start();
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
