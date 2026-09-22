import { parseExecution, normalizeBaseUrl, validateKey } from "./protocol.js";
import { ExecutionProtocolError, executionFailureStatus } from "./errors.js";

// C03 presenter contract, version 1. POST never contains an outcome, even on replay.
export const receipt = {
  version: 1 as const,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "fixture.echo",
  status: "queued" as const,
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-22T00:00:00.000Z",
};
describe("execution API v1", () => {
  it.each(["queued", "running", "succeeded", "failed", "indeterminate"])(
    "parses a %s receipt without inventing a result",
    (status) => {
      expect(parseExecution({ ...receipt, status }, false)).toEqual({
        ...receipt,
        status,
      });
    },
  );
  it.each([null, { ok: true }, 0, "", []])(
    "allows the JSON result %p",
    (result) => {
      expect(
        parseExecution({ ...receipt, status: "succeeded", result }, true),
      ).toMatchObject({ result });
    },
  );
  it.each([
    "invalid_request",
    "rate_limited",
    "capability_usage_limit",
    "deadline_exceeded",
    "execution_failed",
    "execution_indeterminate",
  ])("parses safe %s outcomes", (code) => {
    const state = {
      ...receipt,
      status: code === "execution_indeterminate" ? "indeterminate" : "failed",
      error: { code, message: "Safe message" },
    };
    expect(parseExecution(state, true)).toEqual(state);
  });
  it.each([
    { version: 2 },
    { id: "../secret" },
    { capabilityId: "../secret" },
    { status: "cancelled" },
    { createdAt: "yesterday" },
    { expiresAt: "2026-99-99T00:00:00Z" },
    { result: {} },
    { error: {} },
    { status: "succeeded" },
    { status: "failed", error: { code: "secret", message: "no" } },
    {
      status: "failed",
      error: { code: "execution_indeterminate", message: "no" },
    },
    {
      status: "indeterminate",
      error: { code: "execution_failed", message: "no" },
    },
    { status: "succeeded", result: null, error: {} },
  ])("rejects malformed/contradictory envelopes %p", (patch) => {
    expect(() => parseExecution({ ...receipt, ...patch }, true)).toThrow(
      ExecutionProtocolError,
    );
  });
  it("checks the requested identity and strips untrusted URLs", () => {
    expect(() =>
      parseExecution(receipt, true, {
        executionId: "other",
        submissionKey: "saved",
      }),
    ).toThrow(
      expect.objectContaining({ executionId: "other", submissionKey: "saved" }),
    );
    expect(() =>
      parseExecution(receipt, false, {}, "different.capability"),
    ).toThrow(ExecutionProtocolError);
    expect(
      parseExecution({ ...receipt, url: "https://evil.test" }, false),
    ).toEqual(receipt);
    expect(() =>
      parseExecution({ ...receipt, status: "succeeded", result: 1 }, false),
    ).toThrow(ExecutionProtocolError);
  });
  it("documents logical failure classifications separately from HTTP errors", () => {
    expect(executionFailureStatus).toEqual({
      invalid_request: 400,
      rate_limited: 429,
      capability_usage_limit: 429,
      deadline_exceeded: 504,
      execution_failed: 502,
      execution_indeterminate: 502,
    });
  });
  it.each([
    "file:///tmp/x",
    "https://u:p@api.test",
    "https://api.test/?secret=x",
    "https://api.test/#secret",
  ])("rejects unsafe configured base %s", (url) => {
    expect(() => normalizeBaseUrl(url)).toThrow(ExecutionProtocolError);
  });
  it("normalizes the base and validates server-compatible keys", () => {
    expect(normalizeBaseUrl("https://API.test:443/core/")).toBe(
      "https://api.test/core",
    );
    expect(() => validateKey("persist-me:123")).not.toThrow();
    for (const key of ["", "a b", "å", "x".repeat(201)])
      expect(() => validateKey(key)).toThrow();
  });
});
