import {
  VerificationSession,
  verificationTransport,
  type VerificationState,
  type VerificationAdapter,
} from "./verification";

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
});
