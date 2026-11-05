import {
  VerificationSession,
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
  it.each(["ended", "expired", "canceled", "error"] as const)(
    "returns a registered %s session without starting a polling timer",
    async (status) => {
      jest.useFakeTimers();
      const state = { ...initial(), status };
      const sync = jest.fn(async () => state);
      const reconcile = jest.fn(async () => null);
      const observer = await VerificationSession.attach(
        { register: async () => state, sync, report: async () => state },
        { inspect: async () => "continue", relayed() {}, reconcile },
        "injection",
      );
      expect(jest.getTimerCount()).toBe(0);
      await expect(observer!.wait()).resolves.toEqual(state);
      await jest.advanceTimersByTimeAsync(4001);
      expect(sync).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
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
