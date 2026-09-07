import { Transport } from "../_client/index.js";
import * as github from "./index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "sat_run-token",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://tools.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

const REPOS = [
  {
    id: 1,
    name: "app",
    fullName: "acme/app",
    private: true,
    htmlUrl: "https://github.com/acme/app",
    description: "the app",
  },
  {
    id: 2,
    name: "docs",
    fullName: "acme/docs",
    private: false,
    htmlUrl: "https://github.com/acme/docs",
    description: null,
  },
];

describe("github.listRepos", () => {
  it("POSTs methods/listRepos on x-sapiom-api-key with the args body, returns the GitHubRepo[]", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(REPOS)]);

    const args = { perPage: 50, page: 1, visibility: "all" } as const;
    const result = await github.listRepos(args, transport, BASE);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/github/methods/listRepos`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    // Default gateway credential header — the run sat_ rides x-sapiom-api-key, NOT x-api-key.
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "x-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // Args pass through untouched — no normalization (unlike gmail recipients).
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(args);
    expect(result).toEqual(REPOS);
  });

  it("POSTs an empty object body when called with no args", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(REPOS)]);

    const result = await github.listRepos(undefined, transport, BASE);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/github/methods/listRepos`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    // No args → `{}` crosses the wire (the gateway still expects a JSON body).
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
    expect(result).toEqual(REPOS);
  });

  it("surfaces a 404 (no GitHub connector for this tenant) with the connector_not_found body", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "connector_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(github.listRepos(undefined, transport, BASE)).rejects.toThrow(
      /404/,
    );
    await expect(github.listRepos(undefined, transport, BASE)).rejects.toThrow(
      /connector_not_found/,
    );
  });

  it("surfaces a 502 (upstream GitHub failure) from listRepos", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({ error: "connector_method_upstream_failed" }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ]);
    await expect(
      github.listRepos({ perPage: 10 }, transport, BASE),
    ).rejects.toThrow(/502/);
  });
});
