import { parseRetryAfterMs } from "./errors.js";

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");

  it("reads a delay in seconds", () => {
    expect(parseRetryAfterMs("7", now)).toBe(7_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP-date relative to now, clamping the past to zero", () => {
    expect(parseRetryAfterMs("Tue, 22 Sep 2026 12:00:30 GMT", now)).toBe(
      30_000,
    );
    expect(parseRetryAfterMs("Tue, 22 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("is null for a missing or unparseable header", () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs("-5", now)).toBeNull();
  });
});
