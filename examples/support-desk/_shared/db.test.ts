import { describe, expect, it } from "vitest";

import {
  memoryDb,
  resolveConnectionString,
  ensureMigrated,
  resetSharedDb,
  withDb,
  type Db,
} from "./db";

describe("db", () => {
  it("creates every M1 table", async () => {
    const db = await memoryDb();
    for (const table of [
      "accounts",
      "issues",
      "messages",
      "drafts",
      "nudges",
      "runs",
      "events_log",
      "config",
    ]) {
      await expect(
        db.query(`select count(*) from ${table}`),
      ).resolves.toHaveLength(1);
    }
  });

  it("records the applied migrations", async () => {
    const db = await memoryDb();
    expect(
      await db.query("select id from schema_migrations order by id"),
    ).toEqual([
      { id: "001_init" },
      { id: "020_copilot" },
      { id: "050_linear_url" },
      { id: "060_watchdog" },
      { id: "061_linear_sync" },
      { id: "062_escalation_generation" },
      { id: "063_watchdog_alerted" },
      { id: "070_knowledge" },
      { id: "080_desks" },
      { id: "081_desk_triage_unique" },
      { id: "082_issue_triage_channel" },
      { id: "090_digests" },
      { id: "100_linear_state" },
      { id: "101_draft_summary" },
      { id: "102_watchdog_event" },
    ]);
  });

  it("keeps a standalone write made during a transaction that rolls back", async () => {
    const db = await memoryDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (t) => {
      await t.query(
        "insert into accounts (name, slack_channel_id) values ('in-tx', 'C1')",
      );
      await gate;
      throw new Error("rollback");
    });
    const standalone = db.query(
      "insert into accounts (name, slack_channel_id) values ('outside', 'C2')",
    );
    release();
    await expect(tx).rejects.toThrow("rollback");
    await standalone;
    expect(await db.query("select name from accounts")).toEqual([
      { name: "outside" },
    ]);
  });

  it("rolls a transaction back on throw", async () => {
    const db = await memoryDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "insert into accounts (name, slack_channel_id) values ('a', 'C1')",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select * from accounts")).toEqual([]);
  });
});

describe("resolveConnectionString", () => {
  const conn = { connection: { connectionString: "postgresql://x" } };
  const ctxWith = (
    get: () => Promise<unknown>,
    create: () => Promise<unknown>,
  ) => ({ sapiom: { database: { get, create } } }) as never;

  it("creates the database only when the handle is missing (404)", async () => {
    let created = 0;
    const missing = Object.assign(new Error("not found"), { status: 404 });
    await expect(
      resolveConnectionString(
        ctxWith(
          () => Promise.reject(missing),
          async () => (created++, conn),
        ),
      ),
    ).resolves.toBe("postgresql://x");
    expect(created).toBe(1);
  });

  it("surfaces any other failure without provisioning", async () => {
    let created = 0;
    const outage = Object.assign(new Error("bad gateway"), { status: 502 });
    await expect(
      resolveConnectionString(
        ctxWith(
          () => Promise.reject(outage),
          async () => (created++, conn),
        ),
      ),
    ).rejects.toThrow("bad gateway");
    expect(created).toBe(0);
  });
});

describe("ensureMigrated", () => {
  const counting = (db: Db) => {
    const seen: string[] = [];
    const wrapped: Db = {
      ...db,
      query: (text: string, params?: unknown[]) => {
        seen.push(text);
        return db.query(text, params as never);
      },
    } as Db;
    return { wrapped, seen };
  };

  it("costs one query when every migration is recorded", async () => {
    const { wrapped, seen } = counting(await memoryDb());
    expect(await ensureMigrated(wrapped)).toEqual([]);
    expect(seen).toEqual(["select id from schema_migrations"]);
  });

  it("takes the full migration path when schema_migrations is missing", async () => {
    const seen: string[] = [];
    const stub = {
      kind: "postgres",
      query: async (text: string) => {
        seen.push(text);
        if (text === "select id from schema_migrations")
          throw Object.assign(
            new Error('relation "schema_migrations" does not exist'),
            { code: "42P01" },
          );
        if (text.startsWith("select 1 from schema_migrations")) return [{}];
        return [];
      },
      transaction: async <R>(fn: (tx: Db) => Promise<R>) => fn(stub),
    } as unknown as Db;
    expect(await ensureMigrated(stub)).toEqual([]);
    expect(seen[1]).toMatch(/^create table if not exists schema_migrations/);
  });
});

describe("withDb on a deployed step", () => {
  const conn = { connection: { connectionString: "postgresql://x" } };

  /** A step context whose database lookup is counted; isLocalTrace false takes the shared pool. */
  const deployedCtx = (lookups: { n: number }) =>
    ({
      isLocalTrace: false,
      executionId: "exec-1",
      sapiom: {
        database: {
          get: async () => {
            lookups.n++;
            return conn;
          },
          create: async () => conn,
        },
      },
    }) as never;

  it("shares one connection across concurrent calls and migrates once", async () => {
    const lookups = { n: 0 };
    let connects = 0;
    const db = await memoryDb();
    const queries: string[] = [];
    await resetSharedDb(async () => {
      connects++;
      const counted = {
        ...db,
        query: (text: string, params?: unknown[]) => {
          queries.push(text);
          return db.query(text, params as never);
        },
      } as Db;
      return { db: counted, close: async () => {} };
    });
    const ctx = deployedCtx(lookups);
    const results = await Promise.all([
      withDb(ctx, async (d) => d.query("select 1 as one")),
      withDb(ctx, async (d) => d.query("select 1 as one")),
      withDb(ctx, async (d) => d.query("select 1 as one")),
    ]);
    expect(results).toHaveLength(3);
    expect(lookups.n).toBe(1);
    expect(connects).toBe(1);
    expect(
      queries.filter((q) => q === "select id from schema_migrations"),
    ).toHaveLength(1);
    await resetSharedDb();
  });

  it("does not cache a failed connect: the next call connects again", async () => {
    const lookups = { n: 0 };
    let attempts = 0;
    const db = await memoryDb();
    await resetSharedDb(async () => {
      attempts++;
      if (attempts === 1) throw new Error("connect ECONNRESET");
      return { db, close: async () => {} };
    });
    const ctx = deployedCtx(lookups);
    await expect(withDb(ctx, async () => "x")).rejects.toThrow("ECONNRESET");
    expect(await withDb(ctx, async () => "ok")).toBe("ok");
    expect(attempts).toBe(2);
    await resetSharedDb();
  });
});
