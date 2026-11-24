import { MerchantFrames } from "./merchant-frame";

class Frames extends MerchantFrames {
  ancestor = this.merchantAncestor;
  contains = this.descendant;
  run = this.evaluate;
}

function fixture() {
  let fragment = "#challenge";
  const send = jest.fn(
    async (
      method: string,
      _params?: unknown,
      session?: string,
    ): Promise<unknown> => {
      if (method === "Page.getFrameTree")
        return {
          frameTree:
            session === "acs-session"
              ? {
                  frame: {
                    id: "acs",
                    parentId: "stripe",
                    url: "https://bank.example/challenge",
                  },
                }
              : {
                  frame: {
                    id: "stripe",
                    url: "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html",
                    urlFragment: fragment,
                  },
                  childFrames: [{ frame: { id: "child", url: "about:blank" } }],
                },
        };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 7 };
      return { result: { value: { interactionReturned: true } } };
    },
  );
  const frames = new Frames({ send }, (session) =>
    session === "acs-session" ? "stripe-session" : undefined,
  );
  return {
    frames,
    send,
    navigate: (hash: string) => {
      fragment = hash;
    },
  };
}

describe("MerchantFrames", () => {
  // Adapted from #1300 @3c4e5fb0 Stripe completion regression, without its adapter.
  it("delivers through the captured Stripe frame when CDP separates its URL fragment", async () => {
    const f = fixture();
    const request = { sessionId: "acs-session", frameId: "acs" };
    const frame = await f.frames.ancestor(request, "https://js.stripe.com");
    expect(frame).toEqual({
      sessionId: "stripe-session",
      frameId: "stripe",
      url: "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html#challenge",
    });
    expect(await f.frames.contains(frame!, request)).toBe(true);
    await expect(
      f.frames.run(frame!, "async () => ({ interactionReturned: true })", []),
    ).resolves.toEqual({ interactionReturned: true });
    expect(f.send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({ executionContextId: 7 }),
      "stripe-session",
      15000,
    );
    f.navigate("#different-transaction");
    expect(await f.frames.contains(frame!, request)).toBe(false);
  });

  it("permits same-origin route changes only when exact URL binding is disabled", async () => {
    const f = fixture();
    const frame = await f.frames.ancestor(
      { sessionId: "stripe-session", frameId: "child" },
      "https://js.stripe.com",
    );
    f.navigate("#another-route");
    expect(
      await f.frames.contains(
        frame!,
        { sessionId: "stripe-session", frameId: "child" },
        false,
      ),
    ).toBe(true);
    expect(
      await f.frames.contains(
        frame!,
        { sessionId: "stripe-session", frameId: "unknown" },
        false,
      ),
    ).toBe(false);
  });

  it("bounds cyclic cross-session ancestry and rejects malformed frame trees", async () => {
    const send = jest.fn(async () => ({
      frameTree: {
        frame: { id: "a", parentId: "missing", url: "about:blank" },
      },
    }));
    const frames = new Frames({ send }, () => "session");
    expect(
      await frames.ancestor(
        { sessionId: "session", frameId: "a" },
        "https://shop.example",
      ),
    ).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue({ frameTree: null } as never);
    expect(
      await frames.ancestor(
        { sessionId: "session", frameId: "a" },
        "https://shop.example",
      ),
    ).toBeUndefined();
  });

  it("rejects failed isolated-world delivery", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ executionContextId: 1 })
      .mockResolvedValueOnce({ exceptionDetails: {} });
    await expect(
      new Frames({ send }).run(
        { sessionId: "s", frameId: "f", url: "https://shop.example" },
        "() => true",
        [],
      ),
    ).rejects.toThrow("Merchant observation unavailable");
  });
});
