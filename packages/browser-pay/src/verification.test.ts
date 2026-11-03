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
        report: async () => {
          state = {
            ...state,
            status: "ended",
            observation: { outcome: "confirmed", source: "runner" },
          };
          return state;
        },
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
