import { Transport } from "../_client/index.js";
import { createClient } from "../client.js";
import * as schedules from "./index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeTransport(body: unknown): {
  transport: Transport;
  calls: FetchCall[];
  fetch: typeof globalThis.fetch;
} {
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
    return jsonResponse(body);
  }) as typeof globalThis.fetch;
  return {
    transport: new Transport({ apiKey: "test-key", fetch: fetchMock }),
    calls,
    fetch: fetchMock,
  };
}

describe("schedules", () => {
  it("previews cron occurrences without a definition route", async () => {
    const response = {
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      occurrences: ["2026-08-03T16:00:00.000Z"],
    };
    const { transport, calls } = makeTransport(response);

    await expect(
      schedules.preview(
        {
          cron: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
          count: 1,
        },
        transport,
        "https://agents.test",
      ),
    ).resolves.toEqual(response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://agents.test/agents/v1/triggers/preview-cron",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      count: 1,
    });
  });

  it("binds preview to an explicit createClient credential", async () => {
    const response = {
      cron: "0 9 * * *",
      timezone: "UTC",
      occurrences: ["2026-08-04T09:00:00.000Z"],
    };
    const { fetch, calls } = makeTransport(response);
    const client = createClient({ apiKey: "test-key", fetch });

    await expect(
      client.schedules.preview({ cron: "0 9 * * *", count: 1 }),
    ).resolves.toEqual(response);
    expect(calls[0]!.url).toBe(
      "https://tools.sapiom.ai/agents/v1/triggers/preview-cron",
    );
  });
});
