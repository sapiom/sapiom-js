import { VerificationSession } from "./verification";
import type {
  VerificationState,
  VerificationAdapter,
  VerificationRunnerReply,
  VerificationRunner,
  VerificationRequest,
} from "./verification-types";

function fixture(change: Partial<VerificationState> = {}) {
  let state: VerificationRunnerReply = {
    id: "v-1",
    version: 1,
    status: "preparing",
    merchantOrigin: "https://shop.example",
    total: { amount: "10.00", currency: "USD" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    challengeCaptured: false,
    launchClaimed: false,
    continuationClaimed: false,
    checkRequested: false,
    ...change,
  };
  const adapter: VerificationAdapter = {
    inspect: jest.fn(async (r) => ({ capture: { url: r.url, body: r.body } })),
    relayed: jest.fn(),
    reconcile: jest.fn(async () => null),
    dispose: jest.fn(),
    continuation: jest.fn(async () => null),
  };
  const runner: VerificationRunner = {
    sync: jest.fn(async () => state),
    report: jest.fn(async (_id, input) => {
      state = {
        ...state,
        version: state.version + 1,
        ...(input.kind === "challenge_observed" && { challengeCaptured: true }),
        ...(input.kind === "continuation_started" && {
          continuationClaimed: true,
        }),
      };
      return state;
    }),
  };
  const session = VerificationSession.attach(runner, adapter, state);
  return {
    session,
    adapter,
    runner,
    get state() {
      return state;
    },
    set state(s) {
      state = s;
    },
  };
}
const request = (
  body = "creq=challenge",
  url = "https://bank.example/acs",
): VerificationRequest => ({
  url,
  method: "POST",
  body,
  sessionId: "s",
  frameId: "f",
  networkId: "n",
});
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("purchase-bound VerificationSession", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("captures once and fences concurrent and duplicate handoffs", async () => {
    const f = fixture();
    const receipt = pending<VerificationRunnerReply>();
    f.runner.report = jest.fn(() => receipt.promise);
    const first = f.session.inspect(request());
    await flush();
    expect(f.session.submissionBlocked()).toBe(true);
    expect(await f.session.inspect(request())).toBe("block");
    receipt.resolve({ ...f.state, version: 2, challengeCaptured: true });
    expect(await first).toBe("capture");
    expect(await f.session.inspect(request())).toBe("block");
    expect(f.runner.report).toHaveBeenCalledTimes(1);
    await f.session.close();
  });

  it("keeps ambiguous reports fenced and retries with the same version and key", async () => {
    const f = fixture();
    f.runner.report = jest.fn(async () => {
      throw new Error("private transport details");
    });
    await expect(f.session.inspect(request())).rejects.toThrow(
      "Purchase verification report failed",
    );
    const calls = (f.runner.report as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual(calls[2]);
    expect(calls[0][1]).toMatchObject({
      expectedVersion: 1,
      idempotencyKey: expect.any(String),
    });
    expect(f.session.submissionBlocked()).toBe(true);
    expect(await f.session.inspect(request())).toBe("block");
    await f.session.close();
  });

  it("uses native fallback before capture but blocks fallback after capture", async () => {
    const f = fixture();
    f.adapter.inspect = jest.fn(async () => "fallback");
    expect(await f.session.inspect(request())).toBe("continue");
    expect(await f.session.inspect(request())).toBe("continue");
    expect(f.adapter.inspect).toHaveBeenCalledTimes(1);
    expect(f.session.submissionBlocked()).toBe(false);
    await f.session.close();
    const captured = fixture({ challengeCaptured: true });
    captured.adapter.inspect = jest.fn(async () => "fallback");
    expect(await captured.session.inspect(request())).toBe("block");
    expect(captured.session.submissionBlocked()).toBe(true);
    await captured.session.close();
  });

  it("returns to native checkout after a definite uncaptured terminal rejection", async () => {
    const f = fixture();
    f.runner.report = jest.fn(
      async (): Promise<VerificationRunnerReply> => ({
        ...f.state,
        version: 2,
        status: "canceled",
      }),
    );
    expect(await f.session.inspect(request())).toBe("continue");
    expect(f.session.submissionBlocked()).toBe(false);
    expect(await f.session.inspect(request())).toBe("continue");
    await f.session.close();
  });

  it("keeps ordinary traffic native on adapter errors, blocking recognized ACS POSTs", async () => {
    const f = fixture();
    f.adapter.inspect = jest.fn(async () => {
      throw new Error("private adapter detail");
    });
    expect(await f.session.inspect(request())).toBe("block");
    expect(
      await f.session.inspect(request(JSON.stringify({ messageType: "CReq" }))),
    ).toBe("block");
    expect(await f.session.inspect(request("ordinary=data"))).toBe("continue");
    expect(
      await f.session.inspect(
        request("creq=merchant", "https://shop.example/checkout"),
      ),
    ).toBe("continue");
    expect(await f.session.inspect(request("creq=bad", "invalid-url"))).toBe(
      "continue",
    );
    await f.session.close();
  });

  it("rejects mismatched captured bytes without reporting them", async () => {
    const f = fixture();
    f.adapter.inspect = jest.fn(async () => ({
      capture: { url: "https://other.example", body: "different" },
    }));
    expect(await f.session.inspect(request())).toBe("block");
    expect(f.runner.report).not.toHaveBeenCalled();
    await f.session.close();
  });

  it.each([
    { id: "other" },
    { version: 0 },
    { version: NaN },
    { expiresAt: "invalid" },
    { expiresAt: new Date(0).toISOString() },
    { merchantOrigin: "https://other.example" },
    { total: { amount: "11.00", currency: "USD" } },
    { total: { amount: "10.00", currency: "EUR" } },
    { status: "bogus" },
    { challengeCaptured: "yes" },
    { nativeReturnProtocol: "braintree_cardinal" },
    { nativeReturn: { protocol: "stripe_3ds2", cres: "private" } },
  ])("rejects invalid or rebound runner replies: %j", async (change) => {
    const f = fixture();
    f.runner.sync = jest.fn(
      async () => ({ ...f.state, ...change }) as VerificationState,
    );
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.session.current()).toEqual(f.state);
    expect(f.adapter.reconcile).not.toHaveBeenCalled();
    await f.session.close();
  });

  it("rejects malformed initial state", () => {
    expect(() =>
      VerificationSession.attach(
        {} as VerificationRunner,
        {} as VerificationAdapter,
        {} as VerificationState,
      ),
    ).toThrow("Invalid purchase verification state");
  });

  it("clones nested snapshots, excludes unknown properties and native material", async () => {
    const f = fixture({
      status: "ended",
      observation: { outcome: "confirmed", source: "runner" },
      privateExtra: "hidden",
    } as Partial<VerificationState>);
    const snapshot = f.session.current();
    snapshot.total.amount = "999";
    snapshot.observation!.outcome = "failed";
    expect(f.session.current().total.amount).toBe("10.00");
    expect(f.session.current().observation!.outcome).toBe("confirmed");
    expect(f.session.current()).not.toHaveProperty("privateExtra");
    await expect(f.session.wait()).resolves.toMatchObject({ status: "ended" });
    expect(f.adapter.dispose).toHaveBeenCalledTimes(1);
    await f.session.close();
  });

  it("expires and resolves waiters even when runner sync hangs; late state cannot reopen", async () => {
    const f = fixture({ expiresAt: new Date(Date.now() + 3000).toISOString() });
    const sync = pending<VerificationState>();
    f.runner.sync = jest.fn(() => sync.promise);
    const terminal = f.session.wait();
    await jest.advanceTimersByTimeAsync(4000);
    await expect(terminal).resolves.toMatchObject({ status: "expired" });
    sync.resolve({ ...f.state, version: 2 });
    await flush();
    expect(f.session.current().status).toBe("expired");
    expect(f.adapter.dispose).toHaveBeenCalledTimes(1);
    await f.session.close();
  });

  it("expires while capture receipt hangs, never allowing late challenge fulfillment", async () => {
    const f = fixture({ expiresAt: new Date(Date.now() + 3000).toISOString() });
    const report = pending<VerificationRunnerReply>();
    f.runner.report = jest.fn(() => report.promise);
    const capture = f.session.inspect(request());
    const terminal = f.session.wait();
    await jest.advanceTimersByTimeAsync(4000);
    await expect(terminal).resolves.toMatchObject({ status: "expired" });
    report.resolve({ ...f.state, version: 2, challengeCaptured: true });
    expect(await capture).toBe("block");
    expect(f.session.current().status).toBe("expired");
    await f.session.close();
  });

  it("expires before calling a disposed adapter, including between polling ticks", async () => {
    const f = fixture({ expiresAt: new Date(Date.now() + 500).toISOString() });
    jest.setSystemTime(Date.now() + 1000);
    expect(await f.session.inspect(request())).toBe("continue");
    expect(f.session.current().status).toBe("expired");
    expect(f.adapter.inspect).not.toHaveBeenCalled();
    expect(f.adapter.dispose).toHaveBeenCalledTimes(1);
    await f.session.close();
  });

  it.each(["ended", "expired", "canceled", "error"] as const)(
    "preserves the fence without a disposed inspector after %s",
    async (status) => {
      for (const claim of ["challengeCaptured", "launchClaimed"] as const) {
        const f = fixture({ status, [claim]: true });
        (f.adapter.inspect as jest.Mock).mockResolvedValue("continue");
        expect(await f.session.inspect(request())).toBe("block");
        expect(
          await f.session.inspect({ ...request(), method: "GET", body: "" }),
        ).toBe("continue");
        expect(f.adapter.inspect).not.toHaveBeenCalled();
        expect(f.adapter.dispose).toHaveBeenCalledTimes(1);
        expect(f.session.submissionBlocked()).toBe(true);
        await f.session.close();
      }
    },
  );

  it("keeps an uncertain capture fenced after expiry without using the disposed adapter", async () => {
    const f = fixture({ expiresAt: new Date(Date.now() + 500).toISOString() });
    const receipt = pending<VerificationRunnerReply>();
    f.runner.report = jest.fn(() => receipt.promise);
    const first = f.session.inspect(request());
    await flush();
    jest.setSystemTime(Date.now() + 1000);
    (f.adapter.inspect as jest.Mock).mockResolvedValue("continue");
    expect(await f.session.inspect(request())).toBe("block");
    expect(
      await f.session.inspect({ ...request(), method: "GET", body: "" }),
    ).toBe("continue");
    expect(f.adapter.inspect).toHaveBeenCalledTimes(1);
    receipt.resolve({ ...f.state, version: 2, challengeCaptured: true });
    expect(await first).toBe("block");
    await f.session.close();
  });

  it("closes locally within one second even when browser_lost hangs", async () => {
    const f = fixture();
    f.runner.report = jest.fn(() => new Promise(() => {}));
    const wait = f.session.wait();
    const close = f.session.close();
    await expect(wait).resolves.toMatchObject({ status: "error" });
    await jest.advanceTimersByTimeAsync(1000);
    await close;
    await f.session.close();
    expect(f.adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("claims continuation durably, delivers return once, and retries only its acknowledgment", async () => {
    const f = fixture({
      challengeCaptured: true,
      launchClaimed: true,
      nativeReturnAvailable: true,
      nativeReturnProtocol: "stripe_3ds2",
    });
    const resume = jest.fn(async () => {
      expect(f.session.current().continuationClaimed).toBe(true);
      expect(f.session.current()).not.toHaveProperty("nativeReturn");
      return { interactionReturned: true as const };
    });
    f.adapter.continuation = jest.fn(async () => resume);
    let ackAttempts = 0;
    f.runner.report = jest.fn(async (_id, input) => {
      if (input.kind === "interaction_resumed" && ackAttempts++ < 3)
        throw new Error("lost receipt");
      f.state = {
        ...f.state,
        version: f.state.version + 1,
        ...(input.kind === "continuation_started" && {
          continuationClaimed: true,
        }),
        ...(input.kind === "interaction_resumed" && {
          interactionReturned: true,
        }),
      };
      return {
        ...f.state,
        ...(input.kind === "continuation_started" && {
          nativeReturn: { protocol: "stripe_3ds2" as const, cres: "Y3Jlcw" },
        }),
      };
    });
    await jest.advanceTimersByTimeAsync(4000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({
      protocol: "stripe_3ds2",
      cres: "Y3Jlcw",
    });
    const reports = (f.runner.report as jest.Mock).mock.calls.map(
      ([, input]) => input,
    );
    const acks = reports.filter((i) => i.kind === "interaction_resumed");
    expect(acks).toHaveLength(4);
    expect(new Set(acks.map((i) => i.idempotencyKey)).size).toBe(1);
    expect(f.session.current().interactionReturned).toBe(true);
    await f.session.close();
  });

  it("reports continuation delivery failure without a second return", async () => {
    const f = fixture({ challengeCaptured: true, launchClaimed: true });
    const resume = jest.fn(async () => {
      throw new Error("frame disappeared");
    });
    f.adapter.continuation = jest.fn(async () => resume);
    await jest.advanceTimersByTimeAsync(4000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(f.runner.report).toHaveBeenCalledWith(
      "v-1",
      expect.objectContaining({ kind: "continuation_failed" }),
    );
    await f.session.close();
  });

  it("reconciles passive checkout outcome and resolves waiters from the runner receipt", async () => {
    const f = fixture();
    const observation = {
      outcome: "confirmed" as const,
      amount: "10.00",
      currency: "USD",
    };
    f.adapter.reconcile = jest.fn(async () => observation);
    f.runner.report = jest.fn(
      async (): Promise<VerificationRunnerReply> => ({
        ...f.state,
        version: 2,
        status: "ended",
        observation: { outcome: "confirmed", source: "runner" },
      }),
    );
    const wait = f.session.wait();
    await jest.advanceTimersByTimeAsync(2000);
    await expect(wait).resolves.toMatchObject({
      status: "ended",
      observation: { outcome: "confirmed" },
    });
    expect(f.runner.report).toHaveBeenCalledWith(
      "v-1",
      expect.objectContaining({ kind: "checkout_observed", observation }),
    );
    await f.session.close();
  });
});
