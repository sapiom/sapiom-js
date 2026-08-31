import { Transport } from "../_client/index.js";
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

const BASE = "https://tools.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

describe("google.token()", () => {
  it("POSTs connectors/v1/google/materialize on x-sapiom-api-key, no body, and returns the LiveCredential", async () => {
    const credential = {
      kind: "bearer",
      value: "ya29.live-access-token",
      expiresAt: "2026-08-28T01:00:00.000Z",
      baseUrl: "https://www.googleapis.com",
    };
    const { transport, calls } = makeTransport([() => jsonResponse(credential)]);

    const result = await google.token(transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/connectors/v1/google/materialize`);
    expect(calls[0]!.init.method).toBe("POST");
    // Default gateway credential header — the run sat_ rides x-sapiom-api-key, NOT x-api-key.
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "x-api-key")).toBeUndefined();
    // Provider-only contract: no request body.
    expect(calls[0]!.init.body).toBeUndefined();
    expect(result).toEqual(credential);
  });

  it("surfaces a 404 (no Google connector for this tenant) with the connector_not_found body", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "connector_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(google.token(transport, BASE)).rejects.toThrow(/404/);
    await expect(google.token(transport, BASE)).rejects.toThrow(
      /connector_not_found/,
    );
  });

  it("surfaces a 400 (unknown provider) as a thrown error", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "invalid_connector_request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(google.token(transport, BASE)).rejects.toThrow(/400/);
  });
});

describe("google.authClient()", () => {
  // Comfortably beyond the 60s refresh skew regardless of the real clock.
  const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

  it("fetches once and returns a Bearer header", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ kind: "bearer", value: "tok-1", expiresAt: FAR_FUTURE }),
    ]);

    const client = google.authClient(transport, BASE);
    const headers = await client.getRequestHeaders();

    expect(headers).toEqual({ Authorization: "Bearer tok-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/connectors/v1/google/materialize`);
  });

  it("reuses the cached credential while it is well before expiresAt (no second materialize)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ kind: "bearer", value: "tok-1", expiresAt: FAR_FUTURE }),
    ]);

    const client = google.authClient(transport, BASE);
    await client.getRequestHeaders();
    const second = await client.getRequestHeaders();

    expect(second).toEqual({ Authorization: "Bearer tok-1" });
    expect(calls).toHaveLength(1); // served from cache — a long run does not thrash materialize
  });

  it("re-materializes once the cached credential is within the refresh skew of expiresAt", async () => {
    let fetches = 0;
    const { transport, calls } = makeTransport([
      () => {
        fetches += 1;
        // 1st credential expires 30s out (inside the 60s skew at `now`); 2nd is far-future.
        return jsonResponse(
          fetches === 1
            ? { kind: "bearer", value: "tok-1", expiresAt: "2026-08-28T00:00:30.000Z" }
            : { kind: "bearer", value: "tok-2", expiresAt: FAR_FUTURE },
        );
      },
    ]);
    const now = () => Date.parse("2026-08-28T00:00:00.000Z"); // fixed clock

    const client = google.authClient(transport, BASE, now);
    const first = await client.getRequestHeaders();
    const second = await client.getRequestHeaders();

    expect(first).toEqual({ Authorization: "Bearer tok-1" });
    expect(second).toEqual({ Authorization: "Bearer tok-2" }); // refreshed near expiry
    expect(calls).toHaveLength(2);
  });

  it("fetches every call when the credential carries no expiresAt", async () => {
    let n = 0;
    const { transport, calls } = makeTransport([
      () => jsonResponse({ kind: "bearer", value: `tok-${(n += 1)}` }),
    ]);

    const client = google.authClient(transport, BASE);
    const a = await client.getRequestHeaders();
    const b = await client.getRequestHeaders();

    expect(a).toEqual({ Authorization: "Bearer tok-1" });
    expect(b).toEqual({ Authorization: "Bearer tok-2" });
    expect(calls).toHaveLength(2); // absent expiresAt → never cached
  });
});

describe("google.drive", () => {
  it("shareFile POSTs methods/shareFile on x-sapiom-api-key with the args body, returns the permission", async () => {
    const permission = { id: "perm-1", type: "user", role: "writer" };
    const { transport, calls } = makeTransport([() => jsonResponse(permission)]);

    const args = {
      fileId: "file-1",
      role: "writer",
      type: "user",
      emailAddress: "a@b.com",
    } as const;
    const result = await google.driveShareFile(args, transport, BASE);

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
    const result = await google.driveUploadFile(args, transport, BASE);

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
        BASE,
      ),
    ).rejects.toThrow(/404/);
    await expect(
      google.driveShareFile(
        { fileId: "f", role: "reader", type: "anyone" },
        transport,
        BASE,
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
      google.driveUploadFile({ name: "x", content: "y" }, transport, BASE),
    ).rejects.toThrow(/502/);
  });
});

describe("google.gmail", () => {
  it("sendEmail POSTs methods/sendEmail on x-sapiom-api-key with a normalized-array body, returns { id, threadId }", async () => {
    const sent = { id: "msg-1", threadId: "thread-1" };
    const { transport, calls } = makeTransport([() => jsonResponse(sent)]);

    const result = await google.gmailSendEmail(
      { to: "a@b.com", cc: ["c@d.com", "e@f.com"], subject: "Hello", text: "Hi" },
      transport,
      BASE,
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
      BASE,
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
      google.gmailSendEmail(
        { to: "a@b.com", subject: "x" },
        transport,
        BASE,
      ),
    ).rejects.toThrow(/404/);
    await expect(
      google.gmailSendEmail(
        { to: "a@b.com", subject: "x" },
        transport,
        BASE,
      ),
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
      google.gmailSendEmail({ to: "a@b.com", subject: "x" }, transport, BASE),
    ).rejects.toThrow(/502/);
  });
});
