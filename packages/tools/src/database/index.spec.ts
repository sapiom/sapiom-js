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

// The gateway's current response shape: a Sapiom Postgres is permanent
// (SAP-3100), so there is no `duration` tier and no `expiresAt`.
const rawDatabase = (overrides: Record<string, unknown> = {}) => ({
  id: "db_abc123",
  handle: "analytics",
  name: "Analytics",
  description: "events",
  status: "active",
  region: "us-east-1",
  pgVersion: 17,
  connectionUri: CONNECTION_URI,
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
      handle: "analytics",
      name: "Analytics",
      description: "events",
      region: "us-east-1",
      pgVersion: 17,
    });

    // Top-level fields copied 1:1; the connection URI is parsed into components.
    // No `duration` and no `expiresAt`: a new database has no lifetime.
    expect(db).toEqual({
      id: "db_abc123",
      handle: "analytics",
      name: "Analytics",
      description: "events",
      status: "active",
      region: "us-east-1",
      pgVersion: 17,
      connection: {
        connectionString: CONNECTION_URI,
        host: "db.example.com",
        port: 5433,
        username: "db_user",
        password: "s3cr3t",
        databaseName: "appdb",
        sslmode: "require",
      },
      createdAt: "2026-06-25T12:00:00Z",
    });
    expect(db).not.toHaveProperty("duration");
    expect(db).not.toHaveProperty("expiresAt");
  });

  it("creates without duration: `create({})` and `create()` both POST an empty body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase({ handle: null }), { status: 201 }),
    ]);

    const a = await database.create({}, transport, BASE);
    const b = await database.create(undefined, transport, BASE);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({});
    expect(a.id).toBe("db_abc123");
    expect(b.id).toBe("db_abc123");
  });

  it("omits undefined optional fields from the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase({ handle: null }), { status: 201 }),
    ]);

    await database.create({ region: "us-east-1" }, transport, BASE);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ region: "us-east-1" });
    expect(body).not.toHaveProperty("handle");
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("pgVersion");
  });

  it("does not forward a legacy duration (the platform ignores it; SAP-3100)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawDatabase(), { status: 201 }),
    ]);

    // Callers written against the old contract keep working unchanged...
    const db = await database.create(
      { duration: "7d", handle: "analytics" },
      transport,
      BASE,
    );

    // ...but the lifetime never reaches the wire, and nothing else moves.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      handle: "analytics",
    });
    expect(db.handle).toBe("analytics");
    expect(db).not.toHaveProperty("expiresAt");
  });

  it("echoes legacy duration/expiresAt only when the gateway still returns them", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          rawDatabase({
            duration: "7d",
            expiresAt: "2026-03-04T00:00:00Z",
          }),
        ),
    ]);

    // A database created before SAP-3100 may still carry the tier it was sold
    // under; the mapper passes it through rather than inventing a value.
    const db = await database.get("db_abc123", transport, BASE);
    expect(db.duration).toBe("7d");
    expect(db.expiresAt).toBe("2026-03-04T00:00:00Z");
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

    const db = await database.create({}, transport, BASE);
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

    const db = await database.create({}, transport, BASE);
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

    const db = await database.create({}, transport, BASE);
    expect(db.status).toBe("provisioning");
    expect(db.connection).toBeNull();
  });

  it("preserves connectionString (canonical) and leaves components undefined when the URI is malformed", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(rawDatabase({ connectionUri: "not-a-valid-uri" }), {
          status: 201,
        }),
    ]);

    // Does not throw out of the mapper; connectionString is always preserved and
    // the best-effort component fields are simply absent.
    const db = await database.create({}, transport, BASE);
    expect(db.connection).toEqual({ connectionString: "not-a-valid-uri" });
    expect(db.connection?.connectionString).toBe("not-a-valid-uri");
    expect(db.connection?.host).toBeUndefined();
    expect(db.connection?.port).toBeUndefined();
    expect(db.connection?.username).toBeUndefined();
    expect(db.connection?.password).toBeUndefined();
    expect(db.connection?.databaseName).toBeUndefined();
    expect(db.connection?.sslmode).toBeUndefined();
  });

  it("throws DatabaseHttpError (with status + body) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "duplicate handle" }), {
          status: 409,
        }),
    ]);

    await expect(
      database.create({ handle: "taken" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "DatabaseHttpError",
      status: 409,
      body: { message: "duplicate handle" },
    });
    await expect(database.create({}, transport, BASE)).rejects.toBeInstanceOf(
      DatabaseHttpError,
    );
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
// list()
// ---------------------------------------------------------------------------

describe("database.list()", () => {
  it("GETs /v1/databases and maps each row", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse([
          rawDatabase(),
          rawDatabase({ id: "db_def456", handle: "reporting" }),
        ]),
    ]);

    const dbs = await database.list(transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/v1/databases`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(dbs).toHaveLength(2);
    expect(dbs[0]!.id).toBe("db_abc123");
    expect(dbs[0]!.connection?.host).toBe("db.example.com");
    expect(dbs[1]!.handle).toBe("reporting");
  });

  it("returns [] for an empty list", async () => {
    const { transport } = makeTransport([() => jsonResponse([])]);
    await expect(database.list(transport, BASE)).resolves.toEqual([]);
  });

  it("tolerates a non-array body by returning []", async () => {
    const { transport } = makeTransport([() => jsonResponse({})]);
    await expect(database.list(transport, BASE)).resolves.toEqual([]);
  });

  it("throws DatabaseHttpError on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("boom", { status: 500 }),
    ]);

    await expect(database.list(transport, BASE)).rejects.toBeInstanceOf(
      DatabaseHttpError,
    );
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
    await sapiom.database.create({});
    await sapiom.database.get("db_abc123");
    await sapiom.database.list();
    await sapiom.database.delete("db_abc123");

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    expect(calls[0]!.url).toBe("https://neon.services.sapiom.ai/v1/databases");
    expect(calls[2]!.url).toBe("https://neon.services.sapiom.ai/v1/databases");
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
