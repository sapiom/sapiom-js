import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as email from "./index.js";
import { EmailHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly against a real Transport backed by
// a scripted fetch mock (so URL/method/header/body assertions are exact, and we
// verify the Transport itself injects the tenant credential).
// ---------------------------------------------------------------------------

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
  apiKey: string | undefined = "test-key",
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

const BASE = "https://api.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];
const bodyOf = (c: FetchCall) => JSON.parse(c.init.body as string);

// Shared response fixtures (the service surface is camelCase both directions).
const RAW_INBOX = {
  inboxId: "support@acme.com",
  email: "support@acme.com",
  displayName: "Acme Support",
  clientId: "idem-1",
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-02T00:00:00Z",
};

const RAW_MESSAGE = {
  messageId: "m-1",
  threadId: "t-1",
  inboxId: "support@acme.com",
  from: "customer@example.com",
  to: ["support@acme.com"],
  cc: ["cc@example.com"],
  replyTo: ["reply@example.com"],
  subject: "Help",
  preview: "hi there",
  text: "hi there, full body",
  html: "<p>hi there</p>",
  extractedText: "hi there",
  extractedHtml: "<p>hi there</p>",
  labels: ["inbox"],
  timestamp: "2026-06-03T00:00:00Z",
  inReplyTo: "m-0",
  references: ["m-0"],
  headers: { "X-Custom": "1" },
  attachments: [
    {
      attachmentId: "a-1",
      filename: "f.pdf",
      contentType: "application/pdf",
      size: 10,
    },
  ],
  size: 100,
  createdAt: "2026-06-03T00:00:00Z",
  updatedAt: "2026-06-03T00:00:00Z",
};

const RAW_THREAD = {
  threadId: "t-1",
  inboxId: "support@acme.com",
  labels: ["inbox"],
  timestamp: "2026-06-03T00:00:00Z",
  receivedTimestamp: "2026-06-03T00:00:00Z",
  sentTimestamp: "2026-06-03T00:01:00Z",
  subject: "Help",
  preview: "hi there",
  senders: ["customer@example.com"],
  recipients: ["support@acme.com"],
  lastMessageId: "m-1",
  messageCount: 1,
  size: 100,
  attachments: [
    {
      attachmentId: "a-1",
      filename: "f.pdf",
      contentType: "application/pdf",
      size: 10,
    },
  ],
  createdAt: "2026-06-03T00:00:00Z",
  updatedAt: "2026-06-03T00:00:00Z",
  messages: [RAW_MESSAGE],
};

const RAW_DOMAIN = {
  domainId: "d-1",
  domain: "mail.acme.com",
  status: "PENDING",
  feedbackEnabled: false,
  records: [
    { type: "TXT", name: "_x.mail.acme.com", value: "v=1", status: "MISSING" },
    {
      type: "MX",
      name: "mail.acme.com",
      value: "mx.host",
      status: "MISSING",
      priority: 10,
    },
  ],
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

// ===========================================================================
// inboxes
// ===========================================================================

describe("email.inboxes", () => {
  it("create() POSTs /v1/inboxes with camelCase body + credential and maps the response", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_INBOX, { status: 201 }),
    ]);

    const result = await email.createInbox(
      {
        username: "support",
        domain: "acme.com",
        displayName: "Acme Support",
        clientId: "idem-1",
      },
      transport,
      BASE,
    );

    expect(result).toEqual({
      inboxId: "support@acme.com",
      email: "support@acme.com",
      displayName: "Acme Support",
      clientId: "idem-1",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-02T00:00:00Z",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/inboxes`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(bodyOf(calls[0]!)).toEqual({
      username: "support",
      domain: "acme.com",
      displayName: "Acme Support",
      clientId: "idem-1",
    });
  });

  it("create() sends an empty body and omits absent optionals when called with no input", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          { ...RAW_INBOX, displayName: undefined, clientId: undefined },
          { status: 201 },
        ),
    ]);
    const result = await email.createInbox(undefined, transport, BASE);
    expect(bodyOf(calls[0]!)).toEqual({});
    expect(result).not.toHaveProperty("displayName");
    expect(result).not.toHaveProperty("clientId");
  });

  it("create() treats a null optional as absent (not TypeError, not a null in the body)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_INBOX, { status: 201 }),
    ]);
    // JS callers bypass the TS types — a null must be dropped, not forwarded.
    await email.createInbox(
      { username: "support", displayName: null as unknown as string },
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({ username: "support" });
  });

  it("list() GETs /v1/inboxes with pagination params and maps items", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          count: 1,
          nextPageToken: "next",
          inboxes: [RAW_INBOX],
        }),
    ]);

    const result = await email.listInboxes(
      { limit: 20, pageToken: "cur" },
      transport,
      BASE,
    );

    expect(result.count).toBe(1);
    expect(result.nextPageToken).toBe("next");
    expect(result.inboxes[0]!.inboxId).toBe("support@acme.com");
    expect(calls[0]!.url).toBe(`${BASE}/v1/inboxes?limit=20&pageToken=cur`);
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("list() omits pagination params when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ count: 0, inboxes: [] }),
    ]);
    const result = await email.listInboxes(undefined, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/inboxes`);
    expect(result).not.toHaveProperty("nextPageToken");
  });

  it("get() encodes the inbox address (with @) in the path", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(RAW_INBOX)]);
    await email.getInbox("support@acme.com", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/inboxes/support%40acme.com`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
  });

  it("delete() DELETEs /v1/inboxes/:id and resolves void", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    const result = await email.deleteInbox("support@acme.com", transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/inboxes/support%40acme.com`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("delete() throws a clean EmailHttpError (400) on a nullish id before any request", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      email.deleteInbox(undefined as unknown as string, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("get() throws a clean EmailHttpError (400) on a nullish id — not a TypeError", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(RAW_INBOX)]);
    await expect(
      email.getInbox(undefined as unknown as string, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    // The guard fires before any network call.
    expect(calls).toHaveLength(0);
  });

  it("get() throws EmailHttpError with status + body on non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    ]);
    const err = await email
      .getInbox("missing@acme.com", transport, BASE)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailHttpError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ message: "not found" });
  });
});

// ===========================================================================
// messages
// ===========================================================================

describe("email.messages", () => {
  it("send() POSTs to /messages with the recipient body and returns the send result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-9", threadId: "t-9" }, { status: 201 }),
    ]);

    const result = await email.sendMessage(
      "support@acme.com",
      {
        to: ["a@example.com", "b@example.com"],
        cc: "c@example.com",
        subject: "Hi",
        text: "body",
        headers: { "X-Trace": "abc" },
        labels: ["outbound"],
      },
      transport,
      BASE,
    );

    expect(result).toEqual({ messageId: "m-9", threadId: "t-9" });
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({
      to: ["a@example.com", "b@example.com"],
      cc: "c@example.com",
      subject: "Hi",
      text: "body",
      headers: { "X-Trace": "abc" },
      labels: ["outbound"],
    });
  });

  it("send() drops null optionals from the body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-1", threadId: "t-1" }, { status: 201 }),
    ]);
    await email.sendMessage(
      "support@acme.com",
      {
        to: "a@example.com",
        cc: null as unknown as string,
        subject: undefined,
      },
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({ to: "a@example.com" });
  });

  it("list() GETs /messages and maps items to metadata (no body / extracted / replyTo)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ count: 1, nextPageToken: "n", messages: [RAW_MESSAGE] }),
    ]);

    const result = await email.listMessages(
      "support@acme.com",
      { limit: 5 },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages?limit=5`,
    );
    expect(result.count).toBe(1);
    expect(result.nextPageToken).toBe("n");
    const item = result.messages[0]!;
    expect(item.messageId).toBe("m-1");
    // list items are metadata-only
    expect(item).not.toHaveProperty("text");
    expect(item).not.toHaveProperty("html");
    expect(item).not.toHaveProperty("extractedText");
    expect(item).not.toHaveProperty("extractedHtml");
    expect(item).not.toHaveProperty("replyTo");
    // but keep other metadata incl. attachment metadata
    expect(item.attachments?.[0]!.attachmentId).toBe("a-1");
  });

  it("get() returns the full message including body + extracted content", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_MESSAGE),
    ]);
    const result = await email.getMessage(
      "support@acme.com",
      "m-1",
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages/m-1`,
    );
    expect(result.text).toBe("hi there, full body");
    expect(result.extractedText).toBe("hi there");
    expect(result.replyTo).toEqual(["reply@example.com"]);
    expect(result.attachments?.[0]!.filename).toBe("f.pdf");
  });

  it("reply() POSTs to /messages/:id/reply", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-2", threadId: "t-1" }, { status: 201 }),
    ]);
    const result = await email.replyMessage(
      "support@acme.com",
      "m-1",
      { text: "thanks", replyAll: true },
      transport,
      BASE,
    );
    expect(result).toEqual({ messageId: "m-2", threadId: "t-1" });
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages/m-1/reply`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({ text: "thanks", replyAll: true });
  });

  it("reply() sends an empty body when called with no input", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-2", threadId: "t-1" }, { status: 201 }),
    ]);
    await email.replyMessage(
      "support@acme.com",
      "m-1",
      undefined,
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({});
  });

  it("replyAll() POSTs to /messages/:id/reply-all", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-3", threadId: "t-1" }, { status: 201 }),
    ]);
    await email.replyAllMessage(
      "support@acme.com",
      "m-1",
      { text: "all" },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages/m-1/reply-all`,
    );
    expect(bodyOf(calls[0]!)).toEqual({ text: "all" });
  });

  it("forward() POSTs to /messages/:id/forward with a required recipient", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ messageId: "m-4", threadId: "t-2" }, { status: 201 }),
    ]);
    await email.forwardMessage(
      "support@acme.com",
      "m-1",
      { to: "fwd@example.com", text: "fyi" },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/messages/m-1/forward`,
    );
    expect(bodyOf(calls[0]!)).toEqual({ to: "fwd@example.com", text: "fyi" });
  });

  it("get() guards a nullish messageId with a clean 400 before any request", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_MESSAGE),
    ]);
    await expect(
      email.getMessage("support@acme.com", "" as string, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("send() throws EmailHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("rejected", { status: 422 }),
    ]);
    await expect(
      email.sendMessage(
        "support@acme.com",
        { to: "a@example.com" },
        transport,
        BASE,
      ),
    ).rejects.toBeInstanceOf(EmailHttpError);
  });
});

