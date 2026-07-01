import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as domains from "./index.js";
import { DomainsHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport wired to a
// scripted fetch mock (so URL/method/header/body assertions are exact, and we
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

// Sample wire shapes (the service returns camelCase; DNS records carry `id`).
const rawDomain = {
  domainName: "my-app.dev",
  status: "active",
  expiresAt: "2027-01-01T00:00:00Z",
  registeredAt: "2026-01-01T00:00:00Z",
  purchasePrice: "12.99",
  renewalPrice: "14.99",
  nameservers: ["ns1.example.com", "ns2.example.com"],
  locked: true,
  premium: false,
  tld: "dev",
  transferEligibleAt: null,
};

const rawDnsRecord = {
  id: "rec-uuid-123",
  domainName: "my-app.dev",
  type: "A",
  host: "",
  fqdn: "my-app.dev",
  value: "203.0.113.10",
  ttl: 3600,
  priority: undefined,
  createdAt: "2026-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

describe("domains.check()", () => {
  it("POSTs /v1/domains/check with the names + credential and unwraps results", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          results: [
            {
              domainName: "my-app.dev",
              available: true,
              purchasePrice: "12.99",
              renewalPrice: "14.99",
              premium: false,
            },
            { domainName: "taken.com", available: false },
          ],
        }),
    ]);

    const result = await domains.check(
      { domainNames: ["my-app.dev", "taken.com"] },
      transport,
      BASE,
    );

    expect(result).toEqual([
      {
        domainName: "my-app.dev",
        available: true,
        purchasePrice: "12.99",
        renewalPrice: "14.99",
        premium: false,
      },
      { domainName: "taken.com", available: false },
    ]);
    // second result has no wire pricing → those keys are absent, not undefined.
    expect(result[1]).not.toHaveProperty("purchasePrice");
    expect(result[1]).not.toHaveProperty("premium");

    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/check`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(bodyOf(calls[0]!)).toEqual({
      domainNames: ["my-app.dev", "taken.com"],
    });
  });

  it("throws a clean error (not a TypeError) when domainNames is missing", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);
    await expect(
      domains.check({} as unknown as domains.CheckInput, transport, BASE),
    ).rejects.toBeInstanceOf(DomainsHttpError);
    // guard fires before any request is made.
    expect(calls).toHaveLength(0);
  });

  it("throws a clean error when domainNames is empty", async () => {
    const { transport } = makeTransport([() => jsonResponse({})]);
    await expect(
      domains.check({ domainNames: [] }, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response(JSON.stringify({ message: "bad" }), { status: 422 }),
    ]);
    await expect(
      domains.check({ domainNames: ["x.com"] }, transport, BASE),
    ).rejects.toMatchObject({ status: 422, body: { message: "bad" } });
  });
});

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe("domains.register()", () => {
  it("POSTs /v1/domains with the name and maps the response (201)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            domainName: "my-app.dev",
            status: "active",
            expiresAt: "2027-01-01T00:00:00Z",
            registeredAt: "2026-01-01T00:00:00Z",
            purchasePrice: "12.99",
          },
          { status: 201 },
        ),
    ]);

    const result = await domains.register(
      { domainName: "my-app.dev" },
      transport,
      BASE,
    );

    expect(result).toEqual({
      domainName: "my-app.dev",
      status: "active",
      expiresAt: "2027-01-01T00:00:00Z",
      registeredAt: "2026-01-01T00:00:00Z",
      purchasePrice: "12.99",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({ domainName: "my-app.dev" });
  });

  it("throws a clean error (not a TypeError) when domainName is nullish", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);
    await expect(
      domains.register(
        { domainName: undefined } as unknown as domains.DomainNameInput,
        transport,
        BASE,
      ),
    ).rejects.toBeInstanceOf(DomainsHttpError);
    await expect(
      domains.register(
        undefined as unknown as domains.DomainNameInput,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx (e.g. already registered)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "already registered" }), {
          status: 409,
        }),
    ]);
    await expect(
      domains.register({ domainName: "taken.com" }, transport, BASE),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// renew()
// ---------------------------------------------------------------------------

describe("domains.renew()", () => {
  it("POSTs /v1/domains/:name/renew with an empty body and maps the response", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          domainName: "my-app.dev",
          expiresAt: "2028-01-01T00:00:00Z",
          renewalPrice: "14.99",
        }),
    ]);

    const result = await domains.renew(
      { domainName: "my-app.dev" },
      transport,
      BASE,
    );

    expect(result).toEqual({
      domainName: "my-app.dev",
      expiresAt: "2028-01-01T00:00:00Z",
      renewalPrice: "14.99",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/my-app.dev/renew`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("{}");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("throws DomainsHttpError on non-2xx (e.g. not owned)", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);
    await expect(
      domains.renew({ domainName: "nope.dev" }, transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("domains.list()", () => {
  it("GETs /v1/domains and maps each domain", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse([
          {
            domainName: "my-app.dev",
            status: "active",
            expiresAt: "2027-01-01T00:00:00Z",
            renewalPrice: "14.99",
            registeredAt: "2026-01-01T00:00:00Z",
          },
        ]),
    ]);

    const result = await domains.list(transport, BASE);

    expect(result).toEqual([
      {
        domainName: "my-app.dev",
        status: "active",
        expiresAt: "2027-01-01T00:00:00Z",
        renewalPrice: "14.99",
        registeredAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("drops a null renewalPrice from the mapped domain (no null leaks)", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse([
          {
            domainName: "my-app.dev",
            status: "active",
            expiresAt: "2027-01-01T00:00:00Z",
            renewalPrice: null,
            registeredAt: "2026-01-01T00:00:00Z",
          },
        ]),
    ]);
    const [domain] = await domains.list(transport, BASE);
    expect(domain).not.toHaveProperty("renewalPrice");
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("server error", { status: 500 }),
    ]);
    await expect(domains.list(transport, BASE)).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("domains.get()", () => {
  it("GETs /v1/domains/:name and maps the full domain (transferEligibleAt null preserved)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(rawDomain)]);

    const result = await domains.get(
      { domainName: "my-app.dev" },
      transport,
      BASE,
    );

    expect(result).toEqual({
      domainName: "my-app.dev",
      status: "active",
      expiresAt: "2027-01-01T00:00:00Z",
      registeredAt: "2026-01-01T00:00:00Z",
      purchasePrice: "12.99",
      renewalPrice: "14.99",
      nameservers: ["ns1.example.com", "ns2.example.com"],
      locked: true,
      premium: false,
      tld: "dev",
      transferEligibleAt: null,
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/my-app.dev`);
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("encodes special characters in the domain name (dots preserved)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(rawDomain)]);
    await domains.get({ domainName: "sub/weird .dev" }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/sub%2Fweird%20.dev`);
  });

  it("throws a clean error when domainName is nullish", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(rawDomain)]);
    await expect(
      domains.get(
        { domainName: "" } as domains.DomainNameInput,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);
    await expect(
      domains.get({ domainName: "nope.dev" }, transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// transferOut()
// ---------------------------------------------------------------------------

describe("domains.transferOut()", () => {
  it("DELETEs /v1/domains/:name and maps the auth code + instructions", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          domainName: "my-app.dev",
          authCode: "ABC-123",
          transferInstructions: "Use this code at the new registrar.",
        }),
    ]);

    const result = await domains.transferOut(
      { domainName: "my-app.dev" },
      transport,
      BASE,
    );

    expect(result).toEqual({
      domainName: "my-app.dev",
      authCode: "ABC-123",
      transferInstructions: "Use this code at the new registrar.",
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/my-app.dev`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("throws a clean error when domainName is nullish", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);
    await expect(
      domains.transferOut(
        { domainName: null } as unknown as domains.DomainNameInput,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx (e.g. transfer-locked)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "locked" }), { status: 409 }),
    ]);
    await expect(
      domains.transferOut({ domainName: "my-app.dev" }, transport, BASE),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// dns.create()
// ---------------------------------------------------------------------------

describe("domains.createDnsRecord()", () => {
  it("POSTs /v1/domains/:name/records with the record body and maps `id` → recordId", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }, { status: 201 }),
    ]);

    const result = await domains.createDnsRecord(
      {
        domainName: "my-app.dev",
        type: "A",
        host: "",
        value: "203.0.113.10",
        ttl: 3600,
      },
      transport,
      BASE,
    );

    expect(result).toMatchObject({
      recordId: "rec-uuid-123",
      domainName: "my-app.dev",
      type: "A",
      host: "",
      fqdn: "my-app.dev",
      value: "203.0.113.10",
      ttl: 3600,
      createdAt: "2026-01-01T00:00:00Z",
    });
    // wire `id` never leaks onto the public type.
    expect(result).not.toHaveProperty("id");
    // absent priority stays absent, not null/undefined.
    expect(result).not.toHaveProperty("priority");

    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/my-app.dev/records`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({
      type: "A",
      host: "",
      value: "203.0.113.10",
      ttl: 3600,
    });
  });

  it("omits ttl/priority from the body when not provided, and treats null as absent", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }, { status: 201 }),
    ]);

    await domains.createDnsRecord(
      {
        domainName: "my-app.dev",
        type: "CNAME",
        host: "www",
        value: "my-app.dev",
        ttl: null as unknown as number,
        priority: null as unknown as number,
      },
      transport,
      BASE,
    );

    const body = bodyOf(calls[0]!);
    expect(body).toEqual({ type: "CNAME", host: "www", value: "my-app.dev" });
    expect(body).not.toHaveProperty("ttl");
    expect(body).not.toHaveProperty("priority");
  });

  it("includes priority when provided (e.g. MX record)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            ...rawDnsRecord,
            type: "MX",
            value: "mail.example.com",
            priority: 10,
          },
          { status: 201 },
        ),
    ]);

    const result = await domains.createDnsRecord(
      {
        domainName: "my-app.dev",
        type: "MX",
        host: "",
        value: "mail.example.com",
        priority: 10,
      },
      transport,
      BASE,
    );

    expect(bodyOf(calls[0]!)).toEqual({
      type: "MX",
      host: "",
      value: "mail.example.com",
      priority: 10,
    });
    expect(result.priority).toBe(10);
  });

  it("throws a clean error when domainName is nullish", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);
    await expect(
      domains.createDnsRecord(
        {
          domainName: "",
          type: "A",
          host: "",
          value: "1.2.3.4",
        } as domains.CreateDnsRecordInput,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("bad", { status: 422 }),
    ]);
    await expect(
      domains.createDnsRecord(
        { domainName: "my-app.dev", type: "A", host: "", value: "x" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ---------------------------------------------------------------------------
// dns.list()
// ---------------------------------------------------------------------------

describe("domains.listDnsRecords()", () => {
  it("GETs /v1/domains/:name/records and maps each record (id → recordId)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse([{ ...rawDnsRecord, ttl: 300 }]),
    ]);

    const result = await domains.listDnsRecords(
      { domainName: "my-app.dev" },
      transport,
      BASE,
    );

    expect(result[0]!.recordId).toBe("rec-uuid-123");
    expect(result[0]).not.toHaveProperty("id");
    expect(result[0]!.ttl).toBe(300);
    expect(calls[0]!.url).toBe(`${BASE}/v1/domains/my-app.dev/records`);
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("nope", { status: 404 }),
    ]);
    await expect(
      domains.listDnsRecords({ domainName: "nope.dev" }, transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// dns.get()
// ---------------------------------------------------------------------------

describe("domains.getDnsRecord()", () => {
  it("GETs /v1/domains/:name/records/:id and maps the record", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }),
    ]);

    const result = await domains.getDnsRecord(
      { domainName: "my-app.dev", recordId: "rec-uuid-123" },
      transport,
      BASE,
    );

    expect(result.recordId).toBe("rec-uuid-123");
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/domains/my-app.dev/records/rec-uuid-123`,
    );
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("encodes both path params", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }),
    ]);
    await domains.getDnsRecord(
      { domainName: "a b.dev", recordId: "id/with slash" },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/domains/a%20b.dev/records/id%2Fwith%20slash`,
    );
  });

  it("throws a clean error when recordId is nullish (not a TypeError)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }),
    ]);
    await expect(
      domains.getDnsRecord(
        {
          domainName: "my-app.dev",
          recordId: null,
        } as unknown as domains.DnsRecordRef,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("nope", { status: 404 }),
    ]);
    await expect(
      domains.getDnsRecord(
        { domainName: "my-app.dev", recordId: "bad" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// dns.update()
// ---------------------------------------------------------------------------

describe("domains.updateDnsRecord()", () => {
  it("PUTs /v1/domains/:name/records/:id with only the changed fields", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord, value: "198.51.100.7" }),
    ]);

    const result = await domains.updateDnsRecord(
      {
        domainName: "my-app.dev",
        recordId: "rec-uuid-123",
        value: "198.51.100.7",
      },
      transport,
      BASE,
    );

    expect(result.value).toBe("198.51.100.7");
    expect(result.recordId).toBe("rec-uuid-123");
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/domains/my-app.dev/records/rec-uuid-123`,
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // partial update — only `value` is sent.
    expect(bodyOf(calls[0]!)).toEqual({ value: "198.51.100.7" });
  });

  it("treats null optional fields as absent (no null in the request body)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }),
    ]);

    await domains.updateDnsRecord(
      {
        domainName: "my-app.dev",
        recordId: "rec-uuid-123",
        type: undefined,
        host: undefined,
        value: undefined,
        ttl: null as unknown as number,
        priority: null as unknown as number,
      },
      transport,
      BASE,
    );

    expect(bodyOf(calls[0]!)).toEqual({});
  });

  it("throws a clean error when recordId is nullish", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ...rawDnsRecord }),
    ]);
    await expect(
      domains.updateDnsRecord(
        {
          domainName: "my-app.dev",
          recordId: "",
          value: "x",
        } as domains.UpdateDnsRecordInput,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("bad", { status: 422 }),
    ]);
    await expect(
      domains.updateDnsRecord(
        { domainName: "my-app.dev", recordId: "rec", value: "x" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ---------------------------------------------------------------------------
// dns.delete()
// ---------------------------------------------------------------------------

describe("domains.deleteDnsRecord()", () => {
  it("DELETEs /v1/domains/:name/records/:id and resolves void", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ deleted: true }),
    ]);

    const result = await domains.deleteDnsRecord(
      { domainName: "my-app.dev", recordId: "rec-uuid-123" },
      transport,
      BASE,
    );

    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/domains/my-app.dev/records/rec-uuid-123`,
    );
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("throws a clean error when recordId is nullish", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ deleted: true }),
    ]);
    await expect(
      domains.deleteDnsRecord(
        {
          domainName: "my-app.dev",
          recordId: undefined,
        } as unknown as domains.DnsRecordRef,
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws DomainsHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("nope", { status: 404 }),
    ]);
    await expect(
      domains.deleteDnsRecord(
        { domainName: "my-app.dev", recordId: "bad" },
        transport,
        BASE,
      ),
    ).rejects.toBeInstanceOf(DomainsHttpError);
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("domains — client wiring + credential", () => {
  it("createClient().domains routes all 11 methods with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "DELETE") {
        // transferOut returns a transfer body; dns.delete returns { deleted }.
        return url.includes("/records/")
          ? jsonResponse({ deleted: true })
          : jsonResponse({ domainName: "d", authCode: "x" });
      }
      if (url.endsWith("/domains/check")) {
        return jsonResponse({ results: [] });
      }
      if (url.endsWith("/records")) {
        // dns.create (POST) or dns.list (GET)
        return method === "POST"
          ? jsonResponse({ ...rawDnsRecord }, { status: 201 })
          : jsonResponse([]);
      }
      if (url.includes("/records/")) {
        return jsonResponse({ ...rawDnsRecord });
      }
      if (url.endsWith("/domains") && method === "GET") {
        return jsonResponse([]); // list
      }
      // register (POST /domains), get (GET /domains/:name), renew (POST .../renew)
      return jsonResponse({ ...rawDomain }, { status: 201 });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.domains.check({ domainNames: ["a.dev"] });
    await sapiom.domains.register({ domainName: "a.dev" });
    await sapiom.domains.renew({ domainName: "a.dev" });
    await sapiom.domains.list();
    await sapiom.domains.get({ domainName: "a.dev" });
    await sapiom.domains.transferOut({ domainName: "a.dev" });
    await sapiom.domains.dns.create({
      domainName: "a.dev",
      type: "A",
      host: "",
      value: "1.2.3.4",
    });
    await sapiom.domains.dns.list({ domainName: "a.dev" });
    await sapiom.domains.dns.get({ domainName: "a.dev", recordId: "r" });
    await sapiom.domains.dns.update({
      domainName: "a.dev",
      recordId: "r",
      value: "5.6.7.8",
    });
    await sapiom.domains.dns.delete({ domainName: "a.dev", recordId: "r" });

    expect(calls).toHaveLength(11);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("[]")) as typeof globalThis.fetch,
      });
      await expect(domains.list(transport, BASE)).rejects.toThrow(
        /no tenant credential/i,
      );
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// DomainsHttpError
// ---------------------------------------------------------------------------

describe("DomainsHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new DomainsHttpError("something went wrong", 402, {
      message: "payment required",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DomainsHttpError);
    expect(err.status).toBe(402);
    expect(err.body).toEqual({ message: "payment required" });
    expect(err.name).toBe("DomainsHttpError");
  });
});
