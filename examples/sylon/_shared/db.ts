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
  /**
   * Run `fn` in one transaction; a throw rolls it back. Nested calls reuse the outer transaction.
   * Inside `fn`, query through `tx` only: on a memory db the outer `db` waits for this transaction.
   */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  /**
   * Run `fn` only if no other caller holds the named lock; `held: false` means someone does and
   * `fn` was not called. Unlike a transaction it does not roll `fn`'s writes back when it throws.
   */
  tryLock<R>(
    name: string,
    fn: () => Promise<R>,
  ): Promise<{ held: true; value: R } | { held: false }>;
}

/** What `openDb` needs from a step context. */
export type DbCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "sapiom" | "isLocalTrace" | "logger" | "executionId"
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
    async tryLock<R>(name: string, fn: () => Promise<R>) {
      if (inTx) throw new Error("tryLock cannot run inside a transaction");
      // A session advisory lock lives on one connection, so reserve it for the lock's lifetime.
      const conn = await (sql as PgSql).reserve();
      try {
        const [row] = await conn.unsafe(
          "select pg_try_advisory_lock(hashtext($1)) as ok",
          [name],
        );
        if (!row?.ok) return { held: false as const };
        try {
          return { held: true as const, value: await fn() };
        } finally {
          await conn.unsafe("select pg_advisory_unlock(hashtext($1))", [name]);
        }
      } finally {
        conn.release();
      }
    },
  };
}

