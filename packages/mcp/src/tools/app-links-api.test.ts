import { CredentialChannelError } from "@sapiom/analytics-core/credential";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { appLinksFetch } from "./app-links-api.js";

const ENV = "SAPIOM_ALLOW_INSECURE_HTTP";
const ORIGINAL_ENV = process.env[ENV];
const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

const sentKey = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  (fetchMock.mock.calls[call][1] as { headers: Record<string, string> })
    .headers["x-api-key"];

describe("appLinksFetch credential channel", () => {
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });
  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env[ENV];
    else process.env[ENV] = ORIGINAL_ENV;
  });

  it("refuses plaintext to a non-loopback host as a network failure, nothing sent", async () => {
    const fetchMock = mockFetch();
    const result = await appLinksFetch(
      "http://api.internal",
      "sk_live",
      "GET",
      "/v1/app-links",
    );
    expect(result).toMatchObject({
      kind: "network",
      url: "http://api.internal/v1/app-links",
    });
    const cause = (result as { cause: unknown }).cause;
    expect(cause).toBeInstanceOf(CredentialChannelError);
    expect(String(cause)).toMatch(
      /@sapiom\/mcp: refusing plaintext HTTP.*opt in with SAPIOM_ALLOW_INSECURE_HTTP=1\.$/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["the env opt-in", "http://api.internal", "1"],
    ["a loopback host", "http://localhost:3000", undefined],
  ])("sends over plain http with %s", async (_label, apiURL, env) => {
    if (env) process.env[ENV] = env;
    const fetchMock = mockFetch(new Response('{"items":[]}', { status: 200 }));
    const result = await appLinksFetch(
      apiURL,
      "sk_live",
      "GET",
      "/v1/app-links",
    );
    expect(result).toEqual({
      kind: "response",
      status: 200,
      ok: true,
      data: { items: [] },
    });
    expect(sentKey(fetchMock, 0)).toBe("sk_live");
  });

  it("drops x-api-key on a redirect to another origin", async () => {
    const fetchMock = mockFetch(
      new Response(null, {
        status: 307,
        headers: { location: "https://other.example/v1/app-links" },
      }),
      new Response('{"items":[]}', { status: 200 }),
    );
    await appLinksFetch(
      "https://api.sapiom.ai",
      "sk_live",
      "POST",
      "/v1/app-links",
      { name: "x" },
    );
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.sapiom.ai/v1/app-links",
      "https://other.example/v1/app-links",
    ]);
    expect([sentKey(fetchMock, 0), sentKey(fetchMock, 1)]).toEqual([
      "sk_live",
      undefined,
    ]);
  });
});
