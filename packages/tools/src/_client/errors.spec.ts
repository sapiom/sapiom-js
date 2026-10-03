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

  it("drops a delay too large to represent", () => {
    expect(parseRetryAfterMs("9".repeat(20), now)).toBeNull();
  });

  it("drops a date-form delay past a day", () => {
    expect(parseRetryAfterMs("2050 GMT", now)).toBeNull();
    expect(parseRetryAfterMs("Wed, 30 Sep 2026 12:00:00 GMT", now)).toBeNull();
  });

  it("keeps a date-form delay within a day", () => {
    expect(parseRetryAfterMs("Tue, 22 Sep 2026 13:00:00 GMT", now)).toBe(
      3_600_000,
    );
  });
});
