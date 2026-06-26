import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as database from "./index.js";
import { DatabaseHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport plus a
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

const CONNECTION_URI =
  "postgresql://db_user:s3cr3t@db.example.com:5433/appdb?sslmode=require";

const rawDatabase = (overrides: Record<string, unknown> = {}) => ({
  id: "db_abc123",
  handle: "analytics",
  name: "Analytics",
  description: "events",
  status: "active",
  region: "us-east-1",
  pgVersion: 17,
  duration: "1h",
  connectionUri: CONNECTION_URI,
  expiresAt: "2026-06-25T13:00:00Z",
  createdAt: "2026-06-25T12:00:00Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("database.create()", () => {
  it("POSTs /v1/databases with JSON body + credential and parses the connection URI", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase(), { status: 201 }),
    ]);

    const db = await database.create(
      {
        duration: "1h",
        handle: "analytics",
        name: "Analytics",
        description: "events",
        region: "us-east-1",
        pgVersion: 17,
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/databases`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      duration: "1h",
      handle: "analytics",
      name: "Analytics",
      description: "events",
      region: "us-east-1",
      pgVersion: 17,
    });

    // Top-level fields copied 1:1; the connection URI is parsed into components.
    expect(db).toEqual({
      id: "db_abc123",
      handle: "analytics",
      name: "Analytics",
      description: "events",
      status: "active",
      region: "us-east-1",
      pgVersion: 17,
      duration: "1h",
      connection: {
        connectionString: CONNECTION_URI,
        host: "db.example.com",
        port: 5433,
        username: "db_user",
        password: "s3cr3t",
        databaseName: "appdb",
        sslmode: "require",
      },
      expiresAt: "2026-06-25T13:00:00Z",
      createdAt: "2026-06-25T12:00:00Z",
    });
  });

  it("omits undefined optional fields from the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase({ handle: null }), { status: 201 }),
    ]);

    await database.create({ duration: "15m" }, transport, BASE);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ duration: "15m" });
    expect(body).not.toHaveProperty("handle");
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("region");
    expect(body).not.toHaveProperty("pgVersion");
  });

  it("defaults a missing port to 5432", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          rawDatabase({
            connectionUri: "postgresql://u:p@host.example.com/appdb",
          }),
          { status: 201 },
        ),
    ]);

    const db = await database.create({ duration: "1h" }, transport, BASE);
    expect(db.connection?.port).toBe(5432);
    expect(db.connection?.sslmode).toBeUndefined();
  });

  it("decodes URL-encoded credentials in the connection URI", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          rawDatabase({
            connectionUri:
              "postgresql://us%40r:p%40ss%2Fword@host.example.com:5432/appdb",
          }),
          { status: 201 },
        ),
    ]);

    const db = await database.create({ duration: "1h" }, transport, BASE);
    expect(db.connection?.username).toBe("us@r");
    expect(db.connection?.password).toBe("p@ss/word");
  });

  it("maps a null connectionUri to connection: null (still provisioning)", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          rawDatabase({ status: "provisioning", connectionUri: null }),
          {
            status: 201,
          },
        ),
    ]);

    const db = await database.create({ duration: "1h" }, transport, BASE);
    expect(db.status).toBe("provisioning");
    expect(db.connection).toBeNull();
  });

  it("preserves connectionString even when the URI is malformed", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(rawDatabase({ connectionUri: "not-a-valid-uri" }), {
          status: 201,
        }),
    ]);

    const db = await database.create({ duration: "1h" }, transport, BASE);
    expect(db.connection?.connectionString).toBe("not-a-valid-uri");
    expect(db.connection?.host).toBeUndefined();
  });

  it("throws a clean error (before any fetch) when duration is missing", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      database.create(
        { duration: undefined as unknown as "1h" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "DatabaseHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws DatabaseHttpError (with status + body) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "duplicate handle" }), {
          status: 409,
        }),
    ]);

    await expect(
      database.create({ duration: "1h", handle: "taken" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "DatabaseHttpError",
      status: 409,
      body: { message: "duplicate handle" },
    });
    await expect(
      database.create({ duration: "1h" }, transport, BASE),
    ).rejects.toBeInstanceOf(DatabaseHttpError);
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("database.get()", () => {
  it("GETs /v1/databases/:idOrHandle and maps the response", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase()),
    ]);

    const db = await database.get("db_abc123", transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/v1/databases/db_abc123`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(db.id).toBe("db_abc123");
    expect(db.connection?.host).toBe("db.example.com");
  });

  it("URL-encodes the idOrHandle path segment", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase()),
    ]);

    await database.get("weird id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/databases/weird%20id%2Fwith%20slash`,
    );
  });

  it("throws DatabaseHttpError on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(
      database.get("missing", transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("database.delete()", () => {
  it("DELETEs /v1/databases/:idOrHandle and resolves void on 204", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    const result = await database.delete("db_abc123", transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/databases/db_abc123`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("URL-encodes the idOrHandle path segment", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await database.delete("weird id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/databases/weird%20id%2Fwith%20slash`,
    );
  });

  it("throws DatabaseHttpError on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(
      database.delete("missing", transport, BASE),
    ).rejects.toBeInstanceOf(DatabaseHttpError);
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("database — client wiring + credential", () => {
  it("createClient().database routes create/get/delete with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(rawDatabase(), {
        status: method === "POST" ? 201 : 200,
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.database.create({ duration: "1h" });
    await sapiom.database.get("db_abc123");
    await sapiom.database.delete("db_abc123");

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    expect(calls[0]!.url).toBe("https://neon.services.sapiom.ai/v1/databases");
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(database.get("db_abc123", transport, BASE)).rejects.toThrow(
        /no tenant credential/i,
      );
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// DatabaseHttpError
// ---------------------------------------------------------------------------

describe("DatabaseHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new DatabaseHttpError("something went wrong", 422, {
      message: "invalid",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ message: "invalid" });
    expect(err.name).toBe("DatabaseHttpError");
  });
});
