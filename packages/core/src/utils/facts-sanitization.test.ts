import {
  REDACTED_FACT_VALUE,
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  sanitizeHeadersForFacts,
  sanitizeUrlForFacts,
} from "./facts-sanitization";

describe("facts sanitization", () => {
  describe("isSensitiveHeaderName", () => {
    it.each([
      "authorization",
      "Authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "payment-signature",
      "x-payment",
      "x-api-key",
      "api-key",
      "apikey",
      "bt-api-key",
      "BT-Trace-Id",
      "x-goog-api-key",
      "x-auth-token",
      "x-client-secret",
      "x-db-password",
      "x-license-key",
      "x-sapiom-api-key",
      "x-sapiom-service-key",
      "x-sapiom-signature",
      "x-sapiom-workflow-token",
    ])("leaves out %s", (name) => {
      expect(isSensitiveHeaderName(name)).toBe(true);
    });

    it.each([
      "content-type",
      "accept",
      "user-agent",
      "x-request-id",
      "x-sapiom-transaction-id",
      "x-sapiom-trace-id",
    ])("keeps %s", (name) => {
      expect(isSensitiveHeaderName(name)).toBe(false);
    });
  });

  describe("isSensitiveQueryParam", () => {
    it.each([
      "key",
      "KEY",
      "api_key",
      "apikey",
      "token",
      "access_token",
      "secret",
      "signature",
      "sig",
      "password",
      "X-Amz-Signature",
      "api%5Fkey",
    ])("masks %s", (name) => {
      expect(isSensitiveQueryParam(name)).toBe(true);
    });

    it.each(["q", "limit", "keyword", "monkey", "author"])(
      "keeps %s",
      (name) => {
        expect(isSensitiveQueryParam(name)).toBe(false);
      },
    );
  });

  describe("sanitizeUrlForFacts", () => {
    it("masks credential query values and keeps every other part as it was", () => {
      expect(
        sanitizeUrlForFacts(
          "https://api.example.com/v1/geocode?key=abc123&address=Paris&access_token=t#top",
        ),
      ).toBe(
        `https://api.example.com/v1/geocode?key=${REDACTED_FACT_VALUE}&address=Paris&access_token=${REDACTED_FACT_VALUE}#top`,
      );
    });

    it("masks userinfo", () => {
      expect(
        sanitizeUrlForFacts("https://alice:hunter2@api.example.com/x"),
      ).toBe(`https://${REDACTED_FACT_VALUE}@api.example.com/x`);
    });

    it("works on a bare search string", () => {
      expect(sanitizeUrlForFacts("?token=abc&q=1")).toBe(
        `?token=${REDACTED_FACT_VALUE}&q=1`,
      );
      expect(sanitizeUrlForFacts("")).toBe("");
    });

    it("returns a URL with nothing to mask unchanged", () => {
      const url = "https://api.example.com/search?q=a%20b&limit=10&keyword=k";
      expect(sanitizeUrlForFacts(url)).toBe(url);
    });
  });

  describe("sanitizeHeadersForFacts", () => {
    it("drops sensitive headers from a record and stringifies the rest", () => {
      expect(
        sanitizeHeadersForFacts({
          "bt-api-key": "k",
          "api-key": "k",
          Authorization: "Bearer t",
          "content-type": "application/json",
          "content-length": 42,
          "x-empty": undefined,
        }),
      ).toEqual({ "content-type": "application/json", "content-length": "42" });
    });

    it("accepts a Headers entries iterable", () => {
      const headers = new Map<string, string>([
        ["set-cookie", "sid=1"],
        ["accept", "*/*"],
      ]);
      expect(sanitizeHeadersForFacts(headers.entries())).toEqual({
        accept: "*/*",
      });
    });

    it("applies an extra exclusion on top of the shared list", () => {
      expect(
        sanitizeHeadersForFacts(
          { "x-idempotency-key-id": "1", accept: "*/*" },
          (name) => name.includes("key"),
        ),
      ).toEqual({ accept: "*/*" });
    });

    it("returns an empty record for no headers", () => {
      expect(sanitizeHeadersForFacts(undefined)).toEqual({});
    });
  });
});
