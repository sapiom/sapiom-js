import {
  VerificationSession,
  VerificationHttpError,
  verificationTransport,
  type VerificationState,
  type VerificationAdapter,
} from "./verification";
import { CdpConnection } from "./cdp";
import { attachInterceptor } from "./interceptor";

const initial = (): VerificationState => ({
  id: "verification",
  version: 1,
  status: "preparing",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  challengeCaptured: false,
  launchClaimed: false,
  checkRequested: false,
  continuationClaimed: false,
  merchantOrigin: "https://shop.example",
  total: { amount: "11.00", currency: "USD" },
});
describe("Existing-browser verification observation", () => {
  afterEach(() => jest.useRealTimers());
  it.each([false, true])(
    "reconciles a lost native acknowledgment without redelivery or a contradictory failure (committed=%s)",
    async (committed) => {
      jest.useFakeTimers();
      let state: VerificationState = {
        ...initial(),
        challengeCaptured: true,
        launchClaimed: true,
        status: "checking",
        nativeReturnAvailable: true,
      };
      let acknowledgments = 0;
      const resume = jest.fn(async () => ({
        interactionReturned: true as const,
      }));
      const report = jest.fn(async (_id, body) => {
        if (body.kind === "continuation_started") {
          state = { ...state, version: 2, continuationClaimed: true };
          return {
            ...state,
            nativeReturn: {
              protocol: "braintree_cardinal" as const,
              jwt: "header.payload.signature",
            },
          };
        }
        if (body.kind === "interaction_resumed") {
          acknowledgments++;
          if (committed || acknowledgments > 3)
            state = {
              ...state,
              version: 3,
              status: "ended",
              interactionReturned: true,
            };
          if (acknowledgments <= 3)
            throw new Error("lost acknowledgment reply");
        }
        return state;
      });
      const observer = await VerificationSession.attach(
        { register: async () => state, sync: async () => state, report },
        {
          inspect: async () => "continue",
          relayed() {},
          reconcile: async () => null,
          continuation: async () => resume,
        },
        "injection",
      );
      await jest.advanceTimersByTimeAsync(2001);
      expect(
        report.mock.calls.some(
          ([, body]) => body.kind === "continuation_failed",
        ),
      ).toBe(false);
      await jest.advanceTimersByTimeAsync(2001);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(observer!.current().interactionReturned).toBe(true);
      const keys = report.mock.calls
        .filter(([, body]) => body.kind === "interaction_resumed")
        .map(([, body]) => body.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(acknowledgments).toBe(committed ? 3 : 4);
      await observer!.close();
    },
  );
  it.each([true, false])(
    "keeps native return private and acknowledges only a completed native delivery (%s)",
    async (succeeds) => {
      jest.useFakeTimers();
      let state: VerificationState = {
        ...initial(),
        challengeCaptured: true,
        launchClaimed: true,
        status: "checking",
        nativeReturnAvailable: true,
      };
      const nativeReturn = {
        protocol: "braintree_cardinal" as const,
        jwt: "header.payload.signature",
      };
      const resume = jest.fn(async () => {
        if (!succeeds) throw new Error("native rejected");
        return { interactionReturned: true as const };
      });
      const dispose = jest.fn();
      const report = jest.fn(async (_id, body) => {
        state = { ...state, version: state.version + 1 };
        if (body.kind === "continuation_started") {
          state.continuationClaimed = true;
          return { ...state, nativeReturn };
        }
        state.status = body.kind === "interaction_resumed" ? "ended" : "error";
        state.interactionReturned = body.kind === "interaction_resumed";
        return state;
      });
      const observer = await VerificationSession.attach(
        { register: async () => state, sync: async () => state, report },
        {
          inspect: async () => "continue",
          relayed() {},
          reconcile: async () => null,
          continuation: async () => resume,
          dispose,
        },
        "injection",
      );
      await jest.advanceTimersByTimeAsync(2001);
      expect(resume).toHaveBeenCalledWith(nativeReturn);
      expect(report.mock.calls.map(([, body]) => body.kind)).toEqual([
        "continuation_started",
        succeeds ? "interaction_resumed" : "continuation_failed",
      ]);
      expect(observer!.current()).not.toHaveProperty("nativeReturn");
      expect(await observer!.wait()).not.toHaveProperty("nativeReturn");
      expect(observer!.current().interactionReturned).toBe(succeeds);
      await jest.advanceTimersByTimeAsync(4000);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      await observer!.close();
    },
  );
  it.each([400, 401, 403, 404, 409, 422, 429])(
    "leaves a definite HTTP %i capture refusal to the native checkout",
    async (status) => {
      const state = initial();
      const capture = {
        url: "https://bank.example/challenge",
        body: "creq=original",
      };
      const inspect = jest.fn(async () => ({ capture }));
      const report = jest.fn(async () => {
        throw new VerificationHttpError(
          status,
          "verification_challenge_unsupported",
        );
      });
      const observer = await VerificationSession.attach(
        { register: async () => state, sync: async () => state, report },
        { inspect, relayed() {}, reconcile: async () => null },
        "injection",
      );
      const request = { ...capture, method: "POST", sessionId: "original" };
      expect(await observer!.inspect(request)).toBe("continue");
      expect(await observer!.inspect(request)).toBe("continue");
      expect(observer!.current().challengeCaptured).toBe(false);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
      await observer!.close();
    },
  );
  it.each([
    new Error("response lost"),
    new VerificationHttpError(503, "unavailable"),
  ])(
    "keeps capture fenced after an ambiguous response followed by a definite refusal: %s",
    async (unknown) => {
      const state = initial();
      const capture = {
        url: "https://bank.example/challenge",
        body: "creq=original",
      };
      const report = jest
        .fn()
        .mockRejectedValueOnce(unknown)
        .mockRejectedValue(
          new VerificationHttpError(409, "verification_challenge_unsupported"),
        );
      const observer = await VerificationSession.attach(
        { register: async () => state, sync: async () => state, report },
        {
          inspect: async () => ({ capture }),
          relayed() {},
          reconcile: async () => null,
        },
        "injection",
      );
      const request = { ...capture, method: "POST", sessionId: "original" };
      await expect(observer!.inspect(request)).rejects.toThrow();
      expect(await observer!.inspect(request)).toBe("block");
      expect(report).toHaveBeenCalledTimes(2);
      expect(report.mock.calls[0][1].idempotencyKey).toEqual(
        report.mock.calls[1][1].idempotencyKey,
      );
      await observer!.close();
    },
  );
  it("withdraws inspection and reconciliation when the adapter selects native checkout", async () => {
    jest.useFakeTimers();
    const state = initial();
    const inspect = jest.fn(async () => "fallback" as const);
    const reconcile = jest.fn(async () => null);
    const report = jest.fn(async () => state);
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      { inspect, relayed() {}, reconcile },
      "injection",
    );
    const request = {
      url: "https://bank.example/challenge",
      body: "creq=original",
      method: "POST",
      sessionId: "original",
    };
    expect(await observer!.inspect(request)).toBe("continue");
    expect(await observer!.inspect(request)).toBe("continue");
    await jest.advanceTimersByTimeAsync(2001);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await observer!.close();
  });
  it("discards a pending receipt when inspection switches the checkout to native", async () => {
    jest.useFakeTimers();
    const state = initial();
    let finishReceipt!: (value: {
      outcome: "confirmed";
      cardSession: string;
      amount: string;
      currency: string;
    }) => void;
    const pending = new Promise<Parameters<typeof finishReceipt>[0]>(
      (resolve) => {
        finishReceipt = resolve;
      },
    );
    const report = jest.fn(async () => state);
    const reconcile = jest.fn(() => pending);
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      { inspect: async () => "fallback", relayed() {}, reconcile },
      "injection",
    );
    await jest.advanceTimersByTimeAsync(2000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(
      await observer!.inspect({
        url: "https://shop.example/retry",
        method: "POST",
        body: "{}",
        sessionId: "original",
      }),
    ).toBe("continue");
    finishReceipt({
      outcome: "confirmed",
      cardSession: "original",
      amount: "11.00",
      currency: "USD",
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(report).not.toHaveBeenCalled();
    expect(observer!.current()).not.toHaveProperty("observation");
    await observer!.close();
  });

  it("does not send a queued receipt when native fallback wins before the report starts", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
    const state = initial();
    const report = jest.fn(async () => state);
    let observer: VerificationSession | null = null;
    observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      {
        inspect: async () => "fallback",
        relayed() {},
        reconcile: async () => {
          queueMicrotask(() => {
            void observer!.inspect({
              url: "https://shop.example/retry",
              method: "POST",
              body: "{}",
              sessionId: "original",
            });
          });
          return {
            outcome: "confirmed",
            cardSession: "original",
            amount: "11.00",
            currency: "USD",
          };
        },
      },
      "injection",
    );
    await jest.advanceTimersByTimeAsync(2000);
    expect(report).not.toHaveBeenCalled();
    await observer!.close();
  });

  it("leaves repeated definite version conflicts native when sync confirms no capture", async () => {
    const state = initial();
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const report = jest.fn(async () => {
      throw new VerificationHttpError(409, "verification_version_conflict");
    });
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => ({ ...state, version: ++state.version }),
        report,
      },
      {
        inspect: async () => ({ capture }),
        relayed() {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "original" };
    expect(await observer!.inspect(request)).toBe("continue");
    expect(await observer!.inspect(request)).toBe("continue");
    expect(report).toHaveBeenCalledTimes(3);
    expect(observer!.current().challengeCaptured).toBe(false);
    await observer!.close();
  });
  it("retains native checkout when the backend ends observation before capturing", async () => {
    const state = initial();
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const report = jest.fn(async () => ({
      ...state,
      version: 2,
      status: "error" as const,
    }));
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      {
        inspect: async () => ({ capture }),
        relayed() {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "original" };
    expect(await observer!.inspect(request)).toBe("continue");
    expect(await observer!.inspect(request)).toBe("continue");
    expect(observer!.current().challengeCaptured).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    await observer!.close();
  });
  it("refuses native fallback after capture was reserved or recorded", async () => {
    const state = initial();
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = jest
      .fn<ReturnType<VerificationAdapter["inspect"]>, []>()
      .mockResolvedValueOnce({ capture })
      .mockResolvedValue("fallback");
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report: async () => {
          await gate;
          return { ...state, version: 2, challengeCaptured: true };
        },
      },
      { inspect, relayed() {}, reconcile: async () => null },
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "original" };
    const first = observer!.inspect(request);
    expect(await observer!.inspect(request)).toBe("block");
    release();
    expect(await first).toBe("capture");
    expect(await observer!.inspect(request)).toBe("block");
    await observer!.close();
  });

  it("leaves a delayed challenge native after polling ends uncaptured observation", async () => {
    jest.useFakeTimers();
    const state = initial();
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const sync = jest.fn(async () => ({
      ...state,
      version: 2,
      status: "ended" as const,
    }));
    const inspect = jest.fn(async () => ({ capture }));
    const report = jest.fn(async () => state);
    const observer = await VerificationSession.attach(
      { register: async () => state, sync, report },
      { inspect, relayed() {}, reconcile: async () => null },
      "injection",
    );
    await jest.advanceTimersByTimeAsync(2000);
    expect(observer!.current().status).toBe("ended");
    const request = { ...capture, method: "POST", sessionId: "original" };
    expect(await observer!.inspect(request)).toBe("continue");
    expect(await observer!.inspect(request)).toBe("continue");
    expect(inspect).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    await observer!.close();
  });

  it("keeps ambiguous capture fenced after polling returns uncaptured terminal state", async () => {
    jest.useFakeTimers();
    const state = initial();
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const report = jest.fn(async () => {
      throw new Error("response lost");
    });
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => ({ ...state, version: 2, status: "ended" as const }),
        report,
      },
      {
        inspect: async () => ({ capture }),
        relayed() {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "original" };
    await expect(observer!.inspect(request)).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(2000);
    expect(observer!.current().status).toBe("ended");
    expect(await observer!.inspect(request)).toBe("block");
    expect(report).toHaveBeenCalledTimes(3);
    await observer!.close();
  });

  it.each([
    { challengeCaptured: true, launchClaimed: false },
    { challengeCaptured: false, launchClaimed: true },
  ])("keeps a terminal handoff fenced with %j", async (handoff) => {
    const state = { ...initial(), status: "ended" as const, ...handoff };
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report: async () => state,
      },
      {
        inspect: async () => "block",
        relayed() {},
        reconcile: async () => null,
      },
      "injection",
    );
    expect(
      await observer!.inspect({
        url: "https://bank.example/challenge",
        body: "creq=original",
        method: "POST",
        sessionId: "original",
      }),
    ).toBe("block");
    await observer!.close();
  });

  it.each(["ended", "expired", "canceled", "error"] as const)(
    "returns a registered %s session without starting a polling timer",
    async (status) => {
      jest.useFakeTimers();
      const state = { ...initial(), status };
      const sync = jest.fn(async () => state);
      const reconcile = jest.fn(async () => null);
      const capture = {
        url: "https://bank.example/challenge",
        body: "creq=original",
      };
      const inspect = jest.fn(async () => ({ capture }));
      const observer = await VerificationSession.attach(
        { register: async () => state, sync, report: async () => state },
        { inspect, relayed() {}, reconcile },
        "injection",
      );
      expect(jest.getTimerCount()).toBe(0);
      await expect(observer!.wait()).resolves.toEqual(state);
      await jest.advanceTimersByTimeAsync(4001);
      expect(sync).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(
        await observer!.inspect({
          ...capture,
          method: "POST",
          sessionId: "original",
        }),
      ).toBe("continue");
      expect(inspect).not.toHaveBeenCalled();
      await observer!.close();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it("treats a disabled or older backend as unavailable without following redirects", async () => {
    const disabled = verificationTransport(
      async () =>
        new Response('{"code":"verification_unavailable"}', { status: 503 }),
    );
    expect(await disabled.register("injection", "browser")).toBeNull();
    const old = verificationTransport(
      async () => new Response("<html>not found</html>", { status: 404 }),
    );
    expect(await old.register("injection", "browser")).toBeNull();
    const redirect = verificationTransport(
      async () => new Response("{}", { status: 302 }),
    );
    await expect(redirect.register("injection", "browser")).rejects.toThrow(
      "Purchase verification request failed",
    );
  });
  it("keeps the exact captured request and never captures it a second time", async () => {
    let state = initial();
    const reports: any[] = [];
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const adapter: VerificationAdapter = {
      inspect: async () => ({ capture }),
      relayed: () => {},
      reconcile: async () => null,
    };
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report: async (_id, body) => {
          reports.push(body);
          state = {
            ...state,
            version: state.version + 1,
            status: "requires_action",
            challengeCaptured: true,
          };
          return state;
        },
      },
      adapter,
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "existing" };
    expect(await observer!.inspect(request)).toBe("capture");
    expect(await observer!.inspect(request)).toBe("block");
    expect(reports[0]).toMatchObject({
      kind: "challenge_observed",
      capture,
      expectedVersion: 1,
    });
    await observer!.close();
  });
  it("waits on source-labelled merchant readback and does not create or close a browser", async () => {
    jest.useFakeTimers();
    let state = initial();
    const report = jest.fn(
      async (_id: string, _body: Record<string, unknown>) => {
        state = {
          ...state,
          status: "ended",
          observation: { outcome: "confirmed", source: "runner" },
        };
        return state;
      },
    );
    const adapter: VerificationAdapter = {
      inspect: async () => "continue",
      relayed: () => {},
      reconcile: async () => ({
        outcome: "confirmed",
        cardSession: "same",
        amount: "11.00",
        currency: "USD",
      }),
    };
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report,
      },
      adapter,
      "injection",
    );
    const waiting = observer!.wait();
    await jest.advanceTimersByTimeAsync(2001);
    expect((await waiting).observation).toEqual({
      outcome: "confirmed",
      source: "runner",
    });
    expect(report).toHaveBeenCalledWith(
      "verification",
      expect.objectContaining({
        kind: "checkout_observed",
        observation: {
          outcome: "confirmed",
          cardSession: "same",
          amount: "11.00",
          currency: "USD",
        },
        expectedVersion: 1,
      }),
    );
    expect(jest.getTimerCount()).toBe(0);
    await observer!.close();
  });
  it("continues ordinary traffic but blocks a bank POST when inspection fails", async () => {
    const state = initial();
    const report = jest.fn(async () => state);
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      {
        inspect: async () => {
          throw new Error("observation failed");
        },
        relayed: () => {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = {
      url: "https://shop.example/read",
      method: "GET",
      body: "",
      sessionId: "original",
    };
    expect(await observer!.inspect(request)).toBe("continue");
    expect(
      await observer!.inspect({
        ...request,
        method: "POST",
        body: '{"query":"receipt"}',
      }),
    ).toBe("continue");
    expect(
      await observer!.inspect({
        ...request,
        url: "https://bank.example/challenge",
        method: "POST",
        body: "creq=original",
      }),
    ).toBe("block");
    expect(
      await observer!.inspect({
        ...request,
        url: "https://bank.example/challenge",
        method: "POST",
        body: '{"creq":"original"}',
      }),
    ).toBe("block");
    expect(
      await observer!.inspect({
        ...request,
        url: "https://bank.example/challenge",
        method: "POST",
        body: '{"messageType":"CReq"}',
      }),
    ).toBe("block");
    for (const body of [
      "creq=challenge-reference&event=started",
      '{"creq":"challenge-reference","event":"started"}',
      '{"messageType":"CReq","event":"started"}',
    ])
      expect(
        await observer!.inspect({ ...request, method: "POST", body }),
      ).toBe("continue");
    expect(report).not.toHaveBeenCalled();
    await observer!.close();
  });
  it("preserves the adapter's destination decision for challenge-shaped traffic", async () => {
    const state = initial();
    const report = jest.fn(async () => state);
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      {
        inspect: async () => "continue",
        relayed: () => {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = {
      url: "https://bank.example/challenge",
      method: "POST",
      sessionId: "original",
    };
    for (const body of [
      "creq=original",
      '{"creq":"original"}',
      '{"messageType":"CReq"}',
    ])
      expect(await observer!.inspect({ ...request, body })).toBe("continue");
    expect(
      await observer!.inspect({
        ...request,
        body: '{"note":"link?other=1&creq=reference-only","query":"receipt"}',
      }),
    ).toBe("continue");
    expect(report).not.toHaveBeenCalled();
    await observer!.close();
  });
  it.each(["sync", "reconcile", "continuation"])(
    "expires while %s is stuck and ignores its late result",
    async (stuck) => {
      jest.useFakeTimers();
      const state: VerificationState = {
        ...initial(),
        expiresAt: new Date(Date.now() + 4000).toISOString(),
        status: "requires_action",
        challengeCaptured: true,
        launchClaimed: true,
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resume = jest.fn(async () => {});
      const report = jest.fn(async () => ({
        ...state,
        version: 2,
        continuationClaimed: true,
      }));
      const observer = await VerificationSession.attach(
        {
          register: async () => state,
          sync: async () => {
            if (stuck === "sync") await gate;
            return { ...state, version: 2 };
          },
          report,
        },
        {
          inspect: async () => "continue",
          relayed: () => {},
          reconcile: async () => {
            if (stuck !== "reconcile") return null;
            await gate;
            return {
              outcome: "confirmed",
              cardSession: "same",
              amount: "11.00",
              currency: "USD",
            };
          },
          continuation: async () => {
            await gate;
            return resume;
          },
        },
        "injection",
      );
      const waiting = observer!.wait();
      await jest.advanceTimersByTimeAsync(4000);
      expect((await waiting).status).toBe("expired");
      release();
      await jest.advanceTimersByTimeAsync(0);
      expect(observer!.current().status).toBe("expired");
      expect(report).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      await observer!.close();
    },
  );
  it("does not revive an expired wait when an in-flight capture report returns active state", async () => {
    jest.useFakeTimers();
    const state = {
      ...initial(),
      expiresAt: new Date(Date.now() + 4000).toISOString(),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    const observer = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report: async () => {
          await gate;
          return { ...state, version: 2, challengeCaptured: true };
        },
      },
      {
        inspect: async () => ({ capture }),
        relayed: () => {},
        reconcile: async () => null,
      },
      "injection",
    );
    const capturing = observer!.inspect({
      ...capture,
      method: "POST",
      sessionId: "original",
    });
    const waiting = observer!.wait();
    await jest.advanceTimersByTimeAsync(4000);
    expect((await waiting).status).toBe("expired");
    release();
    expect(await capturing).toBe("block");
    expect(observer!.current().status).toBe("expired");
    await observer!.close();
  });
  it("rejects malformed state instead of allowing unbounded waiting", async () => {
    const client = verificationTransport(
      async () =>
        new Response(
          '{"id":"x","version":1,"status":"preparing","expiresAt":"never"}',
          { status: 200 },
        ),
    );
    await expect(client.register("injection", "browser")).rejects.toThrow(
      "Unreadable purchase verification response",
    );
  });
  it("reserves capture before a concurrent report and refuses success-shaped disablement", async () => {
    const capture = {
      url: "https://bank.example/challenge",
      body: "creq=original",
    };
    let state = initial();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const report = jest.fn(async () => {
      await gate;
      state = {
        ...state,
        version: 2,
        challengeCaptured: true,
        status: "requires_action",
      };
      return state;
    });
    const observer = await VerificationSession.attach(
      { register: async () => state, sync: async () => state, report },
      {
        inspect: async () => ({ capture }),
        relayed: () => {},
        reconcile: async () => null,
      },
      "injection",
    );
    const request = { ...capture, method: "POST", sessionId: "original" };
    const first = observer!.inspect(request);
    expect(await observer!.inspect(request)).toBe("block");
    release();
    expect(await first).toBe("capture");
    expect(report).toHaveBeenCalledTimes(1);
    await observer!.close();
    await expect(
      verificationTransport(
        async () => new Response('{"code":"verification_unavailable"}'),
      ).register("injection", "browser"),
    ).rejects.toThrow("Unreadable purchase verification response");
  });
  it("rejects malformed control booleans", async () => {
    await expect(
      verificationTransport(
        async () =>
          new Response(JSON.stringify({ ...initial(), launchClaimed: "true" })),
      ).register("injection", "browser"),
    ).rejects.toThrow("Unreadable purchase verification response");
  });
  it("stops the observer when CDP setup fails after registration", async () => {
    jest.useFakeTimers();
    const state = initial();
    const sync = jest.fn(async () => state);
    const report = jest.fn(async () => ({
      ...state,
      status: "error" as const,
    }));
    const connection = {
      close: jest.fn(),
      onEvent: jest.fn(),
      onClose: jest.fn(),
      send: jest.fn(async (_method, params) => {
        if (params?.autoAttach === true) throw new Error("setup failed");
        return {};
      }),
    };
    const connect = jest
      .spyOn(CdpConnection, "connect")
      .mockResolvedValue(connection as unknown as CdpConnection);
    try {
      await expect(
        attachInterceptor("ws://localhost/browser", {
          placeholder: {
            number: "4242424242424242",
            injectionRef: "injection",
          },
          relay: {
            relay: async () => {
              throw new Error("not used");
            },
            verification: { register: async () => state, sync, report },
          },
          verificationAdapter: () => ({
            inspect: async () => "continue",
            relayed: () => {},
            reconcile: async () => null,
          }),
        }),
      ).rejects.toThrow("setup failed");
      await jest.advanceTimersByTimeAsync(5000);
      expect(sync).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(
        "verification",
        expect.objectContaining({ kind: "browser_lost" }),
      );
      expect(connection.close).toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
