import {
  SAPIOM_CALL_MARKER_KEY,
  SapiomCallError,
  capabilityOf,
  ensureOk,
  failIfNotOk,
  markSapiomCall,
  parseRetryAfter,
  readSapiomCall,
} from "./sapiom-call.js";

class FakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "FakeError";
  }
}
const makeFake = ({
  message,
  status,
  body,
}: {
  message: string;
  status: number;
  body: unknown;
}): Error => new FakeError(message, status, body);

describe("markSapiomCall() / readSapiomCall()", () => {
  it("stamps the facts without touching the error's own fields", () => {
    const err = new FakeError("Failed to search: 503 down", 503, { e: "down" });

    markSapiomCall(err, { capability: "web.search", status: 503 });

    expect(err).toBeInstanceOf(FakeError);
    expect(err.status).toBe(503);
    expect(err.body).toEqual({ e: "down" });
    expect(err.message).toBe("Failed to search: 503 down");
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "web.search",
      status: 503,
    });
  });

  it("is idempotent: the innermost call that saw the response wins", () => {
    const err = markSapiomCall(new Error("boom"), { status: 503 });

    markSapiomCall(err, { status: 404, capability: "later" });

    expect(readSapiomCall(err)).toEqual({ version: 1, status: 503 });
  });

  it("drops malformed facts rather than recording them", () => {
    const err = markSapiomCall(new Error("boom"), {
      status: 503.5,
      capability: "",
      retryAfterMs: -1,
      network: false,
    });

    expect(readSapiomCall(err)).toEqual({ version: 1 });
  });

  it("rounds a fractional Retry-After and truncates a long capability", () => {
    const err = markSapiomCall(new Error("boom"), {
      status: 429,
      retryAfterMs: 1500.7,
      capability: "x".repeat(500),
    });

    expect(readSapiomCall(err)?.retryAfterMs).toBe(1501);
    expect(readSapiomCall(err)?.capability).toHaveLength(200);
  });

  it("never throws, whatever it is handed", () => {
    const frozen = Object.freeze(new Error("frozen"));

    expect(() => markSapiomCall(frozen, { status: 503 })).not.toThrow();
    expect(readSapiomCall(frozen)).toBeUndefined();
    expect(readSapiomCall(undefined)).toBeUndefined();
    expect(readSapiomCall(null)).toBeUndefined();
    expect(readSapiomCall("a string")).toBeUndefined();
    expect(readSapiomCall({ sapiomCall: "not a marker" })).toBeUndefined();
    expect(
      readSapiomCall(
        Object.defineProperty({}, SAPIOM_CALL_MARKER_KEY, {
          get() {
            throw new Error("hostile accessor");
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("reads a marker stamped by another bundle copy, including a later version", () => {
    const fromAnotherCopy = { sapiomCall: { version: 2, status: 503 } };

    expect(readSapiomCall(fromAnotherCopy)).toEqual({
      version: 2,
      status: 503,
    });
  });
});

describe("ensureOk()", () => {
  it("returns a 2xx response untouched", async () => {
    const ok = new Response("{}", { status: 200 });

    await expect(ensureOk(ok, "Failed", makeFake, "web.search")).resolves.toBe(
      ok,
    );
  });

  it("throws the capability's own class with the facts stamped", async () => {
    const res = new Response(JSON.stringify({ error: "down" }), {
      status: 503,
      headers: { "Retry-After": "2" },
    });

    const err = await ensureOk(res, "Failed to search", makeFake, "web.search")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FakeError);
    expect((err as FakeError).message).toBe(
      `Failed to search: 503 ${JSON.stringify({ error: "down" })}`,
    );
    expect((err as FakeError).body).toEqual({ error: "down" });
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "web.search",
      status: 503,
      retryAfterMs: 2000,
    });
  });

  it("stamps a deterministic failure too: facts carry no verdict", async () => {
    const res = new Response("not found", { status: 404 });

    const err = await ensureOk(res, "Failed to search", makeFake, "web.search")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "web.search",
      status: 404,
    });
  });

  it("falls back to the raw text when the body is not JSON", async () => {
    const err = await ensureOk(
      new Response("plain text", { status: 500 }),
      "Failed",
      makeFake,
    )
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as FakeError).body).toBe("plain text");
    expect(readSapiomCall(err)).toEqual({ version: 1, status: 500 });
  });
});

describe("failIfNotOk()", () => {
  it("keeps the legacy message shape on a SapiomCallError", async () => {
    const err = await failIfNotOk(
      new Response("boom", { status: 502 }),
      "Failed to create sandbox",
      "sandboxes",
    )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SapiomCallError);
    expect(err).toBeInstanceOf(Error);
    expect((err as SapiomCallError).message).toBe(
      "Failed to create sandbox: 502 boom",
    );
    expect((err as SapiomCallError).status).toBe(502);
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "sandboxes",
      status: 502,
    });
  });
});

describe("parseRetryAfter()", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP-date", () => {
    const soon = new Date(Date.now() + 5_000).toUTCString();

    expect(parseRetryAfter(soon)).toBeGreaterThan(3_000);
  });

  it("returns undefined for a missing or unparseable value", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon please")).toBeUndefined();
  });

  it("clamps a value already in the past to zero (ported behavior)", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(
      0,
    );
  });
});

describe("capabilityOf()", () => {
  it.each([
    ["https://api.sapiom.ai/v1/capabilities/web.search", "web.search"],
    ["https://api.sapiom.ai/v1/memory", "memory"],
    ["https://api.sapiom.ai/v2/anthropic/v1/messages", "anthropic"],
    ["https://api.sapiom.ai/v2/sessions/abc-123", "sessions"],
    ["https://api.sapiom.ai/models/v1/coding/runs", "coding"],
    ["https://api.sapiom.ai/files", "files"],
  ])("labels %s as %s", (url, expected) => {
    expect(capabilityOf(url)).toBe(expected);
  });

  it("never lets a resource id through", () => {
    expect(
      capabilityOf(
        "https://api.sapiom.ai/v1/databases/6f1c0f4e-2a1e-4f6a-9a3e-1c2d3e4f5a6b",
      ),
    ).toBe("databases");
    expect(
      capabilityOf("https://api.sapiom.ai/v1/sandboxes/my-box/filesystem"),
    ).toBe("sandboxes");
  });

  it("returns undefined when there is nothing safe to label", () => {
    expect(capabilityOf("not a url")).toBeUndefined();
    expect(capabilityOf("https://api.sapiom.ai/")).toBeUndefined();
    expect(capabilityOf("https://api.sapiom.ai/v1/%20weird")).toBeUndefined();
  });
});
