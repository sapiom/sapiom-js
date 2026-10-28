import {
  redactSearch,
  redactUrlForFacts,
  sanitizeFactHeaders,
} from "./facts-redaction";

describe("sanitizeFactHeaders", () => {
  it("drops every listed credential header, whatever its case", () => {
    const dropped = [
      "Authorization",
      "Proxy-Authorization",
      "Cookie",
      "Set-Cookie",
      "X-Api-Key",
      "x-sapiom-api-key",
      "X-Auth-Token",
      "Sapiom-Identity",
      "X-PAYMENT",
      "PAYMENT-SIGNATURE",
    ];
    const headers = Object.fromEntries(dropped.map((name) => [name, "v"]));

    expect(sanitizeFactHeaders(headers)).toEqual({});
  });

  it("drops any header whose name contains a credential word", () => {
    expect(
      sanitizeFactHeaders({
        "x-custom-auth": "a",
        "x-client-key": "k",
        "x-refresh-token": "t",
        "x-cookie-jar": "c",
        "x-app-secret": "s",
        "x-db-password": "p",
        "x-session-id": "i",
        "x-request-signature": "g",
      }),
    ).toEqual({});
  });

  it("keeps ordinary headers and stringifies their values", () => {
    expect(
      sanitizeFactHeaders({
        "content-type": "application/json",
        accept: "*/*",
        "X-Sapiom-Transaction-Id": "tx_1",
        "content-length": 12,
        "x-empty": undefined,
      }),
    ).toEqual({
      "content-type": "application/json",
      accept: "*/*",
      "X-Sapiom-Transaction-Id": "tx_1",
      "content-length": "12",
    });
  });

  it("reads a Headers instance", () => {
    const headers = new Headers({ cookie: "c=1", accept: "text/plain" });

    expect(sanitizeFactHeaders(headers)).toEqual({ accept: "text/plain" });
  });

  it("returns an empty record for missing headers", () => {
    expect(sanitizeFactHeaders(undefined)).toEqual({});
    expect(sanitizeFactHeaders(null)).toEqual({});
  });
});

describe("redactUrlForFacts", () => {
  it("empties query values and drops userinfo and fragment", () => {
    expect(redactUrlForFacts("https://u:p@h.example/p?a=1&b=2#f")).toBe(
      "https://h.example/p?a=&b=",
    );
  });

  it("keeps a URL without query unchanged", () => {
    expect(redactUrlForFacts("https://h.example:8443/p/q")).toBe(
      "https://h.example:8443/p/q",
    );
  });

  it("keeps a relative URL relative", () => {
    expect(redactUrlForFacts("/p?x=1")).toBe("/p?x=");
    expect(redactUrlForFacts("p/q")).toBe("/p/q");
  });

  it("keeps repeated keys once per occurrence", () => {
    expect(redactUrlForFacts("https://h.example/p?a=1&a=2")).toBe(
      "https://h.example/p?a=&a=",
    );
  });
});

describe("redactSearch", () => {
  it("empties every value", () => {
    expect(redactSearch("?q=secret&page=2")).toBe("?q=&page=");
  });

  it("returns an empty string for no query", () => {
    expect(redactSearch("")).toBe("");
    expect(redactSearch("?")).toBe("");
  });
});