// ===========================================================================
// threads
// ===========================================================================

describe("email.threads", () => {
  it("list() GETs /threads and maps items without the messages array", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          count: 1,
          nextPageToken: "n",
          threads: [{ ...RAW_THREAD, messages: undefined }],
        }),
    ]);

    const result = await email.listThreads(
      "support@acme.com",
      { limit: 10 },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/threads?limit=10`,
    );
    expect(result.count).toBe(1);
    const item = result.threads[0]!;
    expect(item.threadId).toBe("t-1");
    expect(item).not.toHaveProperty("messages");
    expect(item.receivedTimestamp).toBe("2026-06-03T00:00:00Z");
    expect(item.attachments?.[0]!.attachmentId).toBe("a-1");
  });

  it("get() returns the full thread including its messages", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_THREAD),
    ]);
    const result = await email.getThread(
      "support@acme.com",
      "t-1",
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/inboxes/support%40acme.com/threads/t-1`,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.messageId).toBe("m-1");
  });

  it("get() throws EmailHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("nope", { status: 404 }),
    ]);
    await expect(
      email.getThread("support@acme.com", "t-x", transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ===========================================================================
// domains
// ===========================================================================

describe("email.domains", () => {
  it("create() POSTs /v1/domains and maps records (incl. MX priority)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_DOMAIN, { status: 201 }),
    ]);

    const result = await email.createDomain(
      { domain: "mail.acme.com", feedbackEnabled: true },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/domains`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({
      domain: "mail.acme.com",
      feedbackEnabled: true,
    });
    expect(result.status).toBe("PENDING");
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual({
      type: "TXT",
      name: "_x.mail.acme.com",
      value: "v=1",
      status: "MISSING",
    });
    expect(result.records[1]!.priority).toBe(10);
  });

  it("create() guards a nullish domain with a clean 400", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_DOMAIN, { status: 201 }),
    ]);
    await expect(
      email.createDomain(
        { domain: undefined as unknown as string },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("verify() POSTs /v1/domains/:id/verify and resolves void", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    const result = await email.verifyDomain("d-1", transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/d-1/verify`);
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("verify() (a void/204 op) throws EmailHttpError with status + body on non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    ]);
    const err = await email
      .verifyDomain("d-x", transport, BASE)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailHttpError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ message: "not found" });
  });

  it("get() GETs /v1/domains/:id", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(RAW_DOMAIN),
    ]);
    await email.getDomain("d-1", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/d-1`);
  });

  it("list() GETs /v1/domains and maps summary items (no status/records)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          count: 1,
          domains: [
            {
              domainId: "d-1",
              domain: "mail.acme.com",
              feedbackEnabled: false,
              createdAt: "2026-06-01T00:00:00Z",
              updatedAt: "2026-06-01T00:00:00Z",
            },
          ],
        }),
    ]);
    const result = await email.listDomains(transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains`);
    expect(result.count).toBe(1);
    expect(result.domains[0]!.domainId).toBe("d-1");
    expect(result.domains[0]).not.toHaveProperty("status");
    expect(result.domains[0]).not.toHaveProperty("records");
  });

  it("delete() DELETEs /v1/domains/:id", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await email.deleteDomain("d-1", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/d-1`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("delete() throws a clean EmailHttpError (400) on a nullish id before any request", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      email.deleteDomain(undefined as unknown as string, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
// webhooks
// ===========================================================================

describe("email.webhooks", () => {
  it("create() POSTs /v1/webhooks and returns id + secret", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: 7,
            url: "https://hook.acme.com/inbound",
            eventType: "message.received",
            secret: "sh-1",
          },
          { status: 201 },
        ),
    ]);

    const result = await email.createWebhook(
      { url: "https://hook.acme.com/inbound", eventType: "message.received" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/webhooks`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({
      url: "https://hook.acme.com/inbound",
      eventType: "message.received",
    });
    expect(result).toEqual({
      id: 7,
      url: "https://hook.acme.com/inbound",
      eventType: "message.received",
      secret: "sh-1",
    });
  });

  it("create() guards a nullish url/eventType with a clean 400", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({}, { status: 201 }),
    ]);
    await expect(
      email.createWebhook(
        { url: "", eventType: "message.received" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      email.createWebhook(
        {
          url: "https://hook.acme.com",
          eventType: undefined as unknown as string,
        },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("delete() DELETEs /v1/webhooks/:id (numeric)", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    const result = await email.deleteWebhook(7, transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/webhooks/7`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("delete() guards a non-number id with a clean 400", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      email.deleteWebhook(undefined as unknown as number, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

// ===========================================================================
// Client wiring + auth
// ===========================================================================

describe("email — client wiring + credential", () => {
  it("createClient().email routes every operation with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/verify")) return new Response(null, { status: 204 });
      if (url.endsWith("/messages") && method === "POST")
        return jsonResponse({ messageId: "m", threadId: "t" }, { status: 201 });
      if (url.includes("/messages/") && method === "POST")
        return jsonResponse({ messageId: "m", threadId: "t" }, { status: 201 });
      if (url.includes("/messages/")) return jsonResponse(RAW_MESSAGE);
      if (url.endsWith("/messages"))
        return jsonResponse({ count: 0, messages: [] });
      if (url.includes("/threads/")) return jsonResponse(RAW_THREAD);
      if (url.endsWith("/threads"))
        return jsonResponse({ count: 0, threads: [] });
      if (url.endsWith("/webhooks"))
        return jsonResponse(
          { id: 1, url: "https://h", eventType: "*", secret: "s" },
          { status: 201 },
        );
      if (url.endsWith("/domains"))
        return method === "POST"
          ? jsonResponse(RAW_DOMAIN, { status: 201 })
          : jsonResponse({ count: 0, domains: [] });
      if (url.includes("/domains/")) return jsonResponse(RAW_DOMAIN);
      if (url.endsWith("/inboxes"))
        return method === "POST"
          ? jsonResponse(RAW_INBOX, { status: 201 })
          : jsonResponse({ count: 0, inboxes: [] });
      if (url.includes("/inboxes/")) return jsonResponse(RAW_INBOX);
      return jsonResponse({});
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });

    await sapiom.email.inboxes.create({ username: "s" });
    await sapiom.email.inboxes.list();
    await sapiom.email.inboxes.get("s@acme.com");
    await sapiom.email.inboxes.delete("s@acme.com");
    await sapiom.email.messages.send("s@acme.com", { to: "a@example.com" });
    await sapiom.email.messages.list("s@acme.com");
    await sapiom.email.messages.get("s@acme.com", "m-1");
    await sapiom.email.messages.reply("s@acme.com", "m-1", { text: "x" });
    await sapiom.email.messages.replyAll("s@acme.com", "m-1", { text: "x" });
    await sapiom.email.messages.forward("s@acme.com", "m-1", {
      to: "b@example.com",
    });
    await sapiom.email.threads.list("s@acme.com");
    await sapiom.email.threads.get("s@acme.com", "t-1");
    await sapiom.email.domains.create({ domain: "mail.acme.com" });
    await sapiom.email.domains.verify("d-1");
    await sapiom.email.domains.get("d-1");
    await sapiom.email.domains.list();
    await sapiom.email.domains.delete("d-1");
    await sapiom.email.webhooks.create({ url: "https://h", eventType: "*" });
    await sapiom.email.webhooks.delete(1);

    expect(calls).toHaveLength(19);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(
        email.listInboxes(undefined, transport, BASE),
      ).rejects.toThrow(/no tenant credential/i);
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ===========================================================================
// EmailHttpError
// ===========================================================================

describe("EmailHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new EmailHttpError("boom", 422, { message: "invalid" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EmailHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ message: "invalid" });
    expect(err.name).toBe("EmailHttpError");
  });
});
