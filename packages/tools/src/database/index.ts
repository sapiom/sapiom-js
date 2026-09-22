/**
 * `database` capability — provision a Postgres database, retrieve it, and delete
 * it. You get back direct connection credentials, so you can connect with any
 * standard Postgres client or driver.
 *
 * A Sapiom Postgres is permanent: it lives until you delete it. There is no
 * lifetime to pick. What it costs is a slot of your plan's database limit
 * (`database.count`), held from `create` until `delete`.
 *
 *   import { database } from "@sapiom/tools";              // ambient auth
 *   const db = await database.create({ handle: "analytics" });
 *   db.connection?.connectionString;                      // a ready-to-use Postgres URI
 *
 *   const again = await database.get(db.id);              // or get("analytics") by handle
 *   const all = await database.list();                    // every database you own (read-only)
 *   await database.delete(db.id);                         // or delete("analytics") — frees the slot
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

/**
 * The values `create` used to require as `duration`, kept so existing callers
 * still compile. The platform stopped reading them in SAP-3100.
 *
 * @deprecated A Sapiom Postgres has no lifetime. Omit `duration`.
 */
export const DATABASE_DURATIONS = ["15m", "1h", "4h", "24h", "7d"] as const;

/** @deprecated See {@link DATABASE_DURATIONS}. */
export type DatabaseDuration = (typeof DATABASE_DURATIONS)[number];

/**
 * Lifecycle state of a database. `"active"` ends only through `delete`.
 * `"expired"` is kept for databases created before SAP-3100 and is never
 * emitted for a new database: a Sapiom Postgres does not expire.
 */
export type DatabaseStatus =
  | "provisioning"
  | "active"
  | "expired"
  | "deleting"
  | "deleted";

export interface CreateDatabaseInput {
  /**
   * Ignored. A Sapiom Postgres lives until you delete it; the platform no longer
   * reads a lifetime and this client does not send one.
   *
   * @deprecated A Sapiom Postgres has no lifetime. Omit `duration`.
   */
  duration?: DatabaseDuration;
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
  /**
   * The lifetime tier a database was created with, only for databases created
   * before SAP-3100. Absent for newer databases: a Sapiom Postgres has no lifetime.
   *
   * @deprecated Never set for databases created after SAP-3100.
   */
  duration?: DatabaseDuration | string;
  /** Connection credentials — `null` while the database is still being provisioned. */
  connection: DatabaseConnection | null;
  /**
   * Absent (or `null`) for every database created after SAP-3100: a Sapiom
   * Postgres lives until you delete it. Older databases may still carry the
   * ISO-8601 timestamp they were created with; nothing enforces it.
   *
   * @deprecated Never set for databases created after SAP-3100.
   */
  expiresAt?: string | null;
  /** ISO-8601 timestamp when the database was created. */
  createdAt: string;
}

// ----- Internal request/response shapes -----

interface RawCreateDatabaseRequest {
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
  /** Legacy; absent for databases created after SAP-3100. */
  duration?: string;
  connectionUri: string | null;
  /** Legacy; absent for databases created after SAP-3100. */
  expiresAt?: string | null;
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
    // Legacy fields: only echoed when the gateway still returns them (databases
    // created before SAP-3100). A new database has neither.
    ...(raw.duration !== undefined ? { duration: raw.duration } : {}),
    connection:
      raw.connectionUri == null ? null : parseConnectionUri(raw.connectionUri),
    ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {}),
    createdAt: raw.createdAt,
  };
}

// ----- Capability operations -----

/**
 * Provision a new Postgres database. Every field is optional:
 * `database.create({})` works. Returns the database with connection credentials
 * in `connection`. Failed requests throw {@link DatabaseHttpError}.
 *
 * The database is permanent. It holds one slot of your plan's database limit
 * from this call until `delete`, so reuse a `handle` you already own
 * (`get(handle)` first, or `list()`) rather than creating a fresh database per
 * run. A legacy `duration` is accepted for source compatibility and dropped
 * rather than forwarded: the platform ignores it.
 */
export async function create(
  input: CreateDatabaseInput = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Database> {
  const body: RawCreateDatabaseRequest = {};
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
 * List your active and provisioning databases, each with connection credentials.
 * Read-only — it never creates, mutates, or removes anything. Useful for
 * discovering a handle you (or another of your workflows) already provisioned
 * before deciding whether to reuse it. Failed requests throw
 * {@link DatabaseHttpError}.
 */
export async function list(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Database[]> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/databases`),
    "Failed to list databases",
  );
  const raw = (await res.json()) as RawDatabaseResponse[];
  return Array.isArray(raw) ? raw.map(mapDatabase) : [];
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
