/**
 * `database` capability — provision an on-demand Postgres database, retrieve it,
 * and delete it. You get back direct connection credentials, so you can connect
 * with any standard Postgres client or driver.
 *
 *   import { database } from "@sapiom/tools";              // ambient auth
 *   const db = await database.create({ duration: "1h", handle: "analytics" });
 *   db.connection?.connectionString;                      // a ready-to-use Postgres URI
 *
 *   const again = await database.get(db.id);              // or get("analytics") by handle
 *   await database.delete(db.id);                         // or delete("analytics")
 *
 * Or via an explicit client: `createClient({ apiKey }).database.create(...)`.
 *
 * This is a provisioning surface, not a query layer: it hands you connection
 * credentials and you run your own SQL with the client of your choice.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, DatabaseHttpError } from "./errors.js";

export { DatabaseHttpError };

const DEFAULT_BASE_URL =
  process.env.SAPIOM_DATABASE_URL || "https://neon.services.sapiom.ai";

// ----- Types -----

/** How long the database lives before it is automatically removed. */
export type DatabaseDuration = "15m" | "1h" | "4h" | "24h" | "7d";

/** Lifecycle state of a database. */
export type DatabaseStatus =
  | "provisioning"
  | "active"
  | "expired"
  | "deleting"
  | "deleted";

export interface CreateDatabaseInput {
  /** How long the database lives before it is automatically removed (required). */
  duration: DatabaseDuration;
  /**
   * Optional stable, human-friendly key you can use to look the database up later
   * (`get(handle)` / `delete(handle)`). 3–63 chars, `^[a-z0-9][a-z0-9-]*[a-z0-9]$`.
   * Unique within your tenant.
   */
  handle?: string;
  /** Optional display name. */
  name?: string;
  /** Optional description (up to 500 chars). */
  description?: string;
  /** Optional region to provision in. Defaults to a US region. */
  region?: string;
  /** Optional Postgres major version. Defaults to the latest supported. */
  pgVersion?: 15 | 16 | 17;
}

export interface DatabaseConnection {
  /**
   * The full Postgres connection URI — pass this to any Postgres client. This is
   * the canonical value and is always present; the component fields below are
   * parsed from it on a best-effort basis and may be absent if it can't be parsed.
   */
  connectionString: string;
  /** Database host. */
  host?: string;
  /** Database port. */
  port?: number;
  /** Database user. */
  username?: string;
  /** Database password. */
  password?: string;
  /** Name of the database to connect to. */
  databaseName?: string;
  /** SSL mode from the connection URI, when present (e.g. "require"). */
  sslmode?: string;
}

export interface Database {
  /** Unique database identifier. */
  id: string;
  /** The handle you set at creation, or `null` if none was given. */
  handle: string | null;
  /** Display name, or `null`. */
  name: string | null;
  /** Description, or `null`. */
  description: string | null;
  /** Lifecycle state. */
  status: DatabaseStatus;
  /** Region the database is provisioned in. */
  region: string;
  /** Postgres major version. */
  pgVersion: number;
  /** The lifetime the database was created with. */
  duration: DatabaseDuration | string;
  /** Connection credentials — `null` while the database is still being provisioned. */
  connection: DatabaseConnection | null;
  /** ISO-8601 timestamp when the database expires, or `null`. */
  expiresAt: string | null;
  /** ISO-8601 timestamp when the database was created. */
  createdAt: string;
}

// ----- Internal request/response shapes -----

interface RawCreateDatabaseRequest {
  duration: string;
  handle?: string;
  name?: string;
  description?: string;
  region?: string;
  pgVersion?: number;
}

interface RawDatabaseResponse {
  id: string;
  handle: string | null;
  name: string | null;
  description: string | null;
  status: string;
  region: string;
  pgVersion: number;
  duration: string;
  connectionUri: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Break a Postgres connection URI into its parts. `connectionString` is always
 * preserved (it is the value you pass to a client); the parsed components are a
 * convenience. If the URI can't be parsed, only `connectionString` is returned.
 */
function parseConnectionUri(uri: string): DatabaseConnection {
  try {
    const u = new URL(uri);
    return {
      connectionString: uri,
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      databaseName: u.pathname.replace(/^\//, ""),
      sslmode: u.searchParams.get("sslmode") ?? undefined,
    };
  } catch {
    return { connectionString: uri };
  }
}

function mapDatabase(raw: RawDatabaseResponse): Database {
  return {
    id: raw.id,
    handle: raw.handle,
    name: raw.name,
    description: raw.description,
    status: raw.status as DatabaseStatus,
    region: raw.region,
    pgVersion: raw.pgVersion,
    duration: raw.duration,
    connection:
      raw.connectionUri == null ? null : parseConnectionUri(raw.connectionUri),
    expiresAt: raw.expiresAt,
    createdAt: raw.createdAt,
  };
}

// ----- Capability operations -----

/**
 * Provision a new Postgres database. `duration` is required. Returns the database
 * with connection credentials in `connection`. Failed requests throw
 * {@link DatabaseHttpError}.
 */
export async function create(
  input: CreateDatabaseInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Database> {
  if (!input.duration) {
    throw new DatabaseHttpError("duration is required", 400, {
      message: "duration is required",
    });
  }

  const body: RawCreateDatabaseRequest = { duration: input.duration };
  if (input.handle !== undefined) body.handle = input.handle;
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.region !== undefined) body.region = input.region;
  if (input.pgVersion !== undefined) body.pgVersion = input.pgVersion;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/databases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to create database",
  );
  return mapDatabase((await res.json()) as RawDatabaseResponse);
}

/** Retrieve a database by its id or handle. */
export async function get(
  idOrHandle: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Database> {
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/databases/${encodeURIComponent(idOrHandle)}`,
    ),
    `Failed to get database '${idOrHandle}'`,
  );
  return mapDatabase((await res.json()) as RawDatabaseResponse);
}

/**
 * Delete a database by its id or handle. Exported as `delete`:
 * `import { database } from "@sapiom/tools"; await database.delete(id)`.
 */
async function deleteDatabase(
  idOrHandle: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const res = await transport.fetch(
    `${baseUrl}/v1/databases/${encodeURIComponent(idOrHandle)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    throw new DatabaseHttpError(
      `Failed to delete database '${idOrHandle}': ${res.status} ${text}`,
      res.status,
      parsed,
    );
  }
}

export { deleteDatabase as delete };