export async function connectPostgres(
  connectionString: string,
  opts: { idleTimeoutSec?: number } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(connectionString, {
    max: 2,
    idle_timeout: opts.idleTimeoutSec ?? 20,
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
  lock: { tail: Promise<unknown> } = { tail: Promise.resolve() },
  held: Set<string> = new Set(),
): Db {
  return {
    kind: "memory",
    async tryLock<R>(name: string, fn: () => Promise<R>) {
      if (held.has(name)) return { held: false as const };
      held.add(name);
      try {
        return { held: true as const, value: await fn() };
      } finally {
        held.delete(name);
      }
    },
    async query<T>(text: string, params: unknown[] = []) {
      // Outside a transaction, wait for any open one, so a standalone write can neither interleave
      // with it nor be undone by its rollback snapshot.
      if (!inTx) await lock.tail;
      return (await run(text, params)).rows as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      if (inTx) return fn(this);
      // pg-mem has no row locks and its pg adapter accepts begin/rollback without undoing writes.
      // Running one transaction at a time, with a snapshot to restore on throw, gives the
      // serializable behaviour `for update` callers rely on in Postgres.
      const turn = lock.tail.then(async () => {
        const snapshot = mem.backup();
        try {
          return await fn(wrapMemory(mem, run, true, lock, held));
        } catch (err) {
          snapshot.restore();
          throw err;
        }
      });
      lock.tail = turn.catch(() => undefined);
      return turn;
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

/**
 * Migrate only when something is missing. One query when the database is current, which is every
 * step after setup has run; the locked per-migration path below runs only for a missing id.
 */
export async function ensureMigrated(db: Db): Promise<string[]> {
  try {
    const rows = await db.query<{ id: string }>(
      "select id from schema_migrations",
    );
    const have = new Set(rows.map((r) => r.id));
    if (MIGRATIONS.every((m) => have.has(m.id))) return [];
  } catch (err) {
    // Only a missing table (Postgres 42P01, a fresh database) means "not migrated"; a timeout or a
    // permission error is reported as itself rather than replaced by a migration attempt.
    if ((err as { code?: unknown })?.code !== "42P01") throw err;
  }
  return migrate(db);
}

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

/** Local-trace databases, one per execution: steps of one trace share it, separate traces never do. */
const localDbs = new Map<string, Promise<Db>>();
/** A long-lived host (the authoring MCP server) runs many traces; keep only the most recent. */
const MAX_LOCAL_DBS = 16;
let localOverride: Promise<Db> | undefined;

/** A fresh in-process database seeded from fleet.json, as a local trace sees it. */
export async function localFleetDb(): Promise<Db> {
  const db = await memoryDb();
  // Imported lazily: seed.ts depends on config.ts and issues.ts, which depend on this file.
  const { seedFleet } = await import("./seed");
  await seedFleet(db, "run_local");
  return db;
}

/** Resolve the `sylon` handle to a connection string, creating the database only when it does not exist. */
export async function resolveConnectionString(
  ctx: Pick<DbCtx, "sapiom">,
): Promise<string> {
  const database = ctx.sapiom.database;
  const found = await database.get(DB_HANDLE).catch((err: unknown) => {
    // Only a missing handle provisions; an outage or a permission error must surface as itself.
    if ((err as { status?: unknown })?.status === 404) {
      return database.create({ handle: DB_HANDLE });
    }
    throw err;
  });
  const connectionString = found.connection?.connectionString;
  if (!connectionString)
    throw new Error(
      `database '${DB_HANDLE}' is still provisioning (no connection yet); retry`,
    );
  return connectionString;
}

/**
 * Run `fn` against the fleet database, migrated. Deployed, every call in one step process shares a
 * pool that stays open until it has idled for {@link STEP_IDLE_TIMEOUT_SEC} seconds.
 *
 * On a local trace the database is an in-process pg-mem, one per execution, so a `run_local`
 * walks the real SQL without touching the deployed database and without seeing earlier traces.
 */
export async function withDb<R>(
  ctx: DbCtx,
  fn: (db: Db) => Promise<R>,
): Promise<R> {
  if (ctx.isLocalTrace) {
    if (localOverride) return fn(await localOverride);
    let db = localDbs.get(ctx.executionId);
    if (!db) {
      localDbs.set(ctx.executionId, (db = localFleetDb()));
      // Map iteration is insertion order, so the first key is the oldest trace.
      if (localDbs.size > MAX_LOCAL_DBS)
        localDbs.delete(localDbs.keys().next().value as string);
    }
    return fn(await db);
  }
  return fn(await sharedDb(ctx));
}

/**
 * Seconds an idle pooled connection stays open. Each step is its own process, which reports its
 * completion over HTTP rather than by exiting, so a short timeout lets a finished step's process
 * exit soon without making a later call in the same step reconnect.
 */
const STEP_IDLE_TIMEOUT_SEC = 2;

interface SharedConnection {
  conn: Promise<{ db: Db; close: () => Promise<void> }>;
  migrated?: Promise<unknown>;
}

let shared: SharedConnection | undefined;
let connector: typeof connectPostgres = connectPostgres;

/**
 * One connection pool per step process, migrated once. Each `withDb` used to resolve the handle,
 * open a TLS connection and re-check every migration in its own locked transaction (~35 round
 * trips), and a step can call `withDb` several times; that cost ~3.5 s a step on deployed runs.
 * A failed connect or migration is not cached, so the next call retries.
 */
async function sharedDb(ctx: DbCtx): Promise<Db> {
  if (!shared) {
    const entry: SharedConnection = {
      conn: resolveConnectionString(ctx).then((cs) =>
        connector(cs, { idleTimeoutSec: STEP_IDLE_TIMEOUT_SEC }),
      ),
    };
    entry.conn.catch(() => {
      if (shared === entry) shared = undefined;
    });
    shared = entry;
  }
  const entry = shared;
  const { db } = await entry.conn;
  if (!entry.migrated) {
    entry.migrated = ensureMigrated(db);
    entry.migrated.catch(() => {
      entry.migrated = undefined;
    });
  }
  await entry.migrated;
  return db;
}

/**
 * Test hook: close and forget the process-wide pool, and optionally swap how it connects (pass
 * nothing to restore {@link connectPostgres}).
 */
export async function resetSharedDb(
  connect: typeof connectPostgres = connectPostgres,
): Promise<void> {
  const entry = shared;
  shared = undefined;
  connector = connect;
  if (entry) await entry.conn.then((c) => c.close()).catch(() => {});
}

/**
 * Test hook: make every local trace use `db` (so a test can follow one issue across two agents'
 * executions), or pass `undefined` to return to one fresh database per execution.
 */
export function setLocalDb(db: Db | undefined): void {
  localOverride = db ? Promise.resolve(db) : undefined;
  localDbs.clear();
}
