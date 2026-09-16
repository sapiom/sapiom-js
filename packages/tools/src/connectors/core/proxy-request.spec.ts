import { CONNECTOR_HOST_HEADER, toProxyRequest } from "./proxy-request.js";

const PROXY = "https://tools.sapiom.ai";

describe("toProxyRequest (provider-addressed)", () => {
  it("forwards a Gmail (subdomain) URL: path preserved, host in the header value", () => {
    const { url, upstreamHost } = toProxyRequest({
      sdkUrl:
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
      provider: "google",
      proxyBaseUrl: PROXY,
    });
    expect(url).toBe(
      `${PROXY}/connectors/v1/providers/google/proxy/gmail/v1/users/me/messages?maxResults=5`,
    );
    // The whole point of multi-host: Gmail's own subdomain travels in the header, not the path.
    expect(upstreamHost).toBe("gmail.googleapis.com");
  });

  it("forwards a Drive URL on www without inventing a subdomain", () => {
    const { url, upstreamHost } = toProxyRequest({
      sdkUrl: "https://www.googleapis.com/drive/v3/files",
      provider: "google",
      proxyBaseUrl: PROXY,
    });
    expect(url).toBe(
      `${PROXY}/connectors/v1/providers/google/proxy/drive/v3/files`,
    );
    expect(upstreamHost).toBe("www.googleapis.com");
  });

  it("derives a different host per API with zero per-method logic", () => {
    const hostOf = (sdkUrl: string) =>
      toProxyRequest({ sdkUrl, provider: "google", proxyBaseUrl: PROXY })
        .upstreamHost;
    expect(hostOf("https://sheets.googleapis.com/v4/spreadsheets/X")).toBe(
      "sheets.googleapis.com",
    );
    expect(
      hostOf(
        "https://calendar.googleapis.com/calendar/v3/calendars/primary/events",
      ),
    ).toBe("calendar.googleapis.com");
    expect(hostOf("https://people.googleapis.com/v1/people/me")).toBe(
      "people.googleapis.com",
    );
  });

  it("merges SDK-separated query params into the proxied URL", () => {
    const { url } = toProxyRequest({
      sdkUrl: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      provider: "google",
      proxyBaseUrl: PROXY,
      params: { maxResults: 5, q: "is:unread" },
    });
    expect(url).toContain(
      "/providers/google/proxy/gmail/v1/users/me/messages?",
    );
    expect(url).toContain("maxResults=5");
    expect(url).toContain("q=is%3Aunread");
  });

  it("tolerates a trailing slash on the proxy base", () => {
    const { url } = toProxyRequest({
      sdkUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      provider: "google",
      proxyBaseUrl: `${PROXY}/`,
    });
    expect(url).toBe(
      `${PROXY}/connectors/v1/providers/google/proxy/gmail/v1/users/me/profile`,
    );
  });

  it("refuses a non-https upstream (custody must not be silently downgraded)", () => {
    expect(() =>
      toProxyRequest({
        sdkUrl: "http://gmail.googleapis.com/gmail/v1/users/me/profile",
        provider: "google",
        proxyBaseUrl: PROXY,
      }),
    ).toThrow(/non-https/);
  });

  it("exposes the header name the multi-host proxy validates against", () => {
    expect(CONNECTOR_HOST_HEADER).toBe("x-sapiom-connector-host");
  });
});
