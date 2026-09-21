import { Transport } from "../../_client/index.js";
import * as google from "./index.js";

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

const BASE = "https://tools.sapiom.ai";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

describe("google.authClient()", () => {
  // The deep multi-host / header / error-surfacing behavior of the proxy-backed client is
  // covered by auth-client.e2e.spec.ts; this just checks the wiring from this module.

  it("returns a real OAuth2Client", async () => {
    const { transport } = makeTransport([]);

    const client = await google.authClient(transport);

    expect(client.constructor.name).toBe("OAuth2Client");
    expect(typeof client.request).toBe("function");
  });

  it("routes a request through the connectors proxy, carrying the connector-host header and the run credential but no authorization", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ emailAddress: "me@example.com" }),
    ]);

    const client = await google.authClient(transport);
    const res = await client.request<{ emailAddress: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      method: "GET",
    });

    expect(res.data).toEqual({ emailAddress: "me@example.com" });
    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/providers/google/proxy/gmail/v1/users/me/profile`,
    );
    expect(headerOf(calls[0]!, "x-sapiom-connector-host")).toBe(
      "gmail.googleapis.com",
    );
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "authorization")).toBeUndefined();
  });
});

describe("google.fetch()", () => {
  it("routes an absolute Google URL through the proxy, carrying the upstream host", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ok: true }),
    ]);

    await google.fetch(
      "https://sheets.googleapis.com/v4/spreadsheets/X",
      {},
      transport,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/providers/google/proxy/v4/spreadsheets/X`,
    );
    expect(headerOf(calls[0]!, "x-sapiom-connector-host")).toBe(
      "sheets.googleapis.com",
    );
  });

  it("routes a bare path through the proxy with no connector-host header", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ok: true }),
    ]);

    await google.fetch("/drive/v3/files", {}, transport);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/providers/google/proxy/drive/v3/files`,
    );
    expect(headerOf(calls[0]!, "x-sapiom-connector-host")).toBeUndefined();
  });
});

describe("google.drive", () => {
  it("shareFile POSTs methods/shareFile on x-sapiom-api-key with the args body, returns the permission", async () => {
    const permission = { id: "perm-1", type: "user", role: "writer" };
    const { transport, calls } = makeTransport([
      () => jsonResponse(permission),
    ]);

    const args = {
      fileId: "file-1",
      role: "writer",
      type: "user",
      emailAddress: "a@b.com",
    } as const;
    const result = await google.driveShareFile(args, transport);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/google/methods/shareFile`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "x-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(args);
    expect(result).toEqual(permission);
  });

  it("uploadFile POSTs methods/uploadFile with the args body, returns the file", async () => {
    const file = { id: "file-9", name: "notes.txt", mimeType: "text/plain" };
    const { transport, calls } = makeTransport([() => jsonResponse(file)]);

    const args = {
      name: "notes.txt",
      content: "hello",
      mimeType: "text/plain",
    } as const;
    const result = await google.driveUploadFile(args, transport);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/google/methods/uploadFile`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(args);
    expect(result).toEqual(file);
  });

  it("surfaces a 404 (no Google connector) from shareFile", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "connector_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(
      google.driveShareFile(
        { fileId: "f", role: "reader", type: "anyone" },
        transport,
      ),
    ).rejects.toThrow(/404/);
    await expect(
      google.driveShareFile(
        { fileId: "f", role: "reader", type: "anyone" },
        transport,
      ),
    ).rejects.toThrow(/connector_not_found/);
  });

  it("surfaces a 502 (upstream Drive failure) from uploadFile", async () => {
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
      google.driveUploadFile({ name: "x", content: "y" }, transport),
    ).rejects.toThrow(/502/);
  });
});

describe("google.gmail", () => {
  it("sendEmail POSTs methods/sendEmail on x-sapiom-api-key with a normalized-array body, returns { id, threadId }", async () => {
    const sent = { id: "msg-1", threadId: "thread-1" };
    const { transport, calls } = makeTransport([() => jsonResponse(sent)]);

    const result = await google.gmailSendEmail(
      {
        to: "a@b.com",
        cc: ["c@d.com", "e@f.com"],
        subject: "Hello",
        text: "Hi",
      },
      transport,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/google/methods/sendEmail`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "x-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // to/cc/bcc are normalized to arrays before POST (the gateway is strict — arrays only).
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      to: ["a@b.com"],
      cc: ["c@d.com", "e@f.com"],
      subject: "Hello",
      text: "Hi",
    });
    expect(result).toEqual(sent);
  });

  it("normalizes a single-string bcc and preserves html + attachments; omits absent recipients", async () => {
    const sent = { id: "msg-2", threadId: "thread-2" };
    const { transport, calls } = makeTransport([() => jsonResponse(sent)]);

    await google.gmailSendEmail(
      {
        to: ["a@b.com"],
        bcc: "hidden@x.com",
        subject: "Report",
        html: "<p>hi</p>",
        attachments: [
          {
            filename: "r.pdf",
            mimeType: "application/pdf",
            content: "YmFzZTY0",
          },
        ],
      },
      transport,
    );

    // Single-string bcc → array; no `cc` key emitted when absent.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      to: ["a@b.com"],
      bcc: ["hidden@x.com"],
      subject: "Report",
      html: "<p>hi</p>",
      attachments: [
        { filename: "r.pdf", mimeType: "application/pdf", content: "YmFzZTY0" },
      ],
    });
  });

  it("surfaces a 404 (no Google connector) from sendEmail", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "connector_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(
      google.gmailSendEmail({ to: "a@b.com", subject: "x" }, transport),
    ).rejects.toThrow(/404/);
    await expect(
      google.gmailSendEmail({ to: "a@b.com", subject: "x" }, transport),
    ).rejects.toThrow(/connector_not_found/);
  });

  it("surfaces a 502 (upstream Gmail failure) from sendEmail", async () => {
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
      google.gmailSendEmail({ to: "a@b.com", subject: "x" }, transport),
    ).rejects.toThrow(/502/);
  });
});
