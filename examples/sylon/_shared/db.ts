/**
 * The shared Sylon database: one Sapiom Postgres addressed by the handle `sylon`.
 *
 * `Db` is the narrow surface `issues.ts` and `config.ts` need (parameterized query + transaction),
 * so the same SQL runs against the real database when deployed and against pg-mem in unit tests
 * and `run_local` (where `ctx.sapiom.database` is a stub whose DSN connects to nothing).
 */
import { randomUUID } from "node:crypto";

import type { AgentExecutionContext } from "@sapiom/agent";

import { MIGRATIONS } from "./migrations/index";

export const DB_HANDLE = "sylon";

export type Row = Record<string, unknown>;

export interface Db {
  readonly kind: "postgres" | "memory";
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` in one transaction; a throw rolls it back. Nested calls reuse the outer transaction. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

/** What `openDb` needs from a step context. */
export type DbCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "sapiom" | "isLocalTrace" | "logger"
>;

/** Postgres `unique_violation`. pg-mem raises the same code. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

// --- postgres.js -----------------------------------------------------------------------------

type PgSql = import("postgres").Sql;
type PgTx = import("postgres").TransactionSql;

function wrapPostgres(sql: PgSql | PgTx, inTx: boolean): Db {
  return {
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      // `unsafe` is the parameterized-text API; values are still bound server-side, never spliced.
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      if (inTx) return fn(this);
      return (await (sql as PgSql).begin((tx) =>
        fn(wrapPostgres(tx, true)),
      )) as R;
    },
  };
}

export async function connectPostgres(
  connectionString: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(connectionString, {
    max: 2,
    idle_timeout: 20,
    onnotice: () => {},
  });
  return { db: wrapPostgres(sql, false), close: () => sql.end({ timeout: 5 }) };
}

// --- pg-mem ----------------------------------------------------------------------------------

type MemDb = import("pg-mem").IMemoryDb;

function wrapMemory(
  mem: MemDb,
  run: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>,
  inTx = false,
): Db {
  return {
    kind: "memory",
    async query<T>(text: string, params: unknown[] = []) {
      return (await run(text, params)).rows as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      if (inTx) return fn(this);
      // pg-mem's pg adapter accepts begin/rollback but does not undo writes; a snapshot does.
      // Memory dbs serve one process, so snapshot-and-restore is a faithful transaction.
      const snapshot = mem.backup();
      try {
        return await fn(wrapMemory(mem, run, true));
      } catch (err) {
        snapshot.restore();
        throw err;
      }
    },
  };
}

/** A fresh, migrated, in-process database. pg-mem is loaded lazily so a deployed run never pays for it. */
export async function memoryDb(): Promise<Db> {
  const { newDb, DataType } = await import("pg-mem");
  const mem = newDb();
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = wrapMemory(mem, (t, p) => pool.query(t, p));
  await migrate(db);
  return db;
}

// --- migrations ------------------------------------------------------------------------------

/** Apply every migration not yet recorded in `schema_migrations`. Safe to call from every run. */
export async function migrate(db: Db): Promise<string[]> {
  if (db.kind === "postgres") {
    await db.query(
      "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
    );
  } else {
    // pg-mem rejects `if not exists` on an existing table; a memory db is migrated once, at birth.
    await db.query(
      "create table schema_migrations (id text primary key, applied_at timestamptz not null default now())",
    );
  }
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    const did = await db.transaction(async (tx) => {
      // Two agents cold-starting at once would both try 001; the advisory lock serializes them.
      if (tx.kind === "postgres")
        await tx.query(
          "select pg_advisory_xact_lock(hashtext('sylon.migrations'))",
        );
      const seen = await tx.query(
        "select 1 from schema_migrations where id = $1",
        [m.id],
      );
      if (seen.length > 0) return false;
      for (const stmt of splitStatements(m.sql)) await tx.query(stmt);
      await tx.query("insert into schema_migrations (id) values ($1)", [m.id]);
      return true;
    });
    if (did) applied.push(m.id);
  }
  return applied;
}

/** One statement per call (pg-mem requires it; extended-protocol Postgres does too). Our migrations have no semicolons inside strings. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- opening the fleet database from a step --------------------------------------------------

let localDb: Promise<Db> | undefined;

/** Resolve the `sylon` handle to a connection string, creating the database on first use. */
export async function resolveConnectionString(
  ctx: Pick<DbCtx, "sapiom">,
): Promise<string> {
  const database = ctx.sapiom.database;
  const found = await database
    .get(DB_HANDLE)
    .catch(() => database.create({ handle: DB_HANDLE }));
  const connectionString = found.connection?.connectionString;
  if (!connectionString)
    throw new Error(
      `database '${DB_HANDLE}' is still provisioning (no connection yet); retry`,
    );
  return connectionString;
}

/**
 * Run `fn` against the fleet database, migrated, and close the connection afterwards.
 *
 * On a local trace the database is an in-process pg-mem shared by every step of the trace, so a
 * `run_local` walks the real SQL without touching the deployed database.
 */
export async function withDb<R>(
  ctx: DbCtx,
  fn: (db: Db) => Promise<R>,
): Promise<R> {
  if (ctx.isLocalTrace) {
    localDb ??= memoryDb().then(async (db) => {
      // Imported lazily: seed.ts depends on config.ts and issues.ts, which depend on this file.
      const { seedFleet } = await import("./seed");
      await seedFleet(db, "run_local");
      return db;
    });
    return fn(await localDb);
  }
  const { db, close } = await connectPostgres(
    await resolveConnectionString(ctx),
  );
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await close();
  }
}

/** Test hook: install (or drop) the database `withDb` uses on a local trace. */
export function setLocalDb(db: Db | undefined): void {
  localDb = db ? Promise.resolve(db) : undefined;
}
